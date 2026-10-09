import { createHash } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const MAX_RETRIEVAL_CHARS = 3500;
export const MAX_HIT_CHARS = 600;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const METADATA_FIELDS = [
	"title",
	"source_url",
	"publisher",
	"document_type",
	"jurisdiction",
	"version",
	"published_on",
	"effective_from",
	"effective_to",
	"status",
	"checked_on",
	"article",
	"case_number",
	"provenance",
] as const;

export type KnowledgeMetadata = Partial<Record<(typeof METADATA_FIELDS)[number], string>>;
export interface KnowledgeDocument {
	document_id: string;
	text: string;
	metadata: KnowledgeMetadata;
}
export interface KnowledgeIndex {
	fingerprint: string;
	as_of: string;
}
export interface KnowledgeSnapshot extends KnowledgeDocument {
	version: 1;
	index_fingerprint: string;
	index_as_of: string;
}
export interface RetrievalQuery {
	corpus: "case" | "knowledge";
	query: string;
	limit: number;
	mode?: "current" | "date" | "historical";
	as_of?: string;
	jurisdiction?: string;
}
export interface KnowledgeResponse {
	scope: KnowledgeScope;
	index: KnowledgeIndex;
	retrieval_mode: string;
	documents: KnowledgeDocument[];
	warnings: string[];
	trace: { reference_guard: boolean; evidence_status: string | null };
}
export interface KnowledgeScope {
	mode: string;
	as_of: string | null;
	jurisdiction: string | null;
	requested_mode: string;
	normative_only: boolean;
	local_only: boolean;
	requested_publication_after_snapshot: boolean;
}
export interface RetrievalLine {
	line: number;
	ref: string;
	text: string;
}
export interface RetrievalExcerpt {
	start_line: number;
	end_line: number;
	start_ref: string;
	end_ref: string;
	start_column: number;
	end_column: number;
	text: string;
	truncated: boolean;
	score: number;
}

/** Only a local HTTP service root is accepted; credentials, paths and redirects are never configuration. */
export function resolveKnowledgeEndpoint(value: string | undefined): string | undefined {
	const candidate = value?.trim();
	if (!candidate) return undefined;
	const invalid = () =>
		new Error(
			"LEGAL_RAG_URL须为本机http服务根URL，仅允许localhost、127.0.0.1或[::1]及可选端口，不含路径、凭据、query或hash。",
		);
	if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/?$/i.test(candidate)) throw invalid();
	try {
		return new URL(candidate).origin;
	} catch {
		throw invalid();
	}
}

export function readKnowledgeEndpoint(): string | undefined {
	return resolveKnowledgeEndpoint(process.env.LEGAL_RAG_URL);
}

export function getKnowledgeServiceUrl(route: "search" | "health"): string | undefined {
	const endpoint = readKnowledgeEndpoint();
	return endpoint ? `${endpoint}/${route}` : undefined;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}须为对象。`);
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maximum: number, allowEmpty = false): string {
	if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim()) || value.includes("\0"))
		throw new Error(`${label}须为${allowEmpty ? "" : "非空"}字符串，最多${maximum}字符。`);
	return value;
}

function metadata(value: unknown): KnowledgeMetadata {
	const input = object(value, "知识库metadata");
	if (Object.keys(input).some((field) => !METADATA_FIELDS.includes(field as (typeof METADATA_FIELDS)[number])))
		throw new Error("知识库metadata包含未约定字段。");
	const output: KnowledgeMetadata = {};
	for (const field of METADATA_FIELDS) {
		if (input[field] !== undefined) output[field] = string(input[field], `metadata.${field}`, 1000, true);
	}
	return output;
}

function document(value: unknown): KnowledgeDocument {
	const input = object(value, "知识库文档");
	return {
		document_id: string(input.document_id, "document_id", 200),
		text: string(input.text, "知识库原文", 50_000),
		metadata: metadata(input.metadata),
	};
}

function snapshot(value: unknown): KnowledgeSnapshot {
	const input = object(value, "知识库快照");
	if (
		input.version !== 1 ||
		Object.keys(input).some(
			(key) => !["version", "document_id", "text", "metadata", "index_fingerprint", "index_as_of"].includes(key),
		)
	)
		throw new Error("知识库快照版本或字段错误。");
	return {
		version: 1,
		...document(input),
		index_fingerprint: string(input.index_fingerprint, "index_fingerprint", 200),
		index_as_of: string(input.index_as_of, "index_as_of", 100, true),
	};
}

function snapshotId(value: KnowledgeSnapshot): string {
	return `K_${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function isKnowledgeSourceId(value: string): boolean {
	return value.startsWith("K_");
}

function snapshotDirectory(cwd: string, create = false): string {
	let current = realpathSync.native(cwd);
	if (!statSync(current).isDirectory()) throw new Error("案件目录不是目录。");
	for (const name of [".legalagent", "rag", "sources"]) {
		current = join(current, name);
		try {
			const entry = lstatSync(current);
			if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync.native(current) !== current)
				throw new Error("RAG缓存目录含链接、junction或非目录，拒绝访问。");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			if (!create) throw new Error("当前案件没有该知识库缓存。");
			mkdirSync(current);
			if (realpathSync.native(current) !== current || lstatSync(current).isSymbolicLink())
				throw new Error("RAG缓存目录创建后发生路径变化。");
		}
	}
	return current;
}

export function readKnowledgeSnapshot(cwd: string, sourceId: string): KnowledgeSnapshot {
	if (!/^K_[a-f0-9]{64}$/.test(sourceId)) throw new Error("知识库source id须为K_加64位内容哈希。");
	const path = join(snapshotDirectory(cwd), `${sourceId}.json`);
	const entry = lstatSync(path);
	if (
		!entry.isFile() ||
		entry.isSymbolicLink() ||
		realpathSync.native(path) !== path ||
		entry.size > MAX_RESPONSE_BYTES
	)
		throw new Error("知识库缓存不是受控普通文件，或超过大小上限。");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("知识库缓存不是有效JSON。");
	}
	const result = snapshot(parsed);
	if (snapshotId(result) !== sourceId) throw new Error("知识库缓存内容哈希不匹配，引用已失效。");
	return result;
}

export function saveKnowledgeSnapshot(cwd: string, value: KnowledgeDocument, index: KnowledgeIndex): string {
	const content = snapshot({ version: 1, ...value, index_fingerprint: index.fingerprint, index_as_of: index.as_of });
	const sourceId = snapshotId(content);
	const path = join(snapshotDirectory(cwd, true), `${sourceId}.json`);
	let descriptor: number;
	try {
		descriptor = openSync(path, "wx", 0o600);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") {
			readKnowledgeSnapshot(cwd, sourceId);
			return sourceId;
		}
		throw error;
	}
	try {
		writeFileSync(descriptor, `${JSON.stringify(content)}\n`, "utf8");
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	readKnowledgeSnapshot(cwd, sourceId);
	return sourceId;
}

export function knowledgeLines(text: string): RetrievalLine[] {
	const lines = text.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	return lines.map((text, index) => ({ line: index + 1, ref: `p0001:L${String(index + 1).padStart(4, "0")}`, text }));
}

export function queryTerms(query: string): string[] {
	const terms = new Set<string>();
	for (const term of query.toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
		terms.add(term);
		if (/\p{Script=Han}/u.test(term) && term.length > 4)
			for (let index = 0; index < term.length - 1; index++) terms.add(term.slice(index, index + 2));
	}
	return [...terms].slice(0, 80);
}

/** A metadata preview is not a rewritten authoritative title, version, or URL. */
export function metadataPreview(value: KnowledgeMetadata): {
	metadata: KnowledgeMetadata;
	metadata_preview_truncated: boolean;
} {
	const output: KnowledgeMetadata = {};
	let truncated = false;
	for (const field of METADATA_FIELDS) {
		const original = value[field];
		if (original === undefined) continue;
		const maximum = field === "source_url" ? 160 : 80;
		output[field] = original.slice(0, maximum);
		if (output[field] !== original) truncated = true;
	}
	while (JSON.stringify(output).length > 900) {
		const longest = METADATA_FIELDS.filter((field) => output[field]).sort(
			(left, right) => (output[right]?.length ?? 0) - (output[left]?.length ?? 0),
		)[0];
		if (!longest) break;
		output[longest] = output[longest]?.slice(0, Math.floor((output[longest]?.length ?? 0) / 2));
		truncated = true;
	}
	return { metadata: output, metadata_preview_truncated: truncated };
}

/** Snippets preserve the real physical line and label; truncation never creates a new line or locator. */
export function relevantExcerpt(lines: RetrievalLine[], query: string): RetrievalExcerpt | undefined {
	if (!lines.length) return undefined;
	const terms = queryTerms(query);
	const scored = lines
		.map((line, index) => ({
			index,
			score: terms.reduce(
				(score, term) => score + (line.text.toLowerCase().includes(term) ? Math.min(term.length, 8) : 0),
				0,
			),
		}))
		.sort((left, right) => right.score - left.score || left.index - right.index);
	const best = scored[0];
	if (!best.score) return undefined;
	let start = best.index;
	let end = best.index;
	// Complete adjacent article/paragraph lines when they fit, before considering partial long lines.
	while (
		end + 1 < lines.length &&
		end - start < 199 &&
		lines
			.slice(start, end + 2)
			.map((line) => `[${line.ref}] ${line.text}`)
			.join("\n").length <= MAX_HIT_CHARS
	)
		end++;
	if (
		start > 0 &&
		end - start < 199 &&
		lines
			.slice(start - 1, end + 1)
			.map((line) => `[${line.ref}] ${line.text}`)
			.join("\n").length <= MAX_HIT_CHARS
	)
		start--;
	const original = lines
		.slice(start, end + 1)
		.map((line) => `[${line.ref}] ${line.text}`)
		.join("\n");
	let column = 0;
	let text = original;
	let endColumn = lines[end].text.length;
	if (start === end && original.length > MAX_HIT_CHARS) {
		const match = terms
			.filter((term) => lines[start].text.toLowerCase().includes(term))
			.sort((left, right) => right.length - left.length)[0];
		column = Math.max(0, lines[start].text.toLowerCase().indexOf(match ?? "") - 80);
		const prefix = `[${lines[start].ref}]（原行第${column + 1}列起）`;
		const shown = lines[start].text.slice(column, column + MAX_HIT_CHARS - prefix.length);
		text = prefix + shown;
		endColumn = column + shown.length;
	}
	return {
		start_line: lines[start].line,
		end_line: lines[end].line,
		start_ref: lines[start].ref,
		end_ref: lines[end].ref,
		start_column: column + 1,
		end_column: endColumn,
		text,
		truncated: original.length > MAX_HIT_CHARS,
		score: best.score,
	};
}

export async function searchKnowledge(input: RetrievalQuery, signal?: AbortSignal): Promise<KnowledgeResponse> {
	const endpoint = getKnowledgeServiceUrl("search");
	if (!endpoint) throw new Error("外部知识检索未配置：请设置LEGAL_RAG_URL为本机检索服务根URL。");
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("知识库检索超时。")), 20_000);
	try {
		const request = {
			query: input.query,
			limit: input.limit,
			...(input.mode !== undefined ? { mode: input.mode } : {}),
			...(input.as_of !== undefined ? { as_of: input.as_of } : {}),
			...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction } : {}),
		};
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
			signal: controller.signal,
			redirect: "error",
		});
		if (!response.ok) throw new Error(`知识库检索服务返回HTTP ${response.status}。`);
		if (!response.body) throw new Error("知识库检索服务未返回内容。");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("知识库回包超过2MB，拒绝接收。");
			}
			chunks.push(chunk.value);
		}
		const parsed = object(JSON.parse(Buffer.concat(chunks).toString("utf8")), "知识库回包");
		const index = object(parsed.index, "知识库index");
		const scope = object(parsed.scope, "知识库scope");
		const trace = object(parsed.trace, "知识库trace");
		if (typeof trace.reference_guard !== "boolean") throw new Error("trace.reference_guard须为boolean。");
		const evidenceStatus =
			trace.evidence_status === null ? null : string(trace.evidence_status, "trace.evidence_status", 120);
		if (evidenceStatus !== null && !/^[a-z][a-z0-9_]*$/.test(evidenceStatus))
			throw new Error("trace.evidence_status须为受控状态标识，不能包含自由文本。");
		for (const field of ["normative_only", "local_only", "requested_publication_after_snapshot"])
			if (typeof scope[field] !== "boolean") throw new Error(`scope.${field}须为boolean。`);
		if (
			!Array.isArray(parsed.documents) ||
			parsed.documents.length > input.limit ||
			!Array.isArray(parsed.warnings) ||
			parsed.warnings.length > 20
		)
			throw new Error("知识库回包documents或warnings无效。");
		return {
			scope: {
				mode: string(scope.mode, "scope.mode", 30),
				as_of: scope.as_of === null ? null : string(scope.as_of, "scope.as_of", 10),
				jurisdiction: scope.jurisdiction === null ? null : string(scope.jurisdiction, "scope.jurisdiction", 80),
				requested_mode: string(scope.requested_mode, "scope.requested_mode", 30),
				normative_only: scope.normative_only as boolean,
				local_only: scope.local_only as boolean,
				requested_publication_after_snapshot: scope.requested_publication_after_snapshot as boolean,
			},
			index: {
				fingerprint: string(index.fingerprint, "index.fingerprint", 200),
				as_of: string(index.as_of, "index.as_of", 100, true),
			},
			retrieval_mode: string(parsed.retrieval_mode, "retrieval_mode", 100),
			documents: parsed.documents.map(document),
			warnings: parsed.warnings.map((value) => string(value, "warning", 1000)),
			trace: { reference_guard: trace.reference_guard, evidence_status: evidenceStatus },
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}
