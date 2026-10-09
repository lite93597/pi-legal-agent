const connection = document.getElementById("connection");
const connectionText = document.getElementById("connection-text");
const casePath = document.getElementById("case-path");
const modelName = document.getElementById("model-name");
const ragStatus = document.getElementById("rag-status");
const retryConnection = document.getElementById("retry-connection");
const newChat = document.getElementById("new-chat");
const messages = document.getElementById("messages");
const emptyState = document.getElementById("empty-state");
const pageError = document.getElementById("page-error");
const chatForm = document.getElementById("chat-form");
const messageInput = document.getElementById("message-input");
const responseStatus = document.getElementById("response-status");
const sendButton = document.getElementById("send-button");
const stopButton = document.getElementById("stop-button");
const workflowPanel = document.getElementById("workflow-panel");
const workflowStage = document.getElementById("workflow-stage");
const workflowCounts = document.getElementById("workflow-counts");
const workflowTasks = document.getElementById("workflow-tasks");
const workflowDrafts = document.getElementById("workflow-drafts");
const workflowWarning = document.getElementById("workflow-warning");
const stageLabels = {
	intake: "接案",
	evidence: "证据整理",
	analysis: "依据与争点",
	strategy: "方案",
	draft: "文书起草",
	review: "审校交接",
};

const toolLabels = {
	legal_sources_list: "列出材料来源",
	legal_source_read: "读取材料",
	legal_citation_verify: "核验逐字引文",
	legal_retrieve: "检索法律与材料",
	read: "读取文件",
	grep: "搜索文本",
	find: "查找文件",
	ls: "列出目录",
	legal_case_status: "读取案件工作记录",
	legal_case_update: "保存案件工作记录",
	legal_case_advance: "检查并推进阶段",
	legal_draft_save: "保存文书草稿",
};

function makeConversationId() {
	if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let conversationId = makeConversationId();
let activeCaseDir = "";
let connected = false;
let busy = false;
let currentController = null;
let restoringRun = false;
let conversationStorageKey = "";

function rememberConversation() {
	if (!conversationStorageKey) return;
	const url = new URL(window.location.href);
	url.searchParams.set("conversation", conversationId);
	window.history.replaceState(null, "", url);
	try {
		localStorage.setItem(conversationStorageKey, conversationId);
	} catch {
		// The server still saves the conversation when browser storage is unavailable.
	}
}

function setConnection(state, label) {
	connection.classList.toggle("is-online", state === "online");
	connection.classList.toggle("is-offline", state === "offline");
	connectionText.textContent = label;
}

function setPageError(message) {
	pageError.textContent = message;
	pageError.hidden = !message;
}

function setResponseStatus(message, working = false) {
	if (responseStatus.textContent !== message) responseStatus.textContent = message;
	responseStatus.classList.toggle("is-working", working);
}

function updateControls() {
	messageInput.disabled = !connected || restoringRun;
	sendButton.disabled = !connected || busy || restoringRun;
	stopButton.hidden = !busy;
	newChat.disabled = busy || restoringRun;
	for (const button of document.querySelectorAll(".suggestion")) {
		button.disabled = !connected || busy || restoringRun;
	}
}

async function checkHealth() {
	connected = false;
	setConnection("checking", "正在检查服务");
	setResponseStatus("正在检查服务");
	retryConnection.hidden = true;
	updateControls();
	try {
		const response = await fetch("/api/health", { cache: "no-store" });
		const health = await response.json();
		activeCaseDir = typeof health.caseDir === "string" ? health.caseDir.trim() : "";
		casePath.textContent = activeCaseDir || "未指定案件目录";
		modelName.textContent = typeof health.model === "string" ? health.model : "未知";
		ragStatus.textContent = health.rag?.message || "检索服务状态未知";
		if (!activeCaseDir) throw new Error("案件目录尚未就绪，请检查网页启动命令。");
		conversationStorageKey = `legalagent:conversation:${activeCaseDir.toLowerCase()}`;
		const linkedId = new URLSearchParams(window.location.search).get("conversation");
		const linkedIdIsValid = linkedId && /^[a-zA-Z0-9_-]{8,80}$/.test(linkedId);
		if (linkedIdIsValid) conversationId = linkedId;
		try {
			const savedId = localStorage.getItem(conversationStorageKey);
			if (!linkedIdIsValid && savedId && /^[a-zA-Z0-9_-]{8,80}$/.test(savedId)) conversationId = savedId;
		} catch {
			// Browser storage is optional; case state remains on the local server.
		}
		rememberConversation();
		await restoreConversation();
		await refreshCaseState();
		if (!response.ok || health.ok !== true) {
			throw new Error(health.error || "本地模型尚未连接，案件记录和已保存对话仍可查看。");
		}
		connected = true;
		setConnection("online", "模型已连接");
		if (!restoringRun) {
			setResponseStatus("可以继续提问");
			if (health.rag?.state !== "ready") {
				retryConnection.textContent = "更新检索状态 ↗";
				retryConnection.hidden = false;
			}
		}
	} catch (error) {
		setConnection("offline", "模型未连接");
		setResponseStatus("连接服务后可以提问");
		setPageError(error instanceof Error ? error.message : "无法检查本地服务。");
		retryConnection.hidden = false;
	} finally {
		updateControls();
	}
}

async function refreshCaseState() {
	try {
		const response = await fetch("/api/case-state", { cache: "no-store" });
		if (!response.ok) throw new Error("未取得案件工作记录，请检查服务后重试。");
		const payload = await response.json();
		const state = payload.state;
		if (!state || typeof state !== "object") throw new Error("案件记录格式无效。");
		workflowStage.textContent = stageLabels[state.stage] || "待确认";
		const facts = Array.isArray(state.facts) ? state.facts : [];
		const issues = Array.isArray(state.issues) ? state.issues : [];
		const tasks = Array.isArray(state.tasks) ? state.tasks.filter((task) => task.status === "open") : [];
		workflowCounts.textContent = `事实记录 ${facts.length} · 争点 ${issues.length} · 待办 ${tasks.length}`;
		for (const button of document.querySelectorAll(".workflow-step")) {
			const current = button.dataset.stage === state.stage;
			button.classList.toggle("is-current", current);
			if (current) button.setAttribute("aria-current", "step");
			else button.removeAttribute("aria-current");
		}
		workflowTasks.replaceChildren();
		for (const task of tasks.slice(0, 5)) {
			const item = document.createElement("li");
			item.textContent = task.title;
			workflowTasks.append(item);
		}
		if (!tasks.length) {
			const item = document.createElement("li");
			item.textContent = "尚无待办记录，可从接案开始。";
			workflowTasks.append(item);
		}
		workflowDrafts.replaceChildren();
		const drafts = Array.isArray(state.drafts) ? state.drafts : [];
		for (const draft of drafts) {
			const item = document.createElement("li");
			const link = document.createElement("a");
			link.href = `/api/draft?filename=${encodeURIComponent(draft.filename)}`;
			link.textContent = draft.filename;
			link.title = draft.title;
			item.append(link);
			workflowDrafts.append(item);
		}
		if (!drafts.length) {
			const item = document.createElement("li");
			item.textContent = "尚未保存草稿。";
			workflowDrafts.append(item);
		}
		const warnings = Array.isArray(state.sourceWarnings) ? state.sourceWarnings : [];
		workflowWarning.textContent = warnings.slice(0, 3).join("；");
		workflowWarning.hidden = !warnings.length;
	} catch (error) {
		workflowCounts.textContent = "案件记录暂未更新";
		workflowWarning.textContent = error instanceof Error ? error.message : "无法读取案件工作记录。";
		workflowWarning.hidden = false;
	}
}

async function restoreConversation() {
	const response = await fetch(`/api/conversation?id=${encodeURIComponent(conversationId)}`, { cache: "no-store" });
	if (response.status === 404) {
		restoringRun = false;
		return;
	}
	if (!response.ok) throw new Error("对话恢复失败，请重新检查连接。");
	const saved = await response.json();
	const history = Array.isArray(saved.messages) ? saved.messages : [];
	messages.replaceChildren(emptyState);
	emptyState.hidden = history.length > 0;
	let lastAssistant = null;
	let lastUser = null;
	let hasTurnMetadata = false;
	const userDiagnostics = new Map();
	const assistantTurns = new Set();
	for (const message of history) {
		if (typeof message.text !== "string") continue;
		if (message.turn) hasTurnMetadata = true;
		if (message.role === "user") {
			lastUser = appendUserMessage(message.text);
			lastAssistant = null;
			if (message.turnId && message.turn)
				userDiagnostics.set(message.turnId, { view: lastUser, turn: message.turn });
		} else if (message.role === "assistant") {
			lastAssistant = appendAssistantMessage();
			lastAssistant.answer = message.text;
			renderAnswer(lastAssistant);
			if (message.turnId) assistantTurns.add(message.turnId);
			showTurnDiagnostic(lastAssistant, message.turn);
		}
	}
	for (const [turnId, diagnostic] of userDiagnostics)
		if (!assistantTurns.has(turnId)) showTurnDiagnostic(diagnostic.view, diagnostic.turn);
	restoringRun = saved.busy === true;
	if (restoringRun) {
		setResponseStatus("上一轮仍在处理，请更新会话状态");
		setPageError("上一轮正在服务端运行。等待完成后点击“更新会话状态”恢复结果。");
		retryConnection.textContent = "更新会话状态 ↗";
		retryConnection.hidden = false;
	} else {
		retryConnection.textContent = "重新检查连接 ↗";
		setPageError("");
		if (!hasTurnMetadata && saved.lastTurn && saved.lastTurn.state !== "complete") {
			showTurnDiagnostic(lastAssistant || lastUser || appendAssistantMessage(), saved.lastTurn);
		}
	}
	scrollToLatest(true);
}

function scrollToLatest(force = false) {
	const distance = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
	if (force || distance < 160) messages.scrollTop = messages.scrollHeight;
}

function appendUserMessage(text) {
	const article = document.createElement("article");
	article.className = "message message--user";
	const content = document.createElement("div");
	content.className = "message-content";
	const meta = document.createElement("div");
	meta.className = "message-meta";
	meta.textContent = "你";
	const body = document.createElement("div");
	body.className = "message-text";
	body.textContent = text;
	const error = document.createElement("div");
	error.className = "message-error";
	error.setAttribute("role", "alert");
	error.hidden = true;
	content.append(meta, body, error);
	article.append(content);
	messages.append(article);
	return { error, answer: text };
}

function appendAssistantMessage() {
	const article = document.createElement("article");
	article.className = "message message--assistant";
	const avatar = document.createElement("div");
	avatar.className = "message-avatar";
	avatar.setAttribute("aria-hidden", "true");
	avatar.textContent = "法";
	const content = document.createElement("div");
	content.className = "message-content";
	const meta = document.createElement("div");
	meta.className = "message-meta";
	meta.textContent = "LegalAgent";
	const body = document.createElement("div");
	body.className = "message-text";
	const placeholder = document.createElement("span");
	placeholder.className = "message-placeholder";
	placeholder.textContent = "正在连接模型…";
	body.append(placeholder);
	const toolLog = document.createElement("details");
	toolLog.className = "tool-log";
	toolLog.hidden = true;
	toolLog.open = true;
	const toolSummary = document.createElement("summary");
	toolSummary.textContent = "工具活动";
	const toolList = document.createElement("ul");
	toolList.className = "tool-list";
	toolLog.append(toolSummary, toolList);
	const error = document.createElement("div");
	error.className = "message-error";
	error.setAttribute("role", "alert");
	error.hidden = true;
	const notice = document.createElement("div");
	notice.className = "message-notice";
	notice.hidden = true;
	content.append(meta, body, toolLog, error, notice);
	article.append(avatar, content);
	messages.append(article);
	return { body, placeholder, toolLog, toolSummary, toolList, error, notice, tools: [], answer: "" };
}

function renderAnswer(view) {
	const citation = /(?:S\d{3,}|K_[a-f0-9]{64})\s*[,，]?\s*\[p\d{4,}:L\d{4,}(?:[-–]L?\d{4,})?\]/g;
	const parts = [];
	let offset = 0;
	for (const match of view.answer.matchAll(citation)) {
		if (match.index > offset) parts.push(document.createTextNode(view.answer.slice(offset, match.index)));
		const reference = document.createElement("span");
		reference.className = "source-reference";
		reference.textContent = match[0];
		parts.push(reference);
		offset = match.index + match[0].length;
	}
	parts.push(document.createTextNode(view.answer.slice(offset)));
	view.body.replaceChildren(...parts);
}

function describe(value) {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function startTool(view, event) {
	const name = typeof event.name === "string" ? event.name : "unknown";
	const toolCallId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : null;
	const item = document.createElement("li");
	item.className = "tool-item";
	const status = document.createElement("span");
	status.className = "tool-status";
	status.textContent = "进行中";
	const label = document.createElement("span");
	label.className = "tool-name";
	label.textContent = toolLabels[name] || name;
	item.append(status, label);
	const args = describe(event.args);
	if (args) {
		const argsNode = document.createElement("span");
		argsNode.className = "tool-args";
		argsNode.textContent = args;
		item.append(argsNode);
	}
	view.toolList.append(item);
	view.tools.push({ toolCallId, name, item, status, complete: false });
	view.toolLog.hidden = false;
	view.toolSummary.textContent = `工具活动 · ${view.tools.length}`;
	return view.tools.at(-1);
}

function finishTool(view, event) {
	const name = typeof event.name === "string" ? event.name : "unknown";
	const toolCallId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : null;
	const tool =
		[...view.tools]
			.reverse()
			.find((entry) => !entry.complete && (toolCallId ? entry.toolCallId === toolCallId : entry.name === name)) ||
		startTool(view, { name, toolCallId });
	tool.complete = true;
	tool.item.classList.add(event.isError === true ? "is-error" : "is-complete");
	tool.status.textContent = event.isError === true ? "失败" : "已完成";
	const output = describe(event.output);
	if (output) {
		const details = document.createElement("details");
		details.className = "tool-output";
		const summary = document.createElement("summary");
		summary.textContent = event.isError === true ? "查看失败详情" : "查看结果摘要";
		const pre = document.createElement("pre");
		pre.textContent = output;
		details.append(summary, pre);
		tool.item.append(details);
	}
}

function showMessageError(view, message) {
	view.error.textContent = message;
	view.error.hidden = false;
	if (!view.answer && view.placeholder) {
		view.placeholder.textContent = "本轮未完成。";
	}
}

function showTurnDiagnostic(view, turn) {
	if (!turn || (turn.state !== "incomplete" && turn.state !== "error")) return;
	const label = turn.state === "error" ? "本轮错误" : "本轮未完成";
	showMessageError(view, `${label}：${turn.reason || "内容已保留，可以继续处理；不能视为完整结果。"}`);
}

async function readChatStream(response, view) {
	if (!response.body) throw new Error("服务未返回对话流。");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let completed = false;
	let streamError = "";

	function processLine(line) {
		if (!line.trim()) return;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			throw new Error("服务返回了无法解析的对话数据。");
		}
		switch (event.type) {
			case "status":
				if (typeof event.message === "string") {
					setResponseStatus(event.message, true);
					if (!view.answer) view.placeholder.textContent = event.message;
				}
				break;
			case "delta":
				if (typeof event.text === "string" && event.text) {
					view.answer += event.text;
					renderAnswer(view);
					setResponseStatus("正在生成回答", true);
				}
				break;
			case "tool_start":
				startTool(view, event);
				setResponseStatus(event.name === "legal_retrieve" ? "正在检索法律与案件材料" : "正在查阅案件材料", true);
				if (!view.answer)
					view.placeholder.textContent =
						event.name === "legal_retrieve" ? "正在检索法律与案件材料…" : "正在查阅案件材料…";
				break;
			case "tool_end":
				finishTool(view, event);
				break;
			case "done":
				completed = true;
				break;
			case "diagnostic":
				if (event.phase === "settled" && event.state && event.state !== "complete") {
					streamError = event.reason || "本轮未完成，内容已保留，可以继续处理。";
				}
				break;
			case "error":
				streamError = typeof event.message === "string" ? event.message : "对话处理失败。";
				break;
			default:
				if (typeof event.error === "string") streamError = event.error;
		}
		scrollToLatest();
	}

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) processLine(line);
	}
	buffer += decoder.decode();
	if (buffer.trim()) processLine(buffer);
	if (streamError) throw new Error(streamError);
	if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）。`);
	if (!completed) throw new Error("对话连接提前中断，请检查模型服务后重试。");
	if (!view.answer) {
		view.placeholder.textContent = "本轮未生成文字回复。";
	}
}

chatForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	if (!connected || busy || restoringRun) return;
	const message = messageInput.value.trim();
	if (!message) return;
	busy = true;
	rememberConversation();
	currentController = new AbortController();
	updateControls();
	setPageError("");
	emptyState.hidden = true;
	appendUserMessage(message);
	const view = appendAssistantMessage();
	messageInput.value = "";
	setResponseStatus("正在发送问题", true);
	scrollToLatest(true);
	try {
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message, caseDir: activeCaseDir, conversationId }),
			signal: currentController.signal,
		});
		await readChatStream(response, view);
		setResponseStatus("回答完成");
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			if (!view.answer) view.placeholder.textContent = "已停止生成。";
			view.notice.textContent = "生成已停止。已有记录保留在本案中，可稍后继续当前对话。";
			view.notice.hidden = false;
			setResponseStatus("已停止生成；记录已保留");
		} else {
			showMessageError(view, error instanceof Error ? error.message : "对话处理失败。");
			setResponseStatus("本轮出错，可再次提问");
		}
	} finally {
		busy = false;
		currentController = null;
		updateControls();
		await refreshCaseState();
		scrollToLatest();
	}
});

stopButton.addEventListener("click", () => currentController?.abort());
window.addEventListener("pagehide", () => currentController?.abort());

messageInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		if (!busy && !restoringRun && connected) chatForm.requestSubmit();
	}
});

newChat.addEventListener("click", () => {
	if (busy || restoringRun) return;
	conversationId = makeConversationId();
	rememberConversation();
	emptyState.hidden = false;
	messages.replaceChildren(emptyState);
	setPageError("");
	setResponseStatus("新对话已开始");
	void refreshCaseState();
	messageInput.focus();
});

retryConnection.addEventListener("click", checkHealth);

for (const button of document.querySelectorAll(".suggestion")) {
	button.addEventListener("click", () => {
		messageInput.value = button.dataset.prompt || "";
		messageInput.focus();
	});
}

if (window.matchMedia("(max-width: 700px)").matches) workflowPanel.open = false;
checkHealth();
