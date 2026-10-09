import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmdirSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "../../packages/ai/src/types.ts";
import { prepareCompaction } from "../../packages/coding-agent/src/core/compaction/compaction.ts";
import { updateCaseState } from "../workflow/state.ts";
import {
	appendWebContextRecovery,
	openWebSession,
	prepareWebContextRecovery,
	readRegisteredDraft,
	readWebConversation,
	saveWebCheckpointFailure,
	saveWebRequest,
	saveWebTurn,
} from "./runtime-store.ts";

function fixtureToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "事实已记录，接案任务尚未完成。" },
			{ type: "toolCall", id: "long-batch", name: "legal_case_status", arguments: { section: "facts" } },
		],
		api: "openai-completions",
		provider: "offline",
		model: "offline-legal",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 2,
	};
}

function seedWorkflow(root: string): void {
	updateCaseState(root, 0, {
		section: "scope",
		data: {
			objective: "接案并准备条件辩护",
			jurisdiction: "中国大陆",
			procedure: "二审",
			legalAsOf: "案发时，待核版本",
		},
	});
}

function cleanRecoveryFixture(root: string, id: string): void {
	for (const file of [
		join(root, ".legalagent", "web-sessions", `${id}.jsonl`),
		join(root, ".legalagent", "workflow", "state.json"),
	])
		if (existsSync(file)) unlinkSync(file);
	for (const directory of [
		join(root, ".legalagent", "web-sessions"),
		join(root, ".legalagent", "workflow"),
		join(root, ".legalagent"),
		root,
	])
		if (existsSync(directory)) rmdirSync(directory);
}

test("an unsplittable first long tool batch recovers by persisted state and retains the full same-ID transcript", () => {
	const root = mkdtempSync(join(tmpdir(), "legal-web-recovery-"));
	const id = "single-turn-recovery";
	try {
		seedWorkflow(root);
		const manager = openWebSession(root, id);
		saveWebRequest(manager, "从头处理案件，先完成接案任务");
		manager.appendMessage({ role: "user", content: "接案请求", timestamp: 1 });
		manager.appendMessage(fixtureToolCall());
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "long-batch",
			toolName: "legal_case_status",
			content: [{ type: "text", text: "卷".repeat(9000) }],
			isError: false,
			timestamp: 3,
		});
		saveWebTurn(manager, { state: "incomplete", startedAt: 1, endedAt: 4, reason: "上下文预算停止" });
		assert.equal(
			prepareCompaction(manager.getBranch(), { enabled: true, reserveTokens: 8192, keepRecentTokens: 1500 }),
			undefined,
		);
		const pending = "继续登记三个待办并推进到证据阶段，保留已记录事实";
		saveWebRequest(manager, pending);
		saveWebTurn(manager, { state: "running", startedAt: 5 });
		const file = manager.getSessionFile();
		assert.ok(file);
		const original = readFileSync(file, "utf8");
		const before = readWebConversation(root, id).messages;
		saveWebCheckpointFailure(manager, "Nothing to compact (session too small)");
		const recovery = prepareWebContextRecovery(manager, pending, "SDK 无可用切点");
		assert.match(recovery.summary, /不是完整对话摘要/);
		assert.match(recovery.summary, /未登记.*须从原历史/);
		assert.match(recovery.summary, /接案任务/);
		assert.ok(recovery.summary.includes(pending));
		assert.equal(recovery.details.pendingRequest, pending);
		assert.equal(recovery.details.revision, 1);
		const context = appendWebContextRecovery(manager, recovery);
		assert.equal(
			context.some((message) => message.role === "toolResult" || message.role === "assistant"),
			false,
		);
		assert.ok(context.some((message) => message.role === "compactionSummary"));
		assert.ok(readFileSync(file, "utf8").startsWith(original));
		assert.deepEqual(readWebConversation(root, id).messages, before);
		const reopened = openWebSession(root, id);
		assert.equal(reopened.getSessionId(), manager.getSessionId());
		const restoredSummary = reopened
			.buildSessionContext()
			.messages.find((message) => message.role === "compactionSummary");
		assert.ok(restoredSummary && restoredSummary.role === "compactionSummary");
		assert.ok(restoredSummary.summary.includes(pending));
		assert.ok(reopened.getBranch().some((entry) => entry.type === "message" && entry.message.role === "toolResult"));
		assert.ok(
			reopened
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "legal-web-checkpoint-failure"),
		);
		assert.deepEqual(readWebConversation(root, id).messages, before);
	} finally {
		cleanRecoveryFixture(root, id);
	}
});

test("state recovery refuses an unrecorded case and an unfinished tool batch without changing the archive", () => {
	const root = mkdtempSync(join(tmpdir(), "legal-web-recovery-refuse-"));
	const id = "refuse-recovery";
	try {
		const manager = openWebSession(root, id);
		const file = manager.getSessionFile();
		assert.ok(file);
		const original = readFileSync(file, "utf8");
		assert.throws(() => prepareWebContextRecovery(manager, "继续", "无切点"), /尚无已保存/);
		assert.equal(readFileSync(file, "utf8"), original);
		seedWorkflow(root);
		manager.appendMessage(fixtureToolCall());
		const unfinished = readFileSync(file, "utf8");
		assert.throws(() => prepareWebContextRecovery(manager, "继续", "无切点"), /工具调用未返回/);
		assert.equal(readFileSync(file, "utf8"), unfinished);
	} finally {
		cleanRecoveryFixture(root, id);
	}
});

test("SDK disk sessions preserve an interrupted first request and restore UI text after reopening", () => {
	const root = mkdtempSync(join(tmpdir(), "legal-web-session-"));
	const id = "offline-session-01";
	const file = join(root, ".legalagent", "web-sessions", `${id}.jsonl`);
	try {
		const manager = openWebSession(root, id);
		saveWebRequest(manager, "家属提交接案请求");
		saveWebTurn(manager, { state: "running", startedAt: 1 });
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "展开后的内部模板" }], timestamp: 2 });
		assert.match(readFileSync(file, "utf8"), /家属提交接案请求/);
		const restored = readWebConversation(root, id);
		assert.equal(restored.messages.length, 1);
		assert.equal(restored.messages[0].text, "家属提交接案请求");
		assert.equal(restored.lastTurn?.state, "incomplete");
		const reopened = openWebSession(root, id);
		assert.equal(reopened.getSessionId(), manager.getSessionId());
		saveWebTurn(reopened, {
			state: "incomplete",
			startedAt: 1,
			endedAt: 3,
			stopReason: "length",
			reason: "文书被截断",
		});
		assert.equal(readWebConversation(root, id).lastTurn?.stopReason, "length");
		assert.throws(() => openWebSession(root, "../outside"), /会话 ID/);
	} finally {
		unlinkSync(file);
		rmdirSync(join(root, ".legalagent", "web-sessions"));
		rmdirSync(join(root, ".legalagent"));
		rmdirSync(root);
	}
});

test("historical length and textless failures keep their own diagnostics after a later successful turn and reload", () => {
	for (const withPartialAnswer of [true, false]) {
		const root = mkdtempSync(join(tmpdir(), "legal-web-turn-history-"));
		const id = withPartialAnswer ? "history-length-turn" : "history-empty-error";
		try {
			const manager = openWebSession(root, id);
			saveWebRequest(manager, "第一轮请求");
			const firstTurnId = manager.getLeafId();
			saveWebTurn(manager, { state: "running", startedAt: 1 });
			if (withPartialAnswer) {
				const partial = fixtureToolCall();
				partial.content = [{ type: "text", text: "原有回答片段，原文保留。" }];
				partial.stopReason = "length";
				manager.appendMessage(partial);
			}
			const firstFailure = withPartialAnswer
				? { state: "incomplete" as const, stopReason: "length" as const, reason: "回答达到输出上限，被截断。" }
				: { state: "error" as const, reason: "预压缩失败，没有生成正文。" };
			saveWebTurn(manager, { ...firstFailure, startedAt: 1, endedAt: 3 });
			saveWebRequest(manager, "第二轮继续请求");
			const secondTurnId = manager.getLeafId();
			saveWebTurn(manager, { state: "running", startedAt: 4 });
			const complete = fixtureToolCall();
			complete.content = [{ type: "text", text: "第二轮完整回复。" }];
			complete.stopReason = "stop";
			complete.timestamp = 5;
			manager.appendMessage(complete);
			saveWebTurn(manager, { state: "complete", stopReason: "stop", startedAt: 4, endedAt: 6 });
			const file = manager.getSessionFile();
			assert.ok(file);
			const original = readFileSync(file, "utf8");
			const restored = readWebConversation(root, id);
			const firstMessages = restored.messages.filter((message) => message.turnId === firstTurnId);
			assert.equal(firstMessages.length, withPartialAnswer ? 2 : 1);
			assert.equal(firstMessages[0].role, "user");
			for (const message of firstMessages) {
				assert.equal(message.turn?.state, firstFailure.state);
				assert.equal(message.turn?.reason, firstFailure.reason);
				assert.equal(message.turn?.stopReason, withPartialAnswer ? "length" : undefined);
			}
			const secondMessages = restored.messages.filter((message) => message.turnId === secondTurnId);
			assert.equal(secondMessages.length, 2);
			assert.ok(secondMessages.every((message) => message.turn?.state === "complete"));
			assert.equal(restored.lastTurn?.state, "complete");
			assert.equal(restored.messages.at(-1)?.text, "第二轮完整回复。");
			assert.deepEqual(readWebConversation(root, id, openWebSession(root, id)).messages, restored.messages);
			assert.equal(readFileSync(file, "utf8"), original);
		} finally {
			cleanRecoveryFixture(root, id);
		}
	}
});

test("unknown conversation reads empty without creating storage directories", () => {
	const root = mkdtempSync(join(tmpdir(), "legal-web-empty-"));
	try {
		assert.deepEqual(readWebConversation(root, "unknown-session").messages, []);
	} finally {
		rmdirSync(root);
	}
});

test("a damaged transcript is preserved and rejected instead of silently reopening with missing evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "legal-web-corrupt-"));
	const id = "damaged-session";
	const manager = openWebSession(root, id);
	const file = manager.getSessionFile();
	assert.ok(file);
	const body = `${readFileSync(file, "utf8")}{"type":"message", unfinished\n`;
	writeFileSync(file, body);
	try {
		assert.throws(() => openWebSession(root, id), /损坏/);
		assert.equal(readFileSync(file, "utf8"), body);
	} finally {
		unlinkSync(file);
		rmdirSync(join(root, ".legalagent", "web-sessions"));
		rmdirSync(join(root, ".legalagent"));
		rmdirSync(root);
	}
});

test("registered drafts require unchanged content and refuse traversal", () => {
	const root = mkdtempSync(join(tmpdir(), "legal-web-draft-"));
	const outputs = join(root, "outputs");
	const directory = join(outputs, "legalagent");
	const filename = "辩护草案-v1.md";
	const file = join(directory, filename);
	mkdirSync(outputs);
	mkdirSync(directory);
	writeFileSync(file, "# 待专业审阅草案\n");
	const body = readFileSync(file);
	const draft = {
		filename,
		path: `outputs/legalagent/${filename}`,
		sha256: createHash("sha256").update(body).digest("hex"),
	};
	try {
		assert.deepEqual(readRegisteredDraft(root, draft), body);
		assert.throws(() => readRegisteredDraft(root, { ...draft, filename: "../secret.md" }), /路径无效/);
		writeFileSync(file, "内容改变");
		assert.throws(() => readRegisteredDraft(root, draft), /内容已改变/);
	} finally {
		unlinkSync(file);
		rmdirSync(directory);
		rmdirSync(outputs);
		rmdirSync(root);
	}
});

test("junctions in either metadata parent or draft parent are rejected", (t) => {
	const root = mkdtempSync(join(tmpdir(), "legal-web-link-"));
	const outside = mkdtempSync(join(tmpdir(), "legal-web-outside-"));
	const link = join(root, ".legalagent");
	const outputLink = join(root, "outputs");
	let metadataLinked = false;
	let draftLinked = false;
	try {
		try {
			symlinkSync(outside, link, "junction");
			metadataLinked = true;
			symlinkSync(outside, outputLink, "junction");
			draftLinked = true;
		} catch {
			t.diagnostic("This environment does not allow junction fixture creation");
		}
		if (metadataLinked) assert.throws(() => openWebSession(root, "offline-session-02"), /链接/);
		if (draftLinked)
			assert.throws(
				() =>
					readRegisteredDraft(root, {
						filename: "sample.md",
						path: "outputs/legalagent/sample.md",
						sha256: "a".repeat(64),
					}),
				/链接/,
			);
	} finally {
		if (metadataLinked) unlinkSync(link);
		if (draftLinked) unlinkSync(outputLink);
		rmdirSync(root);
		rmdirSync(outside);
	}
});
