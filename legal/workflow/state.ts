import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readSource } from "../extensions/internal/sources-core.ts";
import {
	type CaseDraft,
	type CaseFact,
	type CaseIssue,
	type CaseLaw,
	type CaseScope,
	type CaseState,
	type CaseStrategy,
	type CaseTask,
	type CaseUpdate,
	type DraftInput,
	type SourceRef,
	STAGE_LABELS,
	STAGES,
	type Stage,
} from "./types.ts";

export type { CaseState, CaseUpdate, DraftInput, SourceRef, Stage } from "./types.ts";
export { STAGE_LABELS, STAGES, WORKFLOW_TOOLS } from "./types.ts";

const MAX_ENTRIES = 80;
const MAX_REFS = 12;
const MAX_SUMMARY = 2500;
const MAX_STATE_BYTES = 1024 * 1024;
const SCOPE_FIELDS = ["objective", "jurisdiction", "procedure", "legalAsOf"] as const;
const STRATEGY_FIELDS = ["primary", "alternative", "risks", "conditions"] as const;

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象。`);
	const result = value as Record<string, unknown>;
	if (Object.keys(result).some((key) => !keys.includes(key))) throw new Error(`${label} 包含不支持的字段。`);
	return result;
}

function text(value: unknown, label: string, max = 1200, required = false): string {
	if (value === undefined && !required) return "";
	if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
		throw new Error(`${label} 必须是${required ? "非空" : ""}字符串，最多 ${max} 字。`);
	}
	return value.trim();
}

function id(value: unknown, label: string, maximum = 60): string {
	const result = text(value, label, maximum, true);
	if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new Error(`${label} 仅允许字母、数字、下划线和连字符。`);
	return result;
}

function list<T>(value: unknown, label: string, parse: (item: unknown) => T, maximum = MAX_ENTRIES): T[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} 必须是最多 ${maximum} 项的数组。`);
	return value.map(parse);
}

function texts(value: unknown, label: string): string[] {
	return list(value, label, (item) => text(item, label, 600, true), 20);
}

function refs(value: unknown): SourceRef[] {
	return list(
		value,
		"refs",
		(item) => {
			const entry = record(item, "引用", ["source_id", "start_line", "end_line", "text_sha256"]);
			const start = entry.start_line;
			const end = entry.end_line;
			if (
				typeof start !== "number" ||
				typeof end !== "number" ||
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 1 ||
				end < start ||
				end - start >= 200
			) {
				throw new Error("引用须为递增正整数物理行号，单段最多 200 行。");
			}
			const result: SourceRef = {
				source_id: id(entry.source_id, "source_id", 80),
				start_line: start,
				end_line: end,
			};
			if (entry.text_sha256 !== undefined) {
				const hash = text(entry.text_sha256, "引用文本哈希", 64, true);
				if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("引用文本哈希格式错误。");
				result.text_sha256 = hash;
			}
			return result;
		},
		MAX_REFS,
	);
}

function parseFact(value: unknown): CaseFact {
	const entry = record(value, "事实", ["id", "kind", "text", "refs", "note"]);
	if (entry.kind !== "recorded" && entry.kind !== "party_claim" && entry.kind !== "inference")
		throw new Error("事实 kind 须为 recorded、party_claim 或 inference。");
	const result: CaseFact = {
		id: id(entry.id, "事实 id"),
		kind: entry.kind,
		text: text(entry.text, "事实 text", 1200, true),
		refs: refs(entry.refs),
		note: text(entry.note, "事实 note"),
	};
	if (result.kind === "recorded" && result.refs.length === 0)
		throw new Error("卷内记载 recorded 必须有材料引用，不可将用户陈述编为原卷。");
	if (result.kind === "recorded" && result.refs.some((ref) => ref.source_id.startsWith("K_")))
		throw new Error("外部知识库K_引用不是本案证据，不能登记为卷内记载recorded事实。");
	if (result.kind !== "recorded" && !result.note)
		throw new Error("当事人陈述或推论必须用 note 说明是谁的说法或推论依据及局限。");
	return result;
}

function parseIssue(value: unknown): CaseIssue {
	const entry = record(value, "争点", ["id", "question", "forFacts", "againstFacts", "gaps", "analysis"]);
	return {
		id: id(entry.id, "争点 id"),
		question: text(entry.question, "争点 question", 1200, true),
		forFacts: list(entry.forFacts, "forFacts", (item) => id(item, "事实 id"), 20),
		againstFacts: list(entry.againstFacts, "againstFacts", (item) => id(item, "事实 id"), 20),
		gaps: texts(entry.gaps, "gaps"),
		analysis: text(entry.analysis, "争点 analysis", 2000),
	};
}

function parseLaw(value: unknown): CaseLaw {
	const entry = record(value, "法律依据", ["id", "title", "version", "status", "refs", "note"]);
	if (entry.status !== "pending" && entry.status !== "provided")
		throw new Error("法律依据 status 须为 pending（待核）或 provided（材料已提供，非现行效力证明）。");
	const result: CaseLaw = {
		id: id(entry.id, "依据 id"),
		title: text(entry.title, "依据 title", 300, true),
		version: text(entry.version, "依据 version", 300),
		status: entry.status,
		refs: refs(entry.refs),
		note: text(entry.note, "依据 note", 1200, true),
	};
	if (result.status === "provided" && (result.refs.length === 0 || !result.version))
		throw new Error("provided 依据须填写材料引用和版本；未知版本应保留 pending。");
	return result;
}

function parseTask(value: unknown): CaseTask {
	const entry = record(value, "任务", ["id", "title", "status", "note"]);
	if (entry.status !== "open" && entry.status !== "done") throw new Error("任务 status 须为 open 或 done。");
	const result: CaseTask = {
		id: id(entry.id, "任务 id"),
		title: text(entry.title, "任务 title", 600, true),
		status: entry.status,
		note: text(entry.note, "任务 note"),
	};
	if (result.status === "done" && !result.note) throw new Error("完成任务须在 note 记录处理结果，不可仅改状态。");
	return result;
}

function parseScope(value: unknown): CaseScope {
	const entry = record(value, "scope", SCOPE_FIELDS);
	return {
		objective: text(entry.objective, "objective", 600),
		jurisdiction: text(entry.jurisdiction, "jurisdiction", 200),
		procedure: text(entry.procedure, "procedure", 200),
		legalAsOf: text(entry.legalAsOf, "legalAsOf", 200),
	};
}

function parseStrategy(value: unknown): CaseStrategy {
	const entry = record(value, "strategy", STRATEGY_FIELDS);
	return {
		primary: text(entry.primary, "primary", 2000),
		alternative: text(entry.alternative, "alternative", 1500),
		risks: text(entry.risks, "risks", 1500),
		conditions: text(entry.conditions, "conditions", 1500),
	};
}

function checkFilename(value: unknown): string {
	const filename = text(value, "filename", 100, true);
	if (
		!/^[\p{L}\p{N}_-][\p{L}\p{N} _.-]*\.md$/u.test(filename) ||
		/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(filename)
	) {
		throw new Error("草稿 filename 必须是普通 .md 文件名，不允许目录、绝对路径、特殊设备名或越界字符。");
	}
	return filename;
}

function parseDraft(value: unknown): CaseDraft {
	const entry = record(value, "草稿登记", [
		"filename",
		"title",
		"path",
		"sha256",
		"savedAt",
		"refs",
		"unresolved",
		"reviewStatus",
	]);
	const filename = checkFilename(entry.filename);
	if (entry.path !== `outputs/legalagent/${filename}` || entry.reviewStatus !== "awaiting_professional_review")
		throw new Error("草稿仅可登记固定输出路径且保持待专业审阅。");
	const hash = text(entry.sha256, "草稿哈希", 64, true);
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("草稿哈希格式错误。");
	return {
		filename,
		title: text(entry.title, "草稿 title", 200, true),
		path: entry.path,
		sha256: hash,
		savedAt: text(entry.savedAt, "savedAt", 100, true),
		refs: refs(entry.refs),
		unresolved: texts(entry.unresolved, "unresolved"),
		reviewStatus: "awaiting_professional_review",
	};
}

function emptyState(): CaseState {
	return {
		version: 1,
		revision: 0,
		stage: "intake",
		updatedAt: null,
		scope: parseScope({}),
		facts: [],
		issues: [],
		laws: [],
		tasks: [],
		strategy: parseStrategy({}),
		drafts: [],
		sourceWarnings: [],
	};
}

function parseState(value: unknown): CaseState {
	const entry = record(value, "案件状态", [
		"version",
		"revision",
		"stage",
		"updatedAt",
		"scope",
		"facts",
		"issues",
		"laws",
		"tasks",
		"strategy",
		"drafts",
		"sourceWarnings",
	]);
	if (
		entry.version !== 1 ||
		typeof entry.revision !== "number" ||
		!Number.isSafeInteger(entry.revision) ||
		entry.revision < 0 ||
		!STAGES.includes(entry.stage as Stage)
	)
		throw new Error("案件状态版本、revision 或 stage 错误，拒绝按空案件覆盖。");
	const state: CaseState = {
		version: 1,
		revision: entry.revision,
		stage: entry.stage as Stage,
		updatedAt: entry.updatedAt === null ? null : text(entry.updatedAt, "updatedAt", 100, true),
		scope: parseScope(entry.scope),
		facts: list(entry.facts, "facts", parseFact),
		issues: list(entry.issues, "issues", parseIssue),
		laws: list(entry.laws, "laws", parseLaw),
		tasks: list(entry.tasks, "tasks", parseTask),
		strategy: parseStrategy(entry.strategy),
		drafts: list(entry.drafts, "drafts", parseDraft),
		sourceWarnings: [],
	};
	for (const section of [state.facts, state.issues, state.laws, state.tasks]) {
		const ids = section.map((item) => item.id);
		if (new Set(ids).size !== ids.length) throw new Error("案件状态存在重复实体 id。");
	}
	if (new Set(state.drafts.map((draft) => draft.filename.toLowerCase())).size !== state.drafts.length)
		throw new Error("案件状态存在重复草稿文件名。");
	const factIds = new Set(state.facts.map((fact) => fact.id));
	for (const issue of state.issues) {
		if ([...issue.forFacts, ...issue.againstFacts].some((factId) => !factIds.has(factId)))
			throw new Error(`争点 ${issue.id} 引用了不存在的事实 id。`);
	}
	return state;
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Resolve only fixed subdirectories beneath the real case; reject links and junctions. */
function fixedDirectory(cwd: string, parts: readonly string[], create = false): string {
	const root = realpathSync.native(cwd);
	if (!statSync(root).isDirectory()) throw new Error("案件目录不是目录。");
	let current = root;
	for (const part of parts) {
		current = join(current, part);
		try {
			const entry = lstatSync(current);
			if (entry.isSymbolicLink() || !entry.isDirectory() || realpathSync.native(current) !== current)
				throw new Error("工作流目录含符号链接、junction 或非目录项，拒绝读写。");
		} catch (error) {
			if (!missing(error)) throw error;
			if (create) {
				mkdirSync(current);
				const entry = lstatSync(current);
				if (entry.isSymbolicLink() || realpathSync.native(current) !== current)
					throw new Error("工作流目录创建后发生路径变化。");
			}
		}
	}
	return current;
}

function regularFile(path: string): boolean {
	try {
		const entry = lstatSync(path);
		if (entry.isSymbolicLink() || !entry.isFile() || realpathSync.native(path) !== path)
			throw new Error("工作流文件含链接或不是普通文件，拒绝访问。");
		return true;
	} catch (error) {
		if (missing(error)) return false;
		throw error;
	}
}

function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function currentDrafts(state: CaseState): CaseDraft[] {
	const latest = new Map<string, CaseDraft>();
	for (const draft of state.drafts) latest.set(draft.title, draft);
	return [...latest.values()];
}

function allRefs(state: CaseState): SourceRef[] {
	return [...state.facts, ...state.laws, ...currentDrafts(state)].flatMap((item) => item.refs);
}

function excerptHash(cwd: string, ref: SourceRef): string {
	const excerpt = readSource(cwd, ref.source_id, ref.start_line, ref.end_line);
	if (excerpt.lines.length !== ref.end_line - ref.start_line + 1)
		throw new Error(`来源 ${ref.source_id} 的结束行超出当前材料。`);
	return hash(JSON.stringify(excerpt.lines));
}

function checkRefs(cwd: string, state: CaseState, stamp = false): string[] {
	const warnings: string[] = [];
	for (const ref of allRefs(state)) {
		try {
			const current = excerptHash(cwd, ref);
			if (ref.text_sha256 && ref.text_sha256 !== current)
				throw new Error("引用段落已变更，须重新读取并更新该实体引用。");
			if (stamp) ref.text_sha256 = current;
		} catch (error) {
			const warning = `${ref.source_id}:${ref.start_line}-${ref.end_line}：${error instanceof Error ? error.message : String(error)}`;
			if (!warnings.includes(warning)) warnings.push(warning);
		}
	}
	return warnings;
}

/** No write side effects. Existing references are rechecked against the current manifest/text. */
export function readCaseState(cwd: string): CaseState {
	const directory = fixedDirectory(cwd, [".legalagent", "workflow"]);
	const path = join(directory, "state.json");
	if (!regularFile(path)) return emptyState();
	if (statSync(path).size > MAX_STATE_BYTES) throw new Error("案件状态超过 1 MB，拒绝加载。");
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("案件状态不是有效 JSON；请修复原文件，不能以新案件静默覆盖。");
	}
	const state = parseState(value);
	state.sourceWarnings = checkRefs(cwd, state);
	return state;
}

function persist(directory: string, state: CaseState): void {
	const destination = join(directory, "state.json");
	regularFile(destination);
	const temporary = join(directory, `state-${randomUUID()}.tmp`);
	const contents = `${JSON.stringify(state, null, 2)}\n`;
	if (Buffer.byteLength(contents) > MAX_STATE_BYTES) throw new Error("案件状态超过 1 MB；请缩短工作笔记。");
	try {
		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(descriptor, contents, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		regularFile(destination);
		renameSync(temporary, destination);
	} finally {
		if (regularFile(temporary)) unlinkSync(temporary);
	}
}

function transact(
	cwd: string,
	expectedRevision: number,
	mutate: (state: CaseState) => CaseState,
	requireValidRefs = true,
): CaseState {
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
		throw new Error("expected_revision 必须是非负整数。");
	const directory = fixedDirectory(cwd, [".legalagent", "workflow"], true);
	const lock = join(directory, "transaction.lock");
	let descriptor: number;
	try {
		descriptor = openSync(lock, "wx", 0o600);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST")
			throw new Error("案件状态正在更新，或存在中断事务锁；请重读状态后重试。确认无运行事务后才可人工清理锁。");
		throw error;
	}
	try {
		const current = readCaseState(cwd);
		if (current.revision !== expectedRevision)
			throw new Error(
				`revision 冲突：期望 ${expectedRevision}，当前 ${current.revision}。先调用 legal_case_status 后合并更新。`,
			);
		const next = parseState(mutate(current));
		const warnings = checkRefs(cwd, next, true);
		if (warnings.length && requireValidRefs) throw new Error(`材料引用失效，更新未保存：${warnings.join("；")}`);
		next.sourceWarnings = warnings;
		next.revision = current.revision + 1;
		next.updatedAt = new Date().toISOString();
		persist(directory, next);
		return next;
	} finally {
		closeSync(descriptor);
		unlinkSync(lock);
	}
}

function upsert<T extends { id: string }>(items: T[], data: unknown, parse: (value: unknown) => T): T[] {
	const updates = Array.isArray(data) ? list(data, "更新实体", parse, 10) : [parse(data)];
	if (updates.length === 0) throw new Error("更新实体不能为空。");
	const result = [...items];
	for (const item of updates) {
		const index = result.findIndex((existing) => existing.id === item.id);
		if (index < 0) result.push(item);
		else result[index] = item;
	}
	if (result.length > MAX_ENTRIES) throw new Error(`每类最多 ${MAX_ENTRIES} 条简明工作笔记。`);
	return result;
}

export function updateCaseState(cwd: string, expectedRevision: number, update: CaseUpdate): CaseState {
	return transact(
		cwd,
		expectedRevision,
		(state) => {
			if (update.section === "facts" || update.section === "laws") {
				const data = Array.isArray(update.data) ? update.data : [update.data];
				const proposed = emptyState();
				if (update.section === "facts") proposed.facts = list(data, "更新事实", parseFact, 10);
				else proposed.laws = list(data, "更新依据", parseLaw, 10);
				const warnings = checkRefs(cwd, proposed);
				if (warnings.length) throw new Error(`新引用失效，更新未保存：${warnings.join("；")}`);
			}
			switch (update.section) {
				case "scope":
					state.scope = parseScope({ ...state.scope, ...record(update.data, "scope 更新", SCOPE_FIELDS) });
					break;
				case "facts":
					state.facts = upsert(state.facts, update.data, parseFact);
					break;
				case "issues":
					state.issues = upsert(state.issues, update.data, parseIssue);
					break;
				case "laws":
					state.laws = upsert(state.laws, update.data, parseLaw);
					break;
				case "tasks":
					state.tasks = upsert(state.tasks, update.data, parseTask);
					break;
				case "strategy":
					state.strategy = parseStrategy({
						...state.strategy,
						...record(update.data, "strategy 更新", STRATEGY_FIELDS),
					});
					break;
				default:
					throw new Error("不支持的更新 section；阶段和草稿登记只能使用专用工具。");
			}
			return state;
		},
		false,
	);
}

/** These gates check documented work products, never substantive legal correctness. */
export function stageRequirements(cwd: string, state: CaseState, target: Stage): string[] {
	const failures: string[] = [];
	const index = STAGES.indexOf(target);
	if (index >= 1 && SCOPE_FIELDS.some((key) => !state.scope[key]))
		failures.push("先记录目标、法域、程序阶段和法律适用时间；未知项明确写待核/未指定。");
	if (index >= 2) {
		if (!state.facts.length || !state.issues.length)
			failures.push("至少整理一项有类别的事实和一个含正反事实/缺口的争点。");
		if (!state.facts.some((fact) => fact.kind === "recorded") && !state.tasks.some((task) => task.status === "open"))
			failures.push("尚无卷内材料时，须保留取证/核查待办，才能进入条件分析。");
	}
	if (index >= 3) {
		if (state.issues.some((issue) => !issue.analysis)) failures.push("每个争点须记录分析或条件判断，不能只列问题。");
		if (!state.laws.length) failures.push("记录至少一项法律依据或明确的待检索依据线索。");
		if (state.laws.some((law) => law.status === "pending") && !state.tasks.some((task) => task.status === "open"))
			failures.push("依据待核时须保留核查待办，不能声称法律检索已经完成。");
	}
	if (index >= 4 && STRATEGY_FIELDS.some((key) => !state.strategy[key]))
		failures.push("方案须记录主张、备选、风险和成立条件；无备选时明确说明。");
	if (index >= 5) {
		if (!state.drafts.length) failures.push("尚无已保存的草稿产物；仅对话起草不能推进至 review。");
		for (const draft of currentDrafts(state)) {
			try {
				const directory = fixedDirectory(cwd, ["outputs", "legalagent"]);
				const path = join(directory, draft.filename);
				if (!regularFile(path) || hash(readFileSync(path)) !== draft.sha256)
					failures.push(`草稿 ${draft.filename} 不存在或内容已改变，须保存新版本。`);
			} catch (error) {
				failures.push(error instanceof Error ? error.message : String(error));
			}
		}
	}
	if (state.sourceWarnings.length)
		failures.push(...state.sourceWarnings.map((warning) => `材料引用须修复：${warning}`));
	return failures;
}

export function advanceCaseStage(cwd: string, expectedRevision: number, target: Stage): CaseState {
	if (!STAGES.includes(target)) throw new Error("未知案件阶段。");
	return transact(
		cwd,
		expectedRevision,
		(state) => {
			const current = STAGES.indexOf(state.stage);
			const next = STAGES.indexOf(target);
			if (next === current) throw new Error("已经处于该阶段，无需重复推进。");
			if (next > current + 1) throw new Error("向前推进须逐阶段检查产物；补充材料可回退至任一先前阶段。");
			if (next > current) {
				const failures = stageRequirements(cwd, state, target);
				if (failures.length) throw new Error(`阶段未推进：${failures.join("；")}`);
			}
			state.stage = target;
			return state;
		},
		false,
	);
}

/** Check recognizable work sections and nonempty bodies, not the merits of a legal argument. */
function checkDraftStructure(content: string, unresolved: string[]): void {
	const categories = [
		{ label: "事实/案情/背景与证据", pattern: /事实|案情|背景|基本情况|证据|履约情况/, minimum: 30 },
		{
			label: "分析/理由与法律依据",
			pattern: /分析|理由|法律依据|法律适用|争点|辩护意见|审查意见|量刑意见/,
			minimum: 40,
		},
		{ label: "请求/结论/建议或处理方案", pattern: /请求|结论|建议|主张|处理方案|处理意见/, minimum: 15 },
		{ label: "具体待核事项", pattern: /待核|待补|缺口|复核|待确认|提交前/, minimum: 15 },
	];
	const lines = content.split(/\r?\n/);
	const headings: { title: string; line: number }[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		const marked =
			/^(?:#{1,6}\s+|\*\*|(?:[一二三四五六七八九十百]+|\d+)[、.．]\s*|[（(](?:[一二三四五六七八九十百]+|\d+)[）)]\s*)/.exec(
				line,
			);
		const title = line
			.replace(
				/^(?:#{1,6}\s+|\*\*|(?:[一二三四五六七八九十百]+|\d+)[、.．]\s*|[（(](?:[一二三四五六七八九十百]+|\d+)[）)]\s*)/,
				"",
			)
			.replace(/\*\*\s*$/, "");
		if (
			title.length <= 100 &&
			(marked ||
				(title.length <= 40 &&
					!/[。！？；]/.test(title) &&
					categories.some((category) => category.pattern.test(title))))
		)
			headings.push({ title, line: index });
	}
	const sizes = categories.map(() => 0);
	for (let index = 0; index < headings.length; index++) {
		const heading = headings[index];
		const end = headings[index + 1]?.line ?? lines.length;
		const body = lines
			.slice(heading.line + 1, end)
			.join("\n")
			.replace(/\[(?:待补|待核)[^\]]*\]/g, "")
			.replace(/[^\p{L}\p{N}]/gu, "");
		categories.forEach((category, categoryIndex) => {
			if (category.pattern.test(heading.title)) sizes[categoryIndex] += body.length;
		});
	}
	if (unresolved.some((item) => item.trim().length >= 6)) sizes[3] = categories[3].minimum;
	const missingSections = categories
		.filter((category, index) => sizes[index] < category.minimum)
		.map((category) => category.label);
	if (missingSections.length)
		throw new Error(
			`草稿结构不完整：缺少有实质内容的${missingSections.join("、")}。使用 Markdown/中文编号/段标题组织正文；未知资料可明确给出条件分析，待核事项不能只写“待核”。`,
		);
}

export function saveCaseDraft(cwd: string, expectedRevision: number, input: DraftInput): CaseState {
	const filename = checkFilename(input.filename);
	const title = text(input.title, "title", 200, true);
	const content = text(input.content, "content", 20_000, true);
	if (content.length < 40) throw new Error("草稿正文过短；保存实际正文，不能只写标题或一句生成说明。");
	const references = refs(input.refs);
	const unresolved = texts(input.unresolved, "unresolved");
	let created: string | undefined;
	try {
		return transact(cwd, expectedRevision, (state) => {
			if (state.stage !== "draft" && state.stage !== "review")
				throw new Error("先完成范围、证据、分析和方案阶段，再保存草稿。");
			const requiredState = { ...state, drafts: [] };
			requiredState.sourceWarnings = checkRefs(cwd, requiredState);
			const failures = stageRequirements(cwd, requiredState, "draft");
			if (failures.length) throw new Error(`草稿未保存：${failures.join("；")}`);
			if (state.facts.some((fact) => fact.kind === "recorded") && !references.length)
				throw new Error("已有卷内事实时，草稿须列明所用材料引用。");
			if (
				(!state.facts.some((fact) => fact.kind === "recorded") ||
					state.laws.some((law) => law.status === "pending") ||
					state.issues.some((issue) => issue.gaps.length > 0)) &&
				!unresolved.length
			)
				throw new Error("材料/依据有缺口时须在 unresolved 列明待核项；允许保存条件草稿。");
			checkDraftStructure(content, unresolved);
			const draft: CaseDraft = {
				filename,
				title,
				path: `outputs/legalagent/${filename}`,
				sha256: "",
				savedAt: new Date().toISOString(),
				refs: references,
				unresolved,
				reviewStatus: "awaiting_professional_review",
			};
			const draftState = { ...state, drafts: [...state.drafts, draft] };
			const warnings = checkRefs(cwd, draftState, true);
			if (warnings.length) throw new Error(`草稿引用错误：${warnings.join("；")}`);
			const directory = fixedDirectory(cwd, ["outputs", "legalagent"], true);
			const path = join(directory, filename);
			if (regularFile(path) || state.drafts.some((item) => item.filename.toLowerCase() === filename.toLowerCase()))
				throw new Error("草稿已存在，拒绝覆盖；请用新版本文件名。");
			const footer = [
				"",
				"---",
				"状态：待专业人员审阅。此状态不代表事实已获法院认定、法律效力已核查或文书可提交。",
				"",
				"材料定位（仅证明引用可定位）：",
				...references.map((ref) => `- ${ref.source_id}，物理行 ${ref.start_line}–${ref.end_line}`),
				"",
				"提交前待核：",
				...(unresolved.length ? unresolved : ["仍需专业人员复核事实、适用法律、期限和提交要求。"]).map(
					(item) => `- ${item}`,
				),
				"",
			].join("\n");
			const body = `${content}\n${footer}`;
			const descriptor = openSync(path, "wx", 0o600);
			created = path;
			try {
				writeFileSync(descriptor, body, "utf8");
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
			draft.sha256 = hash(body);
			state.drafts.push(draft);
			state.stage = "draft";
			return state;
		});
	} catch (error) {
		if (created && regularFile(created)) unlinkSync(created);
		throw error;
	}
}

function brief(value: string, maximum: number): string {
	const flat = value.replace(/\s+/g, " ");
	return flat.length > maximum ? `${flat.slice(0, maximum - 1)}…` : flat;
}

function refSummary(references: SourceRef[]): string {
	return (
		references
			.slice(0, 2)
			.map((ref) => `${ref.source_id}:${ref.start_line}-${ref.end_line}`)
			.join(",") || "无材料引用"
	);
}

/** Bounded checkpoint for repeated injection; the status tool can page individual sections. */
export function summarizeCaseState(state: CaseState): string {
	const sections = [
		`法律案件工作记录：revision ${state.revision}；${state.stage}（${STAGE_LABELS[state.stage]}）。记录是工作笔记，不是法律证明或可提交认证。`,
		`范围：目标=${brief(state.scope.objective || "未记录", 100)}；法域=${brief(state.scope.jurisdiction || "待核", 60)}；程序=${brief(state.scope.procedure || "待核", 60)}；法律适用时间=${brief(state.scope.legalAsOf || "未指定，未核现行效力", 60)}。`,
		`事实 ${state.facts.length} 项（recorded=卷内记载，party_claim=当事人陈述，inference=推论）：\n${
			state.facts
				.slice(0, 4)
				.map(
					(fact) =>
						`${fact.id}/${fact.kind} ${brief(fact.text, 65)} [${refSummary(fact.refs)}] ${brief(fact.note, 30)}`,
				)
				.join("\n") || "未整理"
		}`,
		`争点 ${state.issues.length} 项：\n${
			state.issues
				.slice(0, 4)
				.map(
					(issue) =>
						`${issue.id} ${brief(issue.question, 45)}；正=${issue.forFacts.join(",") || "未见"}；反=${issue.againstFacts.join(",") || "未见"}；分析=${brief(issue.analysis || "待分析", 55)}；缺=${brief(issue.gaps.join("；") || "未记录缺口", 45)}`,
				)
				.join("\n") || "未整理"
		}`,
		`依据 ${state.laws.length} 项（provided 仅为已提供文本，不表示现行效力已核查）：\n${
			state.laws
				.slice(0, 3)
				.map(
					(law) =>
						`${law.id} ${brief(law.title, 40)} /${brief(law.version || "版本待核", 25)}/${law.status} [${refSummary(law.refs)}] ${brief(law.note, 45)}`,
				)
				.join("\n") || "未记录"
		}`,
		`待办：${
			state.tasks
				.filter((task) => task.status === "open")
				.slice(0, 4)
				.map((task) => `${task.id} ${brief(task.title, 45)}`)
				.join("；") || "未记录未完成任务"
		}；共 ${state.tasks.length} 项。`,
		`方案：主=${brief(state.strategy.primary || "未形成", 100)}；备=${brief(state.strategy.alternative || "未形成", 90)}；风险=${brief(state.strategy.risks || "未形成", 90)}；条件=${brief(state.strategy.conditions || "未形成", 90)}。`,
		`草稿 ${state.drafts.length} 份（同标题最新版本为当前产物，旧版仅历史记录），均待专业审阅：${
			currentDrafts(state)
				.slice(-3)
				.map((draft) => `${brief(draft.path, 65)}；待核=${brief(draft.unresolved.join("；") || "专业复核", 45)}`)
				.join("；") || "尚未保存"
		}。`,
		...(state.sourceWarnings.length ? [`当前引用警告：${brief(state.sourceWarnings.join("；"), 220)}`] : []),
		"摘要只列部分条目，完整实体通过 legal_case_status 按 section/offset 读取；先读 revision，逐实体更新。任何阶段仍须核查原件真实性和法律判断。",
	];
	const budgets = [140, 230, 330, 430, 260, 170, 320, 250];
	const summary = sections
		.map((section, index) => {
			const budget = budgets[index] ?? 180;
			return section.length > budget ? `${section.slice(0, budget - 16)}…（更多见状态工具）` : section;
		})
		.join("\n\n");
	return summary.length > MAX_SUMMARY
		? `${summary.slice(0, MAX_SUMMARY - 22)}\n（摘要已截断，请读状态工具）`
		: summary;
}

export function buildCaseCheckpoint(cwd: string): string {
	return summarizeCaseState(readCaseState(cwd));
}
