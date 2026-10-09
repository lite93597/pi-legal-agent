import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type KnowledgeScope,
	knowledgeLines,
	MAX_RETRIEVAL_CHARS,
	metadataPreview,
	type RetrievalQuery,
	relevantExcerpt,
	saveKnowledgeSnapshot,
	searchKnowledge,
} from "./internal/rag-core.ts";
import { loadSourceLines, loadSources } from "./internal/sources-core.ts";

interface RetrievalHit {
	source_id: string;
	origin: "case" | "knowledge";
	start_line: number;
	end_line: number;
	start_ref: string;
	end_ref: string;
	start_column: number;
	end_column: number;
	text: string;
	preview_truncated: boolean;
	metadata: Record<string, string>;
	metadata_preview_truncated: boolean;
	score: number;
}

interface RetrievalResult {
	corpus: "case" | "knowledge";
	scope: string | KnowledgeScope;
	retrieval_mode: string;
	retrieval_status: "completed_candidates" | "completed_no_candidates" | "completed_exact_reference_gap";
	reference_guard?: boolean;
	evidence_status?: string | null;
	index?: { fingerprint: string; as_of: string };
	hits: RetrievalHit[];
	matched_documents: number;
	omitted_hits: number;
	warnings: string[];
	preview_truncated: boolean;
	instructions: string;
}

/** Bound the serialized result, including escaped metadata; no raw full-document text enters context. */
function boundedResult(result: RetrievalResult, hits: RetrievalHit[]): RetrievalResult {
	if (typeof result.scope === "string") result.scope = result.scope.slice(0, 240);
	result.warnings = result.warnings.slice(0, 4).map((warning) => warning.slice(0, 160));
	while (JSON.stringify(result).length > 1500 && result.warnings.length) result.warnings.pop();
	if (JSON.stringify(result).length > 1500 && typeof result.scope === "string")
		result.scope = result.scope.slice(0, 80);
	for (const original of hits) {
		const hit = { ...original };
		while (JSON.stringify(hit).length > 1800 && hit.text.length > 100) {
			const removed = hit.text.length - Math.floor(hit.text.length / 2);
			hit.text = hit.text.slice(0, Math.floor(hit.text.length / 2));
			if (hit.start_line === hit.end_line) hit.end_column = Math.max(hit.start_column, hit.end_column - removed);
			hit.preview_truncated = true;
		}
		const candidate = { ...result, hits: [...result.hits, hit] };
		if (JSON.stringify(candidate).length > MAX_RETRIEVAL_CHARS - 100) break;
		result.hits.push(hit);
	}
	result.omitted_hits = hits.length - result.hits.length;
	result.preview_truncated =
		result.omitted_hits > 0 || result.hits.some((hit) => hit.preview_truncated || hit.metadata_preview_truncated);
	if (JSON.stringify(result).length > MAX_RETRIEVAL_CHARS)
		throw new Error("检索结果无法在本轮输出预算内显示，请缩小检索问题。");
	return result;
}

export async function retrieveLegal(
	cwd: string,
	input: RetrievalQuery,
	signal?: AbortSignal,
): Promise<RetrievalResult> {
	if (
		!input.query.trim() ||
		input.query.length > 500 ||
		!Number.isInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 4
	)
		throw new Error("检索query须为1–500字符，limit须为1–4。");
	const result: RetrievalResult = {
		corpus: input.corpus,
		scope: "",
		retrieval_mode: "case_keywords",
		retrieval_status: "completed_no_candidates",
		hits: [],
		matched_documents: 0,
		omitted_hits: 0,
		warnings: [],
		preview_truncated: false,
		instructions:
			"命中仅是候选原文；先用legal_source_read按source_id及物理行读取，实际逐字引用再用legal_citation_verify。preview_truncated或metadata_preview_truncated为true时预览不完整。K_为外部知识库缓存，不能登记为本案recorded事实；版本、法域与效力仍须结合案件复核。",
	};
	const hits: RetrievalHit[] = [];
	if (input.corpus === "case") {
		result.scope = "只检索本案已登记处理材料；不检索外部法规或案例。";
		if (!existsSync(join(cwd, ".legalagent", "sources", "manifest.json"))) {
			result.warnings.push("本案尚无已登记材料，请先导入材料；未切换到外部知识库。");
			return result;
		}
		for (const source of loadSources(cwd)) {
			if (signal?.aborted) throw new Error("案件材料检索已停止。");
			const excerpt = relevantExcerpt(loadSourceLines(cwd, source.id).lines, input.query);
			if (!excerpt) continue;
			hits.push({
				source_id: source.id,
				origin: "case",
				...excerpt,
				preview_truncated: excerpt.truncated,
				metadata: {
					kind: source.kind,
					original_path: source.original_path.slice(0, 160),
					page_numbering: source.page_numbering ?? "未登记",
				},
				metadata_preview_truncated: source.original_path.length > 160,
			});
			for (const warning of source.warnings ?? [])
				if (!result.warnings.includes(warning)) result.warnings.push(warning);
		}
		hits.sort((left, right) => right.score - left.score);
		result.matched_documents = hits.length;
		if (hits.length) result.retrieval_status = "completed_candidates";
		if (!hits.length) result.warnings.push("本案材料未命中这些关键词；不能据此断言该事实不存在，请换词或读取原文。");
	} else if (input.corpus === "knowledge") {
		const response = await searchKnowledge(input, signal);
		result.scope = response.scope;
		result.retrieval_mode = response.retrieval_mode;
		result.index = response.index;
		result.reference_guard = response.trace.reference_guard;
		result.evidence_status = response.trace.evidence_status;
		result.warnings = [
			...response.warnings,
			"知识库的入库核查截至时间及效力元数据不是实时效力认证；缺失字段表示未登记。",
		];
		result.matched_documents = response.documents.length;
		result.retrieval_status = response.documents.length ? "completed_candidates" : "completed_no_candidates";
		if (response.trace.reference_guard && response.documents.length === 0) {
			result.retrieval_status = "completed_exact_reference_gap";
			result.instructions =
				"指定法规、条号和检索范围的结构化原文检索已经完成，本次指定范围未取得可展示的准入原文。按warnings/evidence_status说明版本未收录、法名/范围待澄清或展示拒绝等实际原因，不能把零结果一律解释为版本未收录。现在简明报告适用日期与索引截至时间、已知限制及补充权威原文或澄清范围的方向；本轮不要继续改变关键词用其他法规或案例替代所问依据。可以保留pending与核查待办，不能把其他文档登记成该条文provided，不能编造引用。零命中不证明现实中无此法条，也不代表案件法律问题已解决；请据实完成本轮文字答复。";
		}
		for (const document of response.documents) {
			if (signal?.aborted) throw new Error("知识库检索已停止，已有来源缓存保留。");
			const sourceId = saveKnowledgeSnapshot(cwd, document, response.index);
			const lines = knowledgeLines(document.text);
			// Semantic matches may contain no literal query term. Show a real opening range in that case.
			const excerpt =
				relevantExcerpt(lines, input.query) ??
				relevantExcerpt(lines, lines.find((line) => line.text.trim())?.text.slice(0, 100) ?? "");
			if (!excerpt) {
				result.warnings.push("知识库候选没有可显示的文字行，已省略预览。");
				continue;
			}
			hits.push({
				source_id: sourceId,
				origin: "knowledge",
				...excerpt,
				preview_truncated: excerpt.truncated,
				...metadataPreview(document.metadata),
			});
		}
		if (!hits.length)
			result.warnings.push("本次未取得可展示的准入原文；不代表法律依据不存在，也未使用模型记忆补成检索结果。");
	} else throw new Error("corpus须明确选择case或knowledge。");
	return boundedResult(result, hits.slice(0, input.limit));
}

export default function legalRag(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "legal_retrieve",
		label: "检索材料与法律知识",
		description:
			"case检索本案已登记文本；knowledge检索本机法律知识库，返回可复读的K_版本缓存及原文页行、版本、法域与效力提示。预览和元数据总输出有限，截断明确标示；检索不证明本案事实或法律效力，逐字引用须核验。",
		promptSnippet: "区分本案材料与外部法律知识检索，候选原文保留出处、版本及待核效力",
		executionMode: "sequential",
		parameters: Type.Object({
			corpus: Type.Union([Type.Literal("case"), Type.Literal("knowledge")]),
			query: Type.String({ minLength: 1, maxLength: 500 }),
			limit: Type.Integer({ minimum: 1, maximum: 4 }),
			mode: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("date"), Type.Literal("historical")])),
			as_of: Type.Optional(Type.String({ maxLength: 10, description: "date模式的YYYY-MM-DD适用日期" })),
			jurisdiction: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				const result = await retrieveLegal(ctx.cwd, params, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			} catch (error) {
				throw new Error(`法律检索失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});
}
