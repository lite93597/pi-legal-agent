import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_RETRIEVAL_CHARS, METADATA_FIELDS, metadataPreview } from "./internal/rag-core.ts";
import { isOutputPath, loadSources, readSource, verifyQuote } from "./internal/sources-core.ts";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "legal_sources_list",
		label: "列出案件来源",
		description:
			"列出当前案件 .legalagent/sources/manifest.json 中已登记的来源及提取质量信息，不读取原件。physical_pdf 为 PDF 物理页，synthetic_p0001 为虚拟页；缺失的质量字段表示未登记，不代表提取完整。",
		promptSnippet: "列出当前案件中可引用的来源及 source id",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const sources = loadSources(ctx.cwd);
				const result = { count: sources.length, sources };
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
			} catch (error) {
				throw new Error(`来源读取失败：${errorText(error)}`);
			}
		},
	});

	pi.registerTool({
		name: "legal_source_read",
		label: "读取案件来源",
		description:
			"按案件来源ID或K_缓存ID、物理行号读取原文，最多200行。K_显示总限3500字；按next_line/next_column续读长行，start_column仅作用首行。metadata_field可单独读完整元数据字段。虚拟页不等于原件页；截断明确标示。",
		promptSnippet: "按 source id 和行号读取有引用标签的案件来源片段",
		parameters: Type.Object({
			source_id: Type.String({ description: "案件清单source id或legal_retrieve返回的K_缓存ID" }),
			start_line: Type.Integer({ minimum: 1, description: "从 1 开始的物理起始行" }),
			end_line: Type.Integer({ minimum: 1, description: "包含在内的物理结束行" }),
			start_column: Type.Optional(Type.Integer({ minimum: 1, description: "仅K_：从首行原文第几列继续，默认1" })),
			metadata_field: Type.Optional(Type.Union(METADATA_FIELDS.map((field) => Type.Literal(field)))),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = readSource(ctx.cwd, params.source_id, params.start_line, params.end_line);
				if (result.source.origin === "knowledge") {
					const originalMetadata = result.source.knowledge_metadata ?? {};
					if (params.metadata_field) {
						const value = originalMetadata[params.metadata_field];
						const details = {
							source_id: result.source_id,
							origin: "knowledge",
							metadata_field: params.metadata_field,
							registered: value !== undefined,
							value: value ?? "未登记",
							preview_truncated: false,
						};
						const text = `来源 ${result.source_id}\n仅完整读取元数据字段 ${params.metadata_field}，本次未读取正文；字段由知识库登记，不代表效力认证。\n${value ?? "未登记"}`;
						return { content: [{ type: "text", text }], details };
					}
					const preview = metadataPreview(result.source.knowledge_metadata ?? {});
					if (originalMetadata.provenance !== undefined) preview.metadata.provenance = originalMetadata.provenance;
					const display = {
						source_id: result.source_id,
						origin: "knowledge",
						total_lines: result.total_lines,
						...preview,
						index_fingerprint: result.source.index_fingerprint,
						index_as_of: result.source.index_as_of,
						page_numbering: "synthetic_p0001",
						requested_start_line: params.start_line,
						requested_end_line: params.end_line,
						lines: [] as {
							line: number;
							ref: string;
							text: string;
							start_column: number;
							full_line_length: number;
						}[],
						preview_truncated: false,
						next_line: null as number | null,
						next_column: null as number | null,
						warning:
							"外部知识缓存不是本案证据；虚拟页仅定位缓存。入库截至与效力元数据非实时认证。截断须按next_line/next_column续读；其他元数据若截断用metadata_field逐字段读完整值。",
					};
					if (JSON.stringify(display).length > MAX_RETRIEVAL_CHARS - 900) {
						display.metadata = metadataPreview(originalMetadata).metadata;
						display.metadata_preview_truncated = true;
					}
					if (JSON.stringify(display).length > MAX_RETRIEVAL_CHARS - 900) {
						display.metadata = {};
						display.metadata_preview_truncated = true;
					}
					const firstColumn = params.start_column ?? 1;
					if (firstColumn > result.lines[0].text.length + 1) throw new Error("start_column超出首行原文。");
					for (const [index, line] of result.lines.entries()) {
						const remaining = MAX_RETRIEVAL_CHARS - JSON.stringify(display).length - 150;
						if (remaining <= 100) {
							display.preview_truncated = true;
							display.next_line = line.line;
							display.next_column = index === 0 ? firstColumn : 1;
							break;
						}
						const startColumn = index === 0 ? firstColumn : 1;
						const remainingText = line.text.slice(startColumn - 1);
						const shown = {
							...line,
							text: remainingText.slice(0, remaining),
							start_column: startColumn,
							full_line_length: line.text.length,
						};
						while (
							JSON.stringify({ ...display, lines: [...display.lines, shown] }).length >
								MAX_RETRIEVAL_CHARS - 40 &&
							shown.text.length > 0
						)
							shown.text = shown.text.slice(0, Math.floor(shown.text.length / 2));
						display.lines.push(shown);
						if (shown.text !== remainingText) {
							display.preview_truncated = true;
							display.next_line = line.line;
							display.next_column = startColumn + shown.text.length;
							break;
						}
					}
					if (display.lines.length < result.lines.length) display.preview_truncated = true;
					return { content: [{ type: "text", text: JSON.stringify(display) }], details: display };
				}
				if (params.start_column !== undefined || params.metadata_field !== undefined)
					throw new Error("start_column及metadata_field仅用于K_知识库缓存；案件来源仍按原物理行读取。");
				const text = [
					`来源 ${result.source_id}，共 ${result.total_lines} 行：`,
					`材料登记与提取信息（缺失字段表示未登记；不证明原件真实性、提取完整性或法条效力）：${JSON.stringify(result.source)}`,
					...result.lines.map((line) => `[${line.ref}] ${line.text}`),
				].join("\n");
				return { content: [{ type: "text", text }], details: result };
			} catch (error) {
				throw new Error(`来源读取失败：${errorText(error)}`);
			}
		},
	});

	pi.registerTool({
		name: "legal_citation_verify",
		label: "核验案件引文",
		description:
			"核验引文是否逐字出现在指定 source id 的处理文本中，返回行引用和列号；忽略行前引用标签。只核对提取文本中的匹配，不核验原件真实性、提取完整性或法条效力。",
		promptSnippet: "逐字核验案件引文并返回精确出处",
		parameters: Type.Object({
			source_id: Type.String({ description: "案件清单source id或legal_retrieve返回的K_缓存ID" }),
			quote: Type.String({ minLength: 1, description: "要逐字核验的原文" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = verifyQuote(ctx.cwd, params.source_id, params.quote);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
			} catch (error) {
				throw new Error(`引文核验失败：${errorText(error)}`);
			}
		},
	});

	pi.registerCommand("sources", {
		description: "显示当前案件已登记的来源",
		handler: async (_args, ctx) => {
			try {
				const sources = loadSources(ctx.cwd);
				const message = sources.length
					? sources.map((source) => `${source.id} · ${source.kind} · ${source.original_path}`).join("\n")
					: "当前案件未登记来源。";
				if (ctx.hasUI) ctx.ui.notify(message, "info");
				else console.log(message);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(errorText(error), "error");
				else console.error(errorText(error));
			}
		},
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const target = "path" in event.input ? event.input.path : undefined;
			if (typeof target !== "string" || !isOutputPath(ctx.cwd, target)) {
				return { block: true, reason: "法律 Agent 只允许 write/edit 写入当前案件的 outputs/ 目录。" };
			}
		}
	});
}
