import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandPromptTemplate } from "../../packages/coding-agent/src/core/prompt-templates.ts";
import {
	type AgentSession,
	compact,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
} from "../../packages/coding-agent/src/index.ts";
import { getKnowledgeServiceUrl } from "../extensions/internal/rag-core.ts";
import { buildCaseCheckpoint, readCaseState } from "../workflow/state.ts";
import { isAllowedReadPath } from "./path-guard.ts";
import {
	estimateLegalTextTokens,
	guardLegalCompaction,
	requestTokenBudget,
	shouldCompactWebRequest,
	WEB_RUN_LIMITS,
	WEB_TOOL_HEADROOM_TOKENS,
	WebRunBudget,
	WebRunOutcome,
	type WebTurnResult,
	withLegalSummaryBudget,
} from "./runtime.ts";
import {
	appendWebContextRecovery,
	openWebSession,
	prepareWebContextRecovery,
	readRegisteredDraft,
	readWebConversation,
	saveWebCheckpointFailure,
	saveWebRequest,
	saveWebTurn,
	validConversationId,
} from "./runtime-store.ts";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const publicDir = join(repoDir, "legal", "web", "public");
const agentDir = process.env.LEGALAGENT_CODING_AGENT_DIR || join(repoDir, ".local", "agent");
const allowDraftWrite = process.env.LEGALAGENT_ALLOW_WRITE === "1";
const toolNames = [
	"read",
	"legal_sources_list",
	"legal_source_read",
	"legal_citation_verify",
	"legal_retrieve",
	"legal_case_status",
	"legal_case_update",
	"legal_case_advance",
	...(allowDraftWrite ? ["legal_draft_save"] : []),
];
const maxSessions = 8;
const maxBodyBytes = 64 * 1024;
const maxMessageChars = 12_000;

type ChatEvent =
	| { type: "status"; message: string }
	| { type: "delta"; text: string }
	| { type: "tool_start"; toolCallId: string; name: string; args?: unknown }
	| { type: "tool_end"; toolCallId: string; name: string; isError: boolean; output?: string }
	| { type: "done" }
	| ({
			type: "diagnostic";
			phase: string;
			message?: string;
			estimatedRequestTokens?: number;
			estimatedBaselineTokens?: number;
			contextWindow?: number;
			toolHeadroomTokens?: number;
			compactionNeeded?: boolean;
	  } & Partial<WebTurnResult>)
	| { type: "error"; message: string };

interface SessionRecord {
	ready: Promise<AgentSession>;
	session?: AgentSession;
	busy: boolean;
	lastUsed: number;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseOptions(): { caseDir: string; port: number } {
	let caseDir: string | undefined;
	let port = 18005;
	for (let i = 2; i < process.argv.length; i += 2) {
		const key = process.argv[i];
		const value = process.argv[i + 1];
		if (!value || (key !== "--case-dir" && key !== "--port")) {
			throw new Error("Usage: server.ts --case-dir <case-folder> [--port 18005]");
		}
		if (key === "--case-dir") caseDir = value;
		else port = Number(value);
	}
	if (!caseDir) throw new Error("--case-dir is required");
	if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid web port");
	const resolvedCaseDir = realpathSync.native(caseDir);
	if (!statSync(resolvedCaseDir).isDirectory()) throw new Error("CaseDir must be a folder");
	return { caseDir: resolvedCaseDir, port };
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(JSON.stringify(data));
}

function startStream(res: ServerResponse, status = 200): void {
	res.writeHead(status, {
		"Content-Type": "application/x-ndjson; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.flushHeaders();
}

function writeEvent(res: ServerResponse, event: ChatEvent): void {
	if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
}

function sendChatError(res: ServerResponse, status: number, message: string): void {
	startStream(res, status);
	writeEvent(res, { type: "error", message });
	res.end();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size > maxBodyBytes) throw new Error("请求内容超过 64 KB");
		chunks.push(bytes);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("请求必须是有效 JSON");
	}
}

function toolOutput(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
		return "";
	}
	const text = (result.content as unknown[])
		.map((part) => {
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
	return text.length > 1200 ? `${text.slice(0, 1200)}\n…（工具结果过长，页面仅显示前 1200 字）` : text;
}

async function main(): Promise<void> {
	const { caseDir, port } = parseOptions();
	for (const path of [join(agentDir, "models.json"), join(agentDir, "settings.json")]) {
		if (!existsSync(path)) throw new Error(`LegalAgent 配置缺失：${path}；请先运行 npm run legal:setup`);
	}
	const settings = SettingsManager.create(caseDir, agentDir, { projectTrusted: false });
	const providerName = settings.getDefaultProvider();
	const modelName = settings.getDefaultModel();
	if (!providerName || !modelName) throw new Error("请在 settings.json 中设置 defaultProvider 与 defaultModel");
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const configuredModel = modelRuntime.getModel(providerName, modelName);
	if (!configuredModel) throw new Error(`LegalAgent 模型配置缺失：${providerName}/${modelName}`);
	const model = configuredModel;
	const endpoint = new URL(model.baseUrl);
	if (
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash ||
		!(
			endpoint.protocol === "https:" ||
			(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))
		)
	) {
		throw new Error("模型 API 须使用本机 HTTP 或 HTTPS 地址；密钥请通过环境变量配置");
	}
	const modelsUrl = `${model.baseUrl.replace(/\/$/, "")}/models`;
	const skillsDir = realpathSync.native(join(repoDir, "legal", "skills"));
	const sessions = new Map<string, SessionRecord>();
	const diagnosticSinks = new WeakMap<AgentSession, (event: ChatEvent) => void>();
	const compactionFailures = new WeakMap<AgentSession, string>();
	const expectedHost = `127.0.0.1:${port}`;
	const expectedOrigin = `http://${expectedHost}`;

	async function checkModel(): Promise<string | undefined> {
		try {
			const auth = await modelRuntime.getAuth(model);
			if (!auth) throw new Error("未配置 API 认证；请设置 LEGALAGENT_API_KEY");
			const headers = new Headers();
			for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
				if (value !== null) headers.set(name, value);
			}
			if (auth.auth.apiKey && !headers.has("Authorization"))
				headers.set("Authorization", `Bearer ${auth.auth.apiKey}`);
			const response = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(3000), redirect: "error" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body: unknown = await response.json();
			if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
				throw new Error("模型列表格式无效");
			}
			if (
				!body.data.some(
					(item: unknown) => item && typeof item === "object" && "id" in item && item.id === modelName,
				)
			) {
				throw new Error(`模型列表中没有 ${modelName}`);
			}
			return undefined;
		} catch (error) {
			return `无法连接法律模型：${messageOf(error)}。请检查模型 API、模型名与认证配置。`;
		}
	}

	async function checkRag(): Promise<{ state: string; message: string }> {
		try {
			const healthUrl = getKnowledgeServiceUrl("health");
			if (!healthUrl) return { state: "unconfigured", message: "未配置外部知识库；本案材料检索可用" };
			const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000), redirect: "error" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const health: unknown = await response.json();
			if (!health || typeof health !== "object") throw new Error("检索服务状态格式无效");
			if (("ready" in health && health.ready === true) || ("state" in health && health.state === "ready"))
				return { state: "ready", message: "用户配置的法律知识库已连接" };
			if ("state" in health && health.state === "loading")
				return { state: "loading", message: "正在加载法律知识库" };
			return { state: "failed", message: "法律知识库加载失败，请查看检索服务日志" };
		} catch (error) {
			return { state: "offline", message: `检索服务未连接：${messageOf(error)}` };
		}
	}

	async function createSession(conversationId: string): Promise<AgentSession> {
		const settingsManager = SettingsManager.create(caseDir, agentDir, { projectTrusted: false });
		// These are web-only overrides; SDK cut points still use chars/4, so keep
		// a smaller recent window while preserving the complete transcript on disk.
		settingsManager.applyOverrides({
			compaction: {
				enabled: true,
				reserveTokens: 8192,
				keepRecentTokens: 1500,
				modelOverrides: { [`${providerName}/${modelName}`]: { reserveTokens: 8192, keepRecentTokens: 1500 } },
			},
		});
		let createdSession: AgentSession | undefined;
		const resourceLoader = new DefaultResourceLoader({
			cwd: caseDir,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => undefined,
			appendSystemPrompt: [join(repoDir, "legal", "AGENT_GUIDE.md")],
			additionalExtensionPaths: [
				join(repoDir, "legal", "extensions", "legal-sources.ts"),
				join(repoDir, "legal", "extensions", "legal-rag.ts"),
				join(repoDir, "legal", "extensions", "legal-workflow.ts"),
			],
			additionalSkillPaths: [join(repoDir, "legal", "skills")],
			additionalPromptTemplatePaths: [join(repoDir, "legal", "prompts")],
			extensionFactories: [
				{
					name: "web-read-boundary",
					factory: (pi) => {
						pi.on("tool_call", (event) => {
							if (event.toolName !== "read") return;
							const path = event.input.path;
							if (typeof path !== "string" || !isAllowedReadPath(path, caseDir, skillsDir)) {
								return { block: true, reason: "网页版只允许读取当前案件目录和内置法律技能文件。" };
							}
						});
						pi.on("session_before_compact", async (event) =>
							guardLegalCompaction(
								async () => {
									if (!createdSession) throw new Error("法律会话尚未就绪");
									const summaryModel = createdSession.model;
									if (!summaryModel) throw new Error("法律会话模型尚未就绪");
									const instructions = [
										"请用中文保存法律办案连续性：案件范围和程序位置、每项已确认事实及来源ID/页行、当事人陈述和推论的区别、争点正反理由、已纠正或排除的观点、法律文本版本与待核效力、主张和备选及成立条件、未完成任务、草稿路径和本轮待完成请求。不得把缺失证据、待核法律或工作笔记升级为已确认结论，不要删除分歧。摘要是检查点，原对话和材料仍保留。",
										event.customInstructions ?? "",
										buildCaseCheckpoint(caseDir),
									].join("\n\n");
									const result = await compact(
										event.preparation,
										summaryModel,
										undefined,
										undefined,
										instructions,
										event.signal,
										"off",
										withLegalSummaryBudget(createdSession.agent.streamFunction),
										undefined,
										settingsManager.getRetrySettings(),
										{
											onRetryScheduled: (attempt, _maxAttempts, _delayMs, errorMessage) => {
												if (!createdSession) return;
												diagnosticSinks.get(createdSession)?.({
													type: "status",
													message: `法律检查点生成暂时失败，正在第 ${attempt} 次恢复`,
												});
												diagnosticSinks.get(createdSession)?.({
													type: "diagnostic",
													phase: "summarization_retry_scheduled",
													message: errorMessage,
												});
											},
										},
									);
									compactionFailures.delete(createdSession);
									return result;
								},
								(reason) => {
									if (!createdSession) return;
									compactionFailures.set(createdSession, reason);
									diagnosticSinks.get(createdSession)?.({
										type: "diagnostic",
										phase: "compaction_failure",
										message: reason,
									});
								},
							),
						);
					},
				},
			],
		});
		await resourceLoader.reload();
		const extensionErrors = resourceLoader.getExtensions().errors;
		if (extensionErrors.length > 0) throw new Error(extensionErrors.map((item) => item.error).join("; "));
		const { session } = await createAgentSession({
			cwd: caseDir,
			agentDir,
			model,
			thinkingLevel: "off",
			modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager: openWebSession(caseDir, conversationId),
			tools: toolNames,
		});
		createdSession = session;
		try {
			await session.bindExtensions({ mode: "print" });
			const active = session.getActiveToolNames();
			if (active.length !== toolNames.length || active.some((name) => !toolNames.includes(name))) {
				throw new Error("法律材料与流程工具未完整加载");
			}
			return session;
		} catch (error) {
			session.dispose();
			throw error;
		}
	}

	const server = createServer(async (req, res) => {
		if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== expectedOrigin)) {
			sendJson(res, 403, { error: "仅允许从本机网页访问" });
			return;
		}
		let url: URL;
		try {
			url = new URL(req.url || "/", expectedOrigin);
		} catch {
			sendJson(res, 400, { error: "请求路径无效" });
			return;
		}
		const path = url.pathname;
		if (req.method === "GET" && path === "/api/health") {
			const [error, rag] = await Promise.all([checkModel(), checkRag()]);
			sendJson(res, error ? 503 : 200, {
				ok: !error,
				model: modelName,
				caseDir,
				rag,
				allowDraftWrite,
				...(error ? { error } : {}),
			});
			return;
		}
		if (req.method === "GET" && path === "/api/conversation") {
			const id = url.searchParams.get("id") || "";
			if (!validConversationId(id)) {
				sendJson(res, 400, { error: "会话 ID 无效" });
				return;
			}
			try {
				const record = sessions.get(id);
				sendJson(res, 200, readWebConversation(caseDir, id, record?.session?.sessionManager, record?.busy));
			} catch (error) {
				sendJson(res, 500, { error: `恢复对话失败：${messageOf(error)}` });
			}
			return;
		}
		if (req.method === "GET" && path === "/api/case-state") {
			try {
				sendJson(res, 200, { state: readCaseState(caseDir), summary: buildCaseCheckpoint(caseDir) });
			} catch (error) {
				sendJson(res, 500, { error: `读取案件状态失败：${messageOf(error)}` });
			}
			return;
		}
		if (req.method === "GET" && path === "/api/draft") {
			try {
				const filename = url.searchParams.get("filename");
				const draft = readCaseState(caseDir).drafts.find((item) => item.filename === filename);
				if (!draft) {
					sendJson(res, 404, { error: "草稿未登记" });
					return;
				}
				const body = readRegisteredDraft(caseDir, draft);
				const encoded = encodeURIComponent(draft.filename).replace(
					/['()*]/g,
					(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
				);
				res.writeHead(200, {
					"Content-Type": "text/markdown; charset=utf-8",
					"Content-Disposition": `attachment; filename="legalagent-draft.md"; filename*=UTF-8''${encoded}`,
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
				});
				res.end(body);
			} catch (error) {
				sendJson(res, 403, { error: `草稿下载失败：${messageOf(error)}` });
			}
			return;
		}
		if (req.method === "GET" && ["/", "/index.html", "/app.js", "/style.css"].includes(path)) {
			const file = path === "/" ? "index.html" : path.slice(1);
			try {
				const body = readFileSync(join(publicDir, file));
				res.writeHead(200, {
					"Content-Type": file.endsWith(".html")
						? "text/html; charset=utf-8"
						: file.endsWith(".js")
							? "text/javascript; charset=utf-8"
							: "text/css; charset=utf-8",
					"Cache-Control": "no-store",
					"Content-Security-Policy":
						"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
					"Referrer-Policy": "no-referrer",
					"X-Content-Type-Options": "nosniff",
				});
				res.end(body);
			} catch {
				sendJson(res, 404, { error: "页面文件不存在" });
			}
			return;
		}
		if (req.method !== "POST" || path !== "/api/chat") {
			sendJson(res, 404, { error: "接口不存在" });
			return;
		}
		if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
			sendChatError(res, 415, "请使用 application/json 提交消息");
			return;
		}
		let body: unknown;
		try {
			body = await readJson(req);
		} catch (error) {
			sendChatError(res, 400, messageOf(error));
			return;
		}
		if (
			!body ||
			typeof body !== "object" ||
			!("caseDir" in body) ||
			!("message" in body) ||
			!("conversationId" in body)
		) {
			sendChatError(res, 400, "缺少案件目录、消息或会话 ID");
			return;
		}
		if (
			typeof body.caseDir !== "string" ||
			typeof body.message !== "string" ||
			typeof body.conversationId !== "string"
		) {
			sendChatError(res, 400, "请求字段类型无效");
			return;
		}
		let requestedCase: string;
		try {
			requestedCase = realpathSync.native(body.caseDir);
		} catch {
			sendChatError(res, 400, "案件目录不存在");
			return;
		}
		if (requestedCase.toLowerCase() !== caseDir.toLowerCase()) {
			sendChatError(res, 403, "网页只能访问启动时指定的案件目录");
			return;
		}
		const message = body.message.trim();
		const conversationId = body.conversationId;
		if (!message || message.length > maxMessageChars || !validConversationId(conversationId)) {
			sendChatError(res, 400, "消息须为 1–12000 字，且会话 ID 须为 8–80 位字母、数字、下划线或连字符");
			return;
		}
		const modelError = await checkModel();
		if (modelError) {
			sendChatError(res, 503, modelError);
			return;
		}
		let record = sessions.get(conversationId);
		if (record?.busy) {
			sendChatError(res, 409, "当前会话仍在处理上一条消息");
			return;
		}
		if (!record) {
			if (sessions.size >= maxSessions) {
				const idle = [...sessions.entries()]
					.filter(([, item]) => !item.busy)
					.sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
				if (!idle) {
					sendChatError(res, 429, "并发会话已满，请稍后再试");
					return;
				}
				idle[1].session?.dispose();
				sessions.delete(idle[0]);
			}
			record = { ready: createSession(conversationId), busy: true, lastUsed: Date.now() };
			sessions.set(conversationId, record);
		} else {
			record.busy = true;
			record.lastUsed = Date.now();
		}
		startStream(res);
		writeEvent(res, { type: "status", message: "正在生成回答" });
		try {
			const session = await record.ready;
			record.session = session;
			if (res.destroyed) {
				saveWebRequest(session.sessionManager, message);
				saveWebTurn(session.sessionManager, {
					state: "incomplete",
					startedAt: Date.now(),
					endedAt: Date.now(),
					reason: "客户端在生成开始前中断。本轮未完成，请求已保留。",
				});
				return;
			}
			const budget = new WebRunBudget();
			const outcome = new WebRunOutcome();
			const previousStop = session.agent.shouldStopAfterTurn;
			const previousBeforeTool = session.agent.beforeToolCall;
			const previousPayload = session.agent.onPayload;
			const estimateRequest = async (newMessage?: string, messages = session.messages) => {
				const prepared = (await session.agent.transformContext?.(messages, session.agent.signal)) ?? messages;
				return requestTokenBudget({
					messages: prepared,
					systemPrompt: session.systemPrompt,
					tools: session
						.getAllTools()
						.filter((tool) => session.getActiveToolNames().includes(tool.name))
						.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
					message: newMessage ? expandPromptTemplate(newMessage, [...session.promptTemplates]) : undefined,
					checkpoint: newMessage ? buildCaseCheckpoint(caseDir) : undefined,
					outputTokens: model.maxTokens,
				});
			};
			session.agent.beforeToolCall = async (context, signal) => {
				if (budget.reason) return { block: true, reason: budget.reason, terminate: true };
				return previousBeforeTool?.(context, signal);
			};
			session.agent.shouldStopAfterTurn = async (turn, signal) => {
				const hasMoreTools =
					turn.message.role === "assistant" && turn.message.content.some((part) => part.type === "toolCall");
				budget.completeTurn(Date.now(), hasMoreTools);
				if (
					!budget.reason &&
					hasMoreTools &&
					(await estimateRequest(undefined, turn.context.messages)) >= model.contextWindow
				) {
					budget.stop(
						"本轮工具结果使上下文接近模型上限，已在完整工具轮次后停止。本轮未完成；下次请求会先压缩法律检查点，全部原文仍保留。",
					);
				}
				return budget.reason !== undefined || (await previousStop?.(turn, signal)) === true;
			};
			session.agent.onPayload = async (payload, requestModel) => {
				if (budget.reason) throw new Error(budget.reason);
				const transformed = previousPayload ? await previousPayload(payload, requestModel) : payload;
				if (
					estimateLegalTextTokens(JSON.stringify(transformed) ?? "") + requestModel.maxTokens + 1024 >=
					requestModel.contextWindow
				) {
					budget.stop(
						"展开模板、案件状态或工具结果后，请求仍超过模型上下文预算。本轮未完成；原对话和案件状态已保留，请缩小本轮任务。",
					);
					throw new Error(budget.reason);
				}
				return transformed;
			};
			const onClose = () => {
				if (!res.writableEnded) {
					budget.stop("生成已停止，本轮未完成；对话和案件状态已保留。");
					void session.abort().catch(() => {});
				}
			};
			res.on("close", onClose);
			const timer = setTimeout(() => {
				budget.timeout();
				void session.abort().catch(() => {});
			}, WEB_RUN_LIMITS.timeMs);
			diagnosticSinks.set(session, (event) => writeEvent(res, event));
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "turn_start") {
					budget.observeTurn();
				} else if (event.type === "message_update") {
					if (event.assistantMessageEvent.type === "text_delta") {
						writeEvent(res, { type: "delta", text: event.assistantMessageEvent.delta });
					}
				} else if (event.type === "tool_execution_start") {
					budget.observeTool(event.toolName, event.args);
					writeEvent(res, {
						type: "tool_start",
						toolCallId: event.toolCallId,
						name: event.toolName,
						args: event.args,
					});
				} else if (event.type === "tool_execution_end") {
					writeEvent(res, {
						type: "tool_end",
						toolCallId: event.toolCallId,
						name: event.toolName,
						isError: event.isError,
						output: toolOutput(event.result),
					});
				} else if (event.type === "message_end" && event.message.role === "assistant") {
					outcome.observeAssistant(event.message);
					writeEvent(res, {
						type: "diagnostic",
						phase: "model",
						stopReason: event.message.stopReason,
						usage: event.message.usage,
					});
				} else if (
					event.type === "message_end" &&
					event.message.role === "custom" &&
					event.message.customType === "legal-workflow-stopped"
				) {
					const content = event.message.content;
					budget.stop(
						typeof content === "string"
							? content
							: content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n"),
					);
				} else if (event.type === "compaction_start") {
					writeEvent(res, { type: "status", message: "正在整理法律案件检查点，原对话和材料保留" });
					writeEvent(res, { type: "diagnostic", phase: "compaction_start" });
				} else if (event.type === "compaction_end") {
					outcome.observeCompaction(
						compactionFailures.get(session) ?? event.errorMessage,
						Boolean(event.result) && !event.aborted,
					);
					writeEvent(res, {
						type: "diagnostic",
						phase: "compaction_end",
						message: event.errorMessage || (event.aborted ? "检查点整理已停止" : "检查点整理完成"),
					});
				} else if (event.type === "auto_retry_start" || event.type === "summarization_retry_scheduled") {
					writeEvent(res, { type: "status", message: `模型连接暂时失败，正在第 ${event.attempt} 次恢复` });
					writeEvent(res, { type: "diagnostic", phase: event.type, message: event.errorMessage });
				} else if (event.type === "auto_retry_end") {
					writeEvent(res, {
						type: "diagnostic",
						phase: "auto_retry_end",
						message: event.success ? "模型响应已恢复" : event.finalError,
					});
				}
			});
			let thrownError: string | undefined;
			try {
				saveWebRequest(session.sessionManager, message);
				saveWebTurn(session.sessionManager, { state: "running", startedAt: budget.startedAt });
				const requestTokens = await estimateRequest(message);
				const baselineTokens = await estimateRequest(message, []);
				const compactionNeeded = shouldCompactWebRequest(requestTokens, baselineTokens, model.contextWindow);
				writeEvent(res, {
					type: "diagnostic",
					phase: "preflight_budget",
					estimatedRequestTokens: requestTokens,
					estimatedBaselineTokens: baselineTokens,
					contextWindow: model.contextWindow,
					toolHeadroomTokens: WEB_TOOL_HEADROOM_TOKENS,
					compactionNeeded,
				});
				if (compactionNeeded) {
					writeEvent(res, { type: "status", message: "长案件对话接近上下文上限，正在保存法律检查点" });
					let checkpointFailure: string | undefined;
					try {
						await session.compact(
							"保留当前办案阶段、各事实来源、正反争点、主备选方案及条件、已纠正观点、待办和草稿路径。不得以摘要代替原始证据。",
						);
					} catch (error) {
						checkpointFailure = compactionFailures.get(session) ?? `法律对话摘要未完成：${messageOf(error)}`;
					}
					if (!checkpointFailure && (await estimateRequest(message)) >= model.contextWindow)
						checkpointFailure = "法律对话摘要已生成，但保留窗口仍超过本轮中文上下文预算。";
					if (checkpointFailure) {
						saveWebCheckpointFailure(session.sessionManager, checkpointFailure);
						writeEvent(res, { type: "diagnostic", phase: "checkpoint_failure", message: checkpointFailure });
						if (budget.reason || res.destroyed) throw new Error(budget.reason || "生成已停止，未执行窗口恢复");
						if (session.agent.state.isStreaming) throw new Error("法律模型仍在生成，不能恢复上下文窗口。");
						const recovery = prepareWebContextRecovery(session.sessionManager, message, checkpointFailure);
						if ((await estimateRequest(message, recovery.messages)) >= model.contextWindow)
							throw new Error(
								"仅案件状态恢复后的请求仍超过中文上下文预算；未切换窗口，原历史与本轮请求已保留，请缩小本轮问题。",
							);
						session.agent.state.messages = appendWebContextRecovery(session.sessionManager, recovery);
						compactionFailures.delete(session);
						outcome.observeCompaction(undefined, true);
						writeEvent(res, {
							type: "status",
							message: "已从保存的案件状态恢复模型窗口；这不是完整历史摘要，原对话保留，本轮继续处理",
						});
						writeEvent(res, {
							type: "diagnostic",
							phase: "context_recovery",
							message: `仅案件状态恢复：revision ${recovery.details.revision}；未登记内容须查原历史或补充。`,
						});
					}
					if ((await estimateRequest(message)) >= model.contextWindow)
						throw new Error(
							"法律检查点整理后，请求仍超过上下文预算。全部对话和材料已保留，请缩短问题或分章节处理。",
						);
					writeEvent(res, {
						type: "diagnostic",
						phase: "post_compaction_budget",
						estimatedRequestTokens: await estimateRequest(message),
						estimatedBaselineTokens: baselineTokens,
						contextWindow: model.contextWindow,
						toolHeadroomTokens: WEB_TOOL_HEADROOM_TOKENS,
					});
				}
				if (budget.reason || res.destroyed) throw new Error(budget.reason || "生成已停止");
				await session.prompt(message);
			} catch (error) {
				thrownError = compactionFailures.get(session) ?? messageOf(error);
			} finally {
				clearTimeout(timer);
				diagnosticSinks.delete(session);
				unsubscribe();
				res.off("close", onClose);
				session.agent.shouldStopAfterTurn = previousStop;
				session.agent.beforeToolCall = previousBeforeTool;
				session.agent.onPayload = previousPayload;
			}
			const result = outcome.finish(budget, thrownError);
			saveWebTurn(session.sessionManager, result);
			writeEvent(res, { type: "diagnostic", phase: "settled", ...result });
			writeEvent(
				res,
				result.state === "complete" ? { type: "done" } : { type: "error", message: result.reason || "本轮未完成" },
			);
		} catch (error) {
			if (!record.session) sessions.delete(conversationId);
			writeEvent(res, { type: "error", message: messageOf(error) });
		} finally {
			record.busy = false;
			record.lastUsed = Date.now();
			if (!res.writableEnded) res.end();
		}
	});

	server.listen(port, "127.0.0.1", () => {
		console.log(`法律 Agent 网页已启动：http://127.0.0.1:${port}/`);
		console.log(`案件目录：${caseDir}`);
	});
	const shutdown = () => {
		server.close();
		for (const record of sessions.values()) record.session?.dispose();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
	console.error(messageOf(error));
	process.exitCode = 1;
});
