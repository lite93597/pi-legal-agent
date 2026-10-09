import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentMessage } from "../../packages/agent/src/types.ts";
import { getCurrentSystemMessage } from "../../packages/ai/src/utils/transcript.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { readCaseState } from "../workflow/state.ts";
import { estimateLegalTextTokens, type WebTurnResult } from "./runtime.ts";

const turnEntryType = "legal-web-turn";
const requestEntryType = "legal-web-request";

export interface WebConversationMessage {
	role: "user" | "assistant";
	text: string;
	timestamp: number;
	turnId?: string;
	turn?: WebTurnResult;
}

export interface WebContextRecovery {
	summary: string;
	leafId: string | null;
	tokensBefore: number;
	messages: AgentMessage[];
	details: {
		kind: "case-state-only";
		revision: number;
		stage: string;
		reason: string;
		pendingRequest: string;
		archive: { path: string; throughLine: number; sha256: string };
	};
}

function validateSessionFile(file: string): void {
	if (!existsSync(file)) return;
	const lines = readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim());
	for (const [index, line] of lines.entries()) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`会话存档第 ${index + 1} 行损坏，原文件已保留，拒绝静默丢弃后恢复`);
		}
		if (!value || typeof value !== "object" || !("type" in value) || (index === 0 && value.type !== "session")) {
			throw new Error("会话存档格式无效，原文件已保留");
		}
	}
}

function assertSessionStorage(manager: SessionManager): void {
	const file = manager.getSessionFile();
	if (!file || !file.endsWith(".jsonl")) throw new Error("会话没有有效的本地存档路径");
	const expected = sessionPaths(manager.getCwd(), basename(file, ".jsonl"), false).file;
	if (file !== expected) throw new Error("会话存档路径越界");
}

export function validConversationId(id: string): boolean {
	return /^[a-zA-Z0-9_-]{8,80}$/.test(id);
}

/** Reject junctions and symlinks in web metadata paths before either reading or writing. */
function sessionPaths(caseDir: string, id: string, create: boolean): { directory: string; file: string } {
	if (!validConversationId(id)) throw new Error("会话 ID 无效");
	const root = realpathSync.native(caseDir);
	const finalDirectory = join(root, ".legalagent", "web-sessions");
	let directory = root;
	for (const part of [".legalagent", "web-sessions"]) {
		directory = join(directory, part);
		if (!existsSync(directory)) {
			if (!create) return { directory: finalDirectory, file: join(finalDirectory, `${id}.jsonl`) };
			mkdirSync(directory);
		}
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("会话存储目录不能是链接或普通文件");
	}
	const file = join(directory, `${id}.jsonl`);
	if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) {
		throw new Error("会话存储文件不能是链接或目录");
	}
	return { directory, file };
}

export function openWebSession(caseDir: string, id: string): SessionManager {
	const { directory, file } = sessionPaths(caseDir, id, true);
	// Opening an existing empty file lets the SDK flush the header immediately,
	// so an interrupted first request still preserves its user message.
	if (!existsSync(file)) writeFileSync(file, "", { flag: "wx" });
	validateSessionFile(file);
	return SessionManager.open(file, directory, caseDir);
}

export function saveWebTurn(manager: SessionManager, result: WebTurnResult): void {
	assertSessionStorage(manager);
	manager.appendCustomEntry(turnEntryType, result);
}

export function saveWebRequest(manager: SessionManager, text: string): void {
	assertSessionStorage(manager);
	manager.appendCustomEntry(requestEntryType, { text, timestamp: Date.now() });
}

export function saveWebCheckpointFailure(manager: SessionManager, reason: string): void {
	assertSessionStorage(manager);
	manager.appendCustomEntry("legal-web-checkpoint-failure", { reason, timestamp: Date.now() });
}

/** A whole completed tool batch can be archived; outstanding tool calls must remain visible. */
function assertFinishedToolBatches(messages: AgentMessage[]): void {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			if (pending.size) throw new Error("上一工具批仍有未返回结果，不能用状态检查点恢复。");
			for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
		} else if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) throw new Error("工具历史存在无对应调用的结果，拒绝恢复窗口。");
		}
	}
	if (pending.size) throw new Error("仍有工具调用未返回结果，不能用状态检查点恢复。");
}

/** This is a state restoration notice, deliberately not a fabricated summary of archived evidence. */
export function prepareWebContextRecovery(
	manager: SessionManager,
	pendingRequest: string,
	reason: string,
): WebContextRecovery {
	assertSessionStorage(manager);
	const state = readCaseState(manager.getCwd());
	if (state.revision < 1) throw new Error("尚无已保存的合法案件状态，无法用状态检查点恢复；原历史已保留。");
	const messages = manager.buildSessionContext().messages;
	assertFinishedToolBatches(messages);
	const file = manager.getSessionFile();
	if (!file) throw new Error("缺少法律会话原始存档，拒绝恢复。");
	validateSessionFile(file);
	const contents = readFileSync(file, "utf8");
	const archive = {
		path: `.legalagent/web-sessions/${basename(file)}`,
		throughLine: contents.split("\n").length - (contents.endsWith("\n") ? 1 : 0),
		sha256: createHash("sha256").update(contents).digest("hex"),
	};
	const requests = manager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === requestEntryType);
	const previous = requests.length > 1 ? requests[requests.length - 2] : undefined;
	const previousText =
		previous?.type === "custom" &&
		previous.data &&
		typeof previous.data === "object" &&
		"text" in previous.data &&
		typeof previous.data.text === "string"
			? previous.data.text
			: "无可用的上一请求文本；必要时查原历史或向用户补充确认。";
	const briefRequest =
		previousText.length > 700 ? `${previousText.slice(0, 700)}…（仅节选，完整需求见历史）` : previousText;
	const briefPending =
		pendingRequest.length > 700 ? `${pendingRequest.slice(0, 700)}…（仅节选，须读取完整请求）` : pendingRequest;
	const summary = [
		"# 法律案件状态恢复声明（不是完整对话摘要）",
		"上一模型上下文已超过预算，常规法律摘要未能提供可用窗口。已完成工具批的原消息和结果移出本次模型窗口，全部原文仍保存在同一会话 JSONL 和网页历史；没有删除证据。",
		`仅从合法持久状态恢复：revision ${state.revision}，阶段 ${state.stage}；范围/事实/争点/依据/任务/方案/草稿记录位于 .legalagent/workflow/state.json。最新案件状态摘要会随当前请求提供；完整实体、事实类别、出处、正反理由和待核事项须通过 legal_case_status 分页读取。`,
		"此声明没有概括未登记到状态的历史内容。不得把恢复当作已核实事实、已完成检索或已完成任务；未登记的陈述、证据、修正、分歧和任务仍须从原历史/原材料读取，或请用户补充。",
		`原历史：${archive.path}，恢复前物理行 1–${archive.throughLine}；read 工具可按 offset/limit 小批读取，不能一次回灌整份长记录。`,
		`上一用户请求（仅用于提醒可能未完成的任务）：${briefRequest}`,
		`当前尚未完成请求：${briefPending}`,
		`该请求完整文本已保存于 ${archive.path} 物理行 ${archive.throughLine + 1} 的 recovery metadata.pendingRequest；若窗口恢复后曾中断且用户只说“继续”，先核对该完整请求。正常本轮会继续按原文提交；不能仅因恢复窗口就宣告完成。`,
	].join("\n\n");
	const system = getCurrentSystemMessage(messages);
	return {
		summary,
		leafId: manager.getLeafId(),
		tokensBefore: estimateLegalTextTokens(JSON.stringify(messages)),
		messages: [
			...(system ? [system] : []),
			{ role: "compactionSummary", summary, tokensBefore: 0, timestamp: Date.now() },
		],
		details: {
			kind: "case-state-only",
			revision: state.revision,
			stage: state.stage,
			reason,
			pendingRequest,
			archive,
		},
	};
}

/** Append a real boundary after the completed batch, preserving every original entry and UI message. */
export function appendWebContextRecovery(manager: SessionManager, recovery: WebContextRecovery): AgentMessage[] {
	assertSessionStorage(manager);
	if (manager.getLeafId() !== recovery.leafId) throw new Error("会话在恢复准备后已改变，请重新计算恢复窗口。");
	const state = readCaseState(manager.getCwd());
	if (state.revision !== recovery.details.revision) throw new Error("案件状态在恢复准备后已改变，请重读状态。");
	const markerId = manager.appendCustomEntry("legal-web-context-recovery", recovery.details);
	manager.appendCompaction(recovery.summary, markerId, recovery.tokensBefore, recovery.details, true);
	return manager.buildSessionContext().messages;
}

export function readWebConversation(
	caseDir: string,
	id: string,
	active?: SessionManager,
	busy = false,
): {
	conversationId: string;
	busy: boolean;
	messages: WebConversationMessage[];
	lastTurn: WebTurnResult | null;
} {
	const messages: WebConversationMessage[] = [];
	let lastTurn: WebTurnResult | null = null;
	let currentTurnId: string | undefined;
	let lastTurnId: string | undefined;
	const turns = new Map<string, WebTurnResult>();
	const { directory, file } = sessionPaths(caseDir, id, false);
	validateSessionFile(file);
	const manager = active ?? (existsSync(file) ? SessionManager.open(file, directory, caseDir) : undefined);
	const branch = manager?.getBranch() ?? [];
	const hasDisplayRequests = branch.some((entry) => entry.type === "custom" && entry.customType === requestEntryType);
	for (const entry of branch) {
		if (
			entry.type === "custom" &&
			entry.customType === requestEntryType &&
			entry.data &&
			typeof entry.data === "object" &&
			"text" in entry.data &&
			typeof entry.data.text === "string"
		) {
			currentTurnId = entry.id;
			messages.push({
				role: "user",
				text: entry.data.text,
				timestamp: new Date(entry.timestamp).getTime(),
				turnId: currentTurnId,
			});
		}
		if (
			entry.type === "custom" &&
			entry.customType === turnEntryType &&
			entry.data &&
			typeof entry.data === "object" &&
			"state" in entry.data
		) {
			const data = entry.data as WebTurnResult;
			if (["running", "complete", "incomplete", "error"].includes(data.state)) {
				lastTurn = data;
				lastTurnId = currentTurnId;
				if (currentTurnId) turns.set(currentTurnId, data);
			}
		}
		if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) continue;
		const message = entry.message;
		if (hasDisplayRequests && message.role === "user") continue;
		if (message.role === "user") currentTurnId = entry.id;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("");
		if (text.trim()) messages.push({ role: message.role, text, timestamp: message.timestamp, turnId: currentTurnId });
	}
	for (const [turnId, turn] of turns) {
		if (turn.state === "running" && (!busy || turnId !== currentTurnId))
			turns.set(turnId, {
				...turn,
				state: "incomplete",
				reason: "服务曾在本轮结束前中断，已恢复保存的对话；本轮尚未完成。",
			});
	}
	for (const message of messages) if (message.turnId) message.turn = turns.get(message.turnId);
	if (lastTurnId) lastTurn = turns.get(lastTurnId) ?? lastTurn;
	else if (!busy && lastTurn?.state === "running")
		lastTurn = { ...lastTurn, state: "incomplete", reason: "服务曾在本轮结束前中断；本轮尚未完成。" };
	return { conversationId: id, busy, messages, lastTurn };
}

/** Download only registered, unchanged drafts in the fixed output directory. */
export function readRegisteredDraft(
	caseDir: string,
	draft: { filename: string; path: string; sha256: string },
): Buffer {
	if (
		!/^[\p{L}\p{N}_-][\p{L}\p{N} _.-]*\.md$/u.test(draft.filename) ||
		draft.path !== `outputs/legalagent/${draft.filename}`
	) {
		throw new Error("草稿登记路径无效");
	}
	let directory = realpathSync.native(caseDir);
	for (const part of ["outputs", "legalagent"]) {
		directory = join(directory, part);
		const item = lstatSync(directory);
		if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("草稿目录不能是链接或普通文件");
	}
	const file = join(directory, draft.filename);
	const item = lstatSync(file);
	if (!item.isFile() || item.isSymbolicLink() || statSync(file).size > 128 * 1024)
		throw new Error("草稿文件不能是链接、目录或超长文件");
	const body = readFileSync(file);
	if (createHash("sha256").update(body).digest("hex") !== draft.sha256)
		throw new Error("草稿内容已改变，须重新登记新版本后下载");
	return body;
}
