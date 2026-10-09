import type { AgentMessage, StreamFn } from "../../packages/agent/src/types.ts";
import type { AssistantMessage } from "../../packages/ai/src/types.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";

export const WEB_RUN_LIMITS = {
	toolCalls: 24,
	repeatedCalls: 3,
	turns: 12,
	timeMs: 300_000,
};

export const WEB_TOOL_HEADROOM_TOKENS = 4096;

/** Compact once before a request to leave room for tool results; fixed prompt/schema costs cannot be reclaimed. */
export function shouldCompactWebRequest(requestTokens: number, baselineTokens: number, contextWindow: number): boolean {
	return (
		requestTokens >= contextWindow ||
		(requestTokens >= contextWindow - WEB_TOOL_HEADROOM_TOKENS && requestTokens - baselineTokens >= 1024)
	);
}

export interface WebUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface WebTurnResult {
	state: "running" | "complete" | "incomplete" | "error";
	stopReason?: AssistantMessage["stopReason"];
	usage?: WebUsage;
	reason?: string;
	startedAt: number;
	endedAt?: number;
}

/** Count Chinese conservatively; the coding runtime's chars/4 estimate is insufficient here. */
export function estimateLegalTextTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const char of text) {
		if (
			/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u.test(char)
		)
			cjk++;
		else other++;
	}
	return cjk + Math.ceil(other / 3);
}

export function requestTokenBudget(input: {
	messages: AgentMessage[];
	systemPrompt: string;
	tools: unknown[];
	message?: string;
	checkpoint?: string;
	outputTokens: number;
}): number {
	let tokens = estimateLegalTextTokens(input.systemPrompt) + estimateLegalTextTokens(JSON.stringify(input.tools));
	let checkpointIndex = -1;
	if (input.checkpoint === undefined) {
		for (let index = input.messages.length - 1; index >= 0; index--) {
			const message = input.messages[index];
			if (message.role === "custom" && message.customType === "legal-case-checkpoint") {
				checkpointIndex = index;
				break;
			}
		}
	}
	for (const [index, message] of input.messages.entries()) {
		if (message.role === "system") continue;
		if (message.role === "custom" && message.customType === "legal-case-checkpoint" && index !== checkpointIndex)
			continue;
		const content = "content" in message ? message.content : "summary" in message ? message.summary : message;
		tokens += estimateLegalTextTokens(JSON.stringify(content)) + 24;
	}
	if (input.message) tokens += estimateLegalTextTokens(input.message) + 24;
	if (input.checkpoint) tokens += estimateLegalTextTokens(input.checkpoint) + 24;
	return tokens + input.outputTokens + 1024;
}

/** Compaction calls its stream function directly, without the Agent's onPayload hook. */
export function withLegalSummaryBudget(streamFn: StreamFn): StreamFn {
	return (model, context, options) => {
		const outputTokens = options?.maxTokens ?? model.maxTokens;
		const reason = "法律检查点请求超过中文上下文预算，已停止摘要；全部原始对话和材料已保留，请分章节处理。";
		if (estimateLegalTextTokens(JSON.stringify(context)) + outputTokens + 1024 >= model.contextWindow) {
			const stream = new AssistantMessageEventStream();
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "error",
					errorMessage: reason,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			});
			return stream;
		}
		return streamFn(model, context, {
			...options,
			onPayload: async (payload, requestModel) => {
				const replacement = await options?.onPayload?.(payload, requestModel);
				const transformed = replacement ?? payload;
				if (
					estimateLegalTextTokens(JSON.stringify(transformed) ?? "") + outputTokens + 1024 >=
					requestModel.contextWindow
				)
					throw new Error(reason);
				return transformed;
			},
		});
	};
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

/** One request owns this budget. It never resets when the SDK retries a model call. */
export class WebRunBudget {
	private calls = 0;
	private turns = 0;
	private readonly repeats = new Map<string, number>();
	private readonly limits: typeof WEB_RUN_LIMITS;
	readonly startedAt: number;
	reason: string | undefined;

	constructor(startedAt = Date.now(), limits = WEB_RUN_LIMITS) {
		this.startedAt = startedAt;
		this.limits = limits;
	}

	observeTool(name: string, args: unknown): void {
		this.calls++;
		const key = `${name}:${stableJson(args)}`;
		const count = (this.repeats.get(key) ?? 0) + 1;
		this.repeats.set(key, count);
		if (this.calls > this.limits.toolCalls)
			this.stop("工具调用次数已达到本轮上限，尚未完成的任务已保留。请缩小任务或继续下一步。");
		else if (count > this.limits.repeatedCalls)
			this.stop("同一工具和参数反复调用，已停止本轮循环。已有材料和案件状态已保留。");
	}

	observeTurn(): void {
		this.turns++;
		if (this.turns > this.limits.turns) this.stop("模型调用已达到本轮上限，本轮未完成。已有对话和案件状态已保留。");
	}

	completeTurn(now = Date.now(), hasMoreTools = true): boolean {
		if (now - this.startedAt >= this.limits.timeMs) this.timeout();
		else if (hasMoreTools && this.calls >= this.limits.toolCalls)
			this.stop("工具调用次数已达到本轮上限，本轮未完成。已有材料和案件状态已保留。");
		else if (hasMoreTools && [...this.repeats.values()].some((count) => count >= this.limits.repeatedCalls))
			this.stop("同一工具和参数反复调用，已停止本轮循环。本轮未完成，已有材料和案件状态已保留。");
		else if (hasMoreTools && this.turns >= this.limits.turns)
			this.stop("模型工具循环已达到本轮上限，本轮未完成。请继续下一步或缩小任务。");
		return this.reason !== undefined;
	}

	timeout(): void {
		this.stop("本轮处理超过五分钟，已停止生成。本轮未完成，已有对话和案件状态已保留。");
	}

	stop(reason: string): void {
		this.reason ??= reason;
	}
}

export function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/** ExtensionRunner catches thrown hooks and falls back. Return cancel explicitly on failure. */
export async function guardLegalCompaction<T>(
	generate: () => Promise<T>,
	onFailure: (reason: string) => void,
): Promise<{ compaction: T } | { cancel: true }> {
	try {
		return { compaction: await generate() };
	} catch (error) {
		onFailure(
			`法律检查点生成失败：${error instanceof Error ? error.message : String(error)}。全部对话和材料已保留，本轮未完成。`,
		);
		return { cancel: true };
	}
}

/** A successful retry supersedes earlier provider errors; a failed checkpoint does not. */
export class WebRunOutcome {
	private finalMessage: AssistantMessage | undefined;
	private compactionError: string | undefined;

	observeAssistant(message: AssistantMessage): void {
		this.finalMessage = message;
	}

	observeCompaction(errorMessage: string | undefined, succeeded: boolean): void {
		if (errorMessage) this.compactionError = errorMessage;
		else if (succeeded) this.compactionError = undefined;
	}

	finish(budget: WebRunBudget, thrownError?: string): WebTurnResult {
		const message = this.finalMessage;
		const result: WebTurnResult = {
			state: "complete",
			startedAt: budget.startedAt,
			endedAt: Date.now(),
			...(message
				? {
						stopReason: message.stopReason,
						usage: {
							input: message.usage.input,
							output: message.usage.output,
							cacheRead: message.usage.cacheRead,
							cacheWrite: message.usage.cacheWrite,
							totalTokens: message.usage.totalTokens,
						},
					}
				: {}),
		};
		const error = thrownError ?? this.compactionError;
		if (budget.reason) return { ...result, state: "incomplete", reason: budget.reason };
		if (error) return { ...result, state: "error", reason: error };
		if (!message) return { ...result, state: "incomplete", reason: "本轮未生成文字回复，不能标记为完成。" };
		if (message.stopReason === "error")
			return { ...result, state: "error", reason: message.errorMessage || "模型响应失败。" };
		if (message.stopReason === "aborted")
			return { ...result, state: "incomplete", reason: "生成已停止，本轮未完成；对话和案件状态已保留。" };
		if (message.stopReason === "length")
			return {
				...result,
				state: "incomplete",
				reason: "模型达到输出上限，回答或草稿被截断。本轮未完成，请按章节继续；原文已保留。",
			};
		if (message.content.some((part) => part.type === "toolCall") || message.stopReason !== "stop")
			return { ...result, state: "incomplete", reason: "本轮停在工具处理阶段，尚未形成完整回复。" };
		if (!assistantText(message).trim())
			return { ...result, state: "incomplete", reason: "模型未生成文字回复，本轮未完成。" };
		return result;
	}
}
