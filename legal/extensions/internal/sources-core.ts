import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isKnowledgeSourceId, type KnowledgeMetadata, knowledgeLines, readKnowledgeSnapshot } from "./rag-core.ts";

export interface LegalSource {
	id: string;
	original_path: string;
	processed_path: string;
	sha256: string;
	kind: string;
	bytes?: number;
	page_count?: number;
	page_numbering?: "physical_pdf" | "synthetic_p0001";
	line_count?: number;
	ocr_status?: "not_performed" | "not_applicable";
	pages_without_extractable_text?: number[];
	warnings?: string[];
	origin?: "case" | "knowledge";
	knowledge_metadata?: KnowledgeMetadata;
	index_fingerprint?: string;
	index_as_of?: string;
}

export interface SourceLine {
	line: number;
	ref: string;
	text: string;
}

export interface QuoteLocation {
	start_ref: string;
	end_ref: string;
	start_line: number;
	end_line: number;
	start_column: number;
	end_column: number;
}

const MAX_READ_LINES = 200;
const MAX_QUOTE_LENGTH = 4000;
const MAX_LOCATIONS = 20;
const LINE_PREFIX = /^\[(p\d{4,}:L\d{4,})\] ?/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith("..\\") && !path.startsWith("../") && path !== ".." && !isAbsolute(path));
}

function sourceDirectory(cwd: string): string {
	return resolve(cwd, ".legalagent", "sources");
}

export function loadSources(cwd: string): LegalSource[] {
	const manifestPath = join(sourceDirectory(cwd), "manifest.json");
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			throw new Error(`案件来源清单不存在：${manifestPath}`);
		}
		throw new Error(`无法读取案件来源清单：${manifestPath}（${String(error)}）`);
	}
	if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.sources)) {
		throw new Error("案件来源清单格式错误：需要 {version:1,sources:[...]}。");
	}
	const ids = new Set<string>();
	return data.sources.map((entry: unknown, index: number) => {
		if (
			!isRecord(entry) ||
			typeof entry.id !== "string" ||
			entry.id.trim() === "" ||
			typeof entry.original_path !== "string" ||
			typeof entry.processed_path !== "string" ||
			typeof entry.sha256 !== "string" ||
			typeof entry.kind !== "string"
		) {
			throw new Error(`案件来源清单第 ${index + 1} 项格式错误。`);
		}
		if (ids.has(entry.id)) throw new Error(`案件来源清单中存在重复的 source id：${entry.id}`);
		if (isKnowledgeSourceId(entry.id)) throw new Error("案件来源清单不能占用知识库保留的K_命名空间。");
		ids.add(entry.id);
		const source: LegalSource = {
			id: entry.id,
			original_path: entry.original_path,
			processed_path: entry.processed_path,
			sha256: entry.sha256,
			kind: entry.kind,
		};
		for (const key of ["bytes", "page_count", "line_count"] as const) {
			const value = entry[key];
			if (value === undefined) continue;
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
				throw new Error(`来源 ${entry.id} 的 ${key} 必须是非负整数。`);
			}
			source[key] = value;
		}
		if (entry.page_numbering !== undefined) {
			if (entry.page_numbering !== "physical_pdf" && entry.page_numbering !== "synthetic_p0001") {
				throw new Error(`来源 ${entry.id} 的 page_numbering 无效。`);
			}
			source.page_numbering = entry.page_numbering;
		}
		if (entry.ocr_status !== undefined) {
			if (entry.ocr_status !== "not_performed" && entry.ocr_status !== "not_applicable") {
				throw new Error(`来源 ${entry.id} 的 ocr_status 无效。`);
			}
			source.ocr_status = entry.ocr_status;
		}
		if (entry.pages_without_extractable_text !== undefined) {
			const pages = entry.pages_without_extractable_text;
			if (!Array.isArray(pages) || pages.some((page) => !Number.isSafeInteger(page) || page < 1)) {
				throw new Error(`来源 ${entry.id} 的 pages_without_extractable_text 必须是正整数数组。`);
			}
			source.pages_without_extractable_text = pages;
		}
		if (entry.warnings !== undefined) {
			if (!Array.isArray(entry.warnings) || entry.warnings.some((warning) => typeof warning !== "string")) {
				throw new Error(`来源 ${entry.id} 的 warnings 必须是字符串数组。`);
			}
			source.warnings = entry.warnings;
		}
		return source;
	});
}

export function loadSourceLines(cwd: string, sourceId: string): { source: LegalSource; lines: SourceLine[] } {
	if (isKnowledgeSourceId(sourceId)) {
		const snapshot = readKnowledgeSnapshot(cwd, sourceId);
		const lines = knowledgeLines(snapshot.text);
		return {
			source: {
				id: sourceId,
				origin: "knowledge",
				kind: "knowledge_snapshot",
				original_path: `../rag/sources/${sourceId}.json`,
				processed_path: `../rag/sources/${sourceId}.json`,
				sha256: sourceId.slice(2),
				bytes: Buffer.byteLength(snapshot.text),
				page_count: 1,
				page_numbering: "synthetic_p0001",
				line_count: lines.length,
				ocr_status: "not_applicable",
				knowledge_metadata: snapshot.metadata,
				index_fingerprint: snapshot.index_fingerprint,
				index_as_of: snapshot.index_as_of,
				warnings: [
					"此来源为外部知识库检索缓存，不是本案证据原件；虚拟页行仅定位缓存原文。元数据与入库核查截至时间不代表实时效力认证，须结合本案法域和适用时间复核。",
				],
			},
			lines,
		};
	}
	const source = loadSources(cwd).find((entry) => entry.id === sourceId);
	if (!source) throw new Error(`未找到 source id：${sourceId}`);
	const sourcePath = source.processed_path;
	if (
		!sourcePath ||
		isAbsolute(sourcePath) ||
		/^[a-zA-Z]:/.test(sourcePath) ||
		sourcePath.startsWith("\\\\") ||
		sourcePath.includes("\0")
	) {
		throw new Error(`来源 ${sourceId} 的 processed_path 必须是清单目录内的相对路径。`);
	}
	const root = realpathSync(sourceDirectory(cwd));
	const candidate = resolve(root, sourcePath);
	if (!isWithin(root, candidate)) throw new Error(`来源 ${sourceId} 的 processed_path 越过了清单目录。`);
	let actual: string;
	try {
		actual = realpathSync(candidate);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT")
			throw new Error(`来源 ${sourceId} 的处理文件不存在：${sourcePath}`);
		throw error;
	}
	if (!isWithin(root, actual)) throw new Error(`来源 ${sourceId} 的处理文件越过了清单目录。`);
	if (!statSync(actual).isFile()) throw new Error(`来源 ${sourceId} 的处理路径不是文件：${sourcePath}`);
	const contents = readFileSync(actual, "utf8");
	const rawLines = contents.split(/\r?\n/);
	if (rawLines.at(-1) === "") rawLines.pop();
	const lines = rawLines.map((rawLine, index) => {
		const match = LINE_PREFIX.exec(rawLine);
		if (!match) throw new Error(`来源 ${sourceId} 的第 ${index + 1} 行缺少 [p0001:L0001] 引用标签。`);
		return { line: index + 1, ref: match[1], text: rawLine.slice(match[0].length) };
	});
	return { source, lines };
}

export function readSource(
	cwd: string,
	sourceId: string,
	startLine: number,
	endLine: number,
): {
	source_id: string;
	source: LegalSource;
	total_lines: number;
	lines: SourceLine[];
} {
	if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
		throw new Error("行范围无效：start_line 和 end_line 必须是递增的正整数。");
	}
	if (endLine - startLine + 1 > MAX_READ_LINES) throw new Error(`单次最多读取 ${MAX_READ_LINES} 行。`);
	const { source, lines } = loadSourceLines(cwd, sourceId);
	if (startLine > lines.length) throw new Error(`起始行 ${startLine} 超出来源总行数 ${lines.length}。`);
	return { source_id: sourceId, source, total_lines: lines.length, lines: lines.slice(startLine - 1, endLine) };
}

export function verifyQuote(
	cwd: string,
	sourceId: string,
	quote: string,
): {
	source_id: string;
	found: boolean;
	count: number;
	locations: QuoteLocation[];
	truncated: boolean;
} {
	if (!quote || quote.length > MAX_QUOTE_LENGTH) {
		throw new Error(`quote 必须包含 1 至 ${MAX_QUOTE_LENGTH} 个字符。`);
	}
	const { lines } = loadSourceLines(cwd, sourceId);
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.text.length + 1;
	}
	const text = lines.map((line) => line.text).join("\n");
	const locate = (position: number): { line: SourceLine; column: number } => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (starts[middle] <= position) low = middle;
			else high = middle - 1;
		}
		return { line: lines[low], column: position - starts[low] + 1 };
	};
	const locations: QuoteLocation[] = [];
	let count = 0;
	let from = 0;
	while (true) {
		const index = text.indexOf(quote, from);
		if (index === -1) break;
		count++;
		if (locations.length < MAX_LOCATIONS) {
			const start = locate(index);
			const end = locate(index + quote.length - 1);
			locations.push({
				start_ref: start.line.ref,
				end_ref: end.line.ref,
				start_line: start.line.line,
				end_line: end.line.line,
				start_column: start.column,
				end_column: end.column,
			});
		}
		from = index + 1;
	}
	return { source_id: sourceId, found: count > 0, count, locations, truncated: count > MAX_LOCATIONS };
}

/** Check the built-in write/edit target before execution. This prevents accidental edits to case originals. */
export function isOutputPath(cwd: string, targetPath: string): boolean {
	if (!targetPath || targetPath.includes("\0")) return false;
	const cwdPath = resolve(cwd);
	const outputsPath = resolve(cwdPath, "outputs");
	const candidate = resolve(cwdPath, targetPath);
	if (candidate === outputsPath || !isWithin(outputsPath, candidate)) return false;
	let actualCwd: string;
	try {
		actualCwd = realpathSync(cwdPath);
	} catch {
		return false;
	}
	const actualOutputs = resolve(actualCwd, "outputs");
	let current = cwdPath;
	for (const component of relative(cwdPath, candidate).split(/[\\/]/)) {
		current = join(current, component);
		try {
			const entry = lstatSync(current);
			if (entry.isSymbolicLink()) return false;
			const actual = realpathSync(current);
			if (!isWithin(actualCwd, actual)) return false;
			if (isWithin(outputsPath, current) && !isWithin(actualOutputs, actual)) return false;
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") break;
			return false;
		}
	}
	return true;
}
