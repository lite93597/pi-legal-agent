import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { Agent } from "../../packages/agent/src/agent.ts";
import type { AssistantMessage, Model, SimpleStreamOptions } from "../../packages/ai/src/types.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { normalizeContext } from "../../packages/ai/src/utils/transcript.ts";
import {
	estimateLegalTextTokens,
	guardLegalCompaction,
	requestTokenBudget,
	shouldCompactWebRequest,
	WEB_RUN_LIMITS,
	WebRunBudget,
	WebRunOutcome,
	withLegalSummaryBudget,
} from "./runtime.ts";

const model: Model<"openai-completions"> = {
	id: "offline-legal",
	name: "offline-legal",
	api: "openai-completions",
	provider: "offline",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	contextWindow: 20480,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function answer(stopReason: AssistantMessage["stopReason"] = "stop", text = "完整的离线回复"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: model.provider,
		model: model.id,
		stopReason,
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

test("Chinese request budget includes scope, tools, history, input, checkpoint and generation", () => {
	assert.equal(estimateLegalTextTokens("法律事实证据"), 6);
	assert.equal(estimateLegalTextTokens("abcdef"), 2);
	const baseline = requestTokenBudget({ messages: [], systemPrompt: "", tools: [], outputTokens: 4096 });
	const full = requestTokenBudget({
		messages: [{ role: "user", content: [{ type: "text", text: "已知事实" }], timestamp: 1 }],
		systemPrompt: "案件分析规则",
		tools: [{ name: "legal_case_update", parameters: { text: "法律事实" } }],
		message: "继续辩护",
		checkpoint: "争点与待核事项",
		outputTokens: 4096,
	});
	assert.ok(full > baseline + 30);
	const chinese = requestTokenBudget({
		messages: [],
		systemPrompt: "法".repeat(15000),
		tools: [],
		message: "案".repeat(1000),
		outputTokens: 4096,
	});
	assert.ok(chinese > model.contextWindow);
});

test("preflight leaves 4096 tokens for tool results without repeatedly compacting an irreducible high baseline", () => {
	assert.equal(shouldCompactWebRequest(16383, 12000, 20480), false);
	assert.equal(shouldCompactWebRequest(16384, 12000, 20480), true);
	assert.equal(shouldCompactWebRequest(18000, 17500, 20480), false);
	assert.equal(shouldCompactWebRequest(20480, 20480, 20480), true);
	assert.equal(shouldCompactWebRequest(15000, 12000, 20480), false);
});

test("request budget retains only the latest case checkpoint or replaces it with the fresh checkpoint", () => {
	const latest: Parameters<typeof requestTokenBudget>[0] = {
		messages: [
			{
				role: "custom",
				customType: "legal-case-checkpoint",
				content: "当前事实与待核",
				display: false,
				timestamp: 2,
			},
		],
		systemPrompt: "规则",
		tools: [],
		outputTokens: 4096,
	};
	const history = {
		...latest,
		messages: [
			{
				role: "custom" as const,
				customType: "legal-case-checkpoint",
				content: "旧".repeat(12000),
				display: false,
				timestamp: 1,
			},
			...latest.messages,
		],
	};
	assert.equal(requestTokenBudget(history), requestTokenBudget(latest));
	assert.equal(
		requestTokenBudget({ ...history, checkpoint: "新事实" }),
		requestTokenBudget({ ...latest, messages: [], checkpoint: "新事实" }),
	);
});

test("summary stream checks Chinese input and its own output reserve before sending, then checks the provider payload", async () => {
	let calls = 0;
	let observedOptions: SimpleStreamOptions | undefined;
	const wrapped = withLegalSummaryBudget((_model, _context, options) => {
		calls++;
		observedOptions = options;
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: answer() });
		return stream;
	});
	const longContext = normalizeContext({ messages: [{ role: "user", content: "法".repeat(16000), timestamp: 1 }] });
	const blocked = await (await wrapped(model, longContext, { maxTokens: 4096 })).result();
	assert.equal(blocked.stopReason, "error");
	assert.match(blocked.errorMessage ?? "", /中文上下文预算/);
	assert.equal(calls, 0);
	const shortContext = normalizeContext({ messages: [{ role: "user", content: "摘要事实", timestamp: 1 }] });
	const smallModel = { ...model, contextWindow: 2500 };
	const succeeded = await (await wrapped(smallModel, shortContext, { maxTokens: 512 })).result();
	assert.equal(succeeded.stopReason, "stop");
	assert.equal(calls, 1);
	await assert.rejects(
		async () => observedOptions?.onPayload?.({ messages: [{ content: "法".repeat(1600) }] }, smallModel),
		/中文上下文预算/,
	);
	const cancelled = await guardLegalCompaction(
		async () => {
			const result = await (await wrapped(model, longContext, { maxTokens: 4096 })).result();
			if (result.stopReason === "error") throw new Error(result.errorMessage);
			return result;
		},
		() => {},
	);
	assert.deepEqual(cancelled, { cancel: true });
});

test("only a final nonempty normal response completes; failed and truncated drafts remain incomplete", () => {
	for (const [reason, text, expected] of [
		["length", "半句辩护", "incomplete"],
		["aborted", "", "incomplete"],
		["error", "", "error"],
		["stop", "  ", "incomplete"],
		["stop", "完整回复", "complete"],
	] as const) {
		const outcome = new WebRunOutcome();
		outcome.observeAssistant(answer(reason, text));
		assert.equal(outcome.finish(new WebRunBudget()).state, expected);
	}
	assert.equal(new WebRunOutcome().finish(new WebRunBudget()).state, "incomplete");
});

test("successful model recovery supersedes old errors while an unsuccessful checkpoint prevents completion", () => {
	const outcome = new WebRunOutcome();
	const failed = answer("error", "");
	failed.errorMessage = "temporary socket drop";
	outcome.observeAssistant(failed);
	outcome.observeAssistant(answer());
	assert.equal(outcome.finish(new WebRunBudget()).state, "complete");
	outcome.observeCompaction("法律检查点失败", false);
	assert.equal(outcome.finish(new WebRunBudget()).state, "error");
	outcome.observeCompaction(undefined, true);
	assert.equal(outcome.finish(new WebRunBudget()).state, "complete");
});

test("a failed legal compaction explicitly cancels instead of allowing the SDK to use a generic fallback", async () => {
	let failure = "";
	const failed = await guardLegalCompaction(
		async () => {
			throw new Error("summary token cap");
		},
		(reason) => {
			failure = reason;
		},
	);
	assert.deepEqual(failed, { cancel: true });
	assert.match(failure, /summary token cap/);
	assert.match(failure, /全部对话和材料已保留/);
	const recovered = await guardLegalCompaction(
		async () => ({ summary: "事实、引用、分歧、待办" }),
		() => {
			assert.fail("Successful checkpoint must not call failure handler");
		},
	);
	assert.deepEqual(recovered, { compaction: { summary: "事实、引用、分歧、待办" } });
});

test("stable argument signatures, total calls, model rounds and elapsed time each stop further work", () => {
	const repeated = new WebRunBudget();
	repeated.observeTool("read", { source: "S001", line: 1 });
	repeated.observeTool("read", { line: 1, source: "S001" });
	repeated.observeTool("read", { source: "S001", line: 1 });
	assert.equal(repeated.completeTurn(), true);
	const many = new WebRunBudget();
	for (let line = 1; line <= WEB_RUN_LIMITS.toolCalls; line++) many.observeTool("read", { line });
	assert.equal(many.completeTurn(), true);
	const rounds = new WebRunBudget();
	for (let count = 0; count <= WEB_RUN_LIMITS.turns; count++) rounds.observeTurn();
	assert.ok(rounds.reason);
	const timed = new WebRunBudget(1);
	assert.equal(timed.completeTurn(WEB_RUN_LIMITS.timeMs + 1), true);
	assert.match(timed.reason ?? "", /未完成/);
});

test("an actual offline Agent loop stops repeated valid tool calls after three complete batches", async () => {
	const budget = new WebRunBudget();
	const outcome = new WebRunOutcome();
	let modelCalls = 0;
	let executions = 0;
	const agent = new Agent({
		initialState: {
			model,
			tools: [
				{
					name: "verify",
					label: "verify",
					description: "Offline repeat fixture",
					parameters: Type.Object({ source: Type.String() }),
					execute: async () => {
						executions++;
						return { content: [{ type: "text", text: "已核验" }], details: {} };
					},
				},
			],
		},
		streamFn: () => {
			modelCalls++;
			const message = answer("toolUse", "");
			message.content = [
				{ type: "toolCall", id: `call-${modelCalls}`, name: "verify", arguments: { source: "S001" } },
			];
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "done", reason: "toolUse", message });
			return stream;
		},
		shouldStopAfterTurn: () => budget.completeTurn(),
	});
	agent.subscribe((event) => {
		if (event.type === "turn_start") budget.observeTurn();
		if (event.type === "tool_execution_start") budget.observeTool(event.toolName, event.args);
		if (event.type === "message_end" && event.message.role === "assistant") outcome.observeAssistant(event.message);
	});
	await agent.prompt("离线核验循环");
	assert.equal(modelCalls, 3);
	assert.equal(executions, 3);
	assert.equal(agent.state.isStreaming, false);
	assert.equal(outcome.finish(budget).state, "incomplete");
	assert.match(outcome.finish(budget).reason ?? "", /反复调用/);
});
