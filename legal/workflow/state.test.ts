import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { saveKnowledgeSnapshot } from "../extensions/internal/rag-core.ts";
import workflow from "../extensions/legal-workflow.ts";
import {
	advanceCaseStage,
	buildCaseCheckpoint,
	readCaseState,
	saveCaseDraft,
	stageRequirements,
	summarizeCaseState,
	updateCaseState,
} from "./state.ts";
import type { CaseState, Stage } from "./types.ts";

const roots: string[] = [];
const ref = { source_id: "S001", start_line: 1, end_line: 1 };

function makeCase(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-legal-workflow-"));
	roots.push(root);
	const sourceDir = join(root, ".legalagent", "sources");
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(
		join(sourceDir, "manifest.json"),
		JSON.stringify({
			version: 1,
			sources: [
				{
					id: "S001",
					original_path: "../../原件.txt",
					processed_path: "S001.txt",
					sha256: "a".repeat(64),
					kind: "txt",
				},
			],
		}),
	);
	writeFileSync(
		join(sourceDir, "S001.txt"),
		"[p0001:L0001] 用户提供材料记载某事件，真实性待核。\n[p0001:L0002] 另一项材料记载。\n",
	);
	writeFileSync(join(root, "原件.txt"), "保持原件不变");
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		const actual = realpathSync.native(root);
		const delta = relative(realpathSync.native(tmpdir()), actual);
		assert.ok(delta.startsWith("pi-legal-workflow-") && !delta.includes(".."));
		rmSync(actual, { recursive: true, force: true });
	}
});

function update(
	root: string,
	section: "scope" | "facts" | "issues" | "laws" | "tasks" | "strategy",
	data: unknown,
): CaseState {
	return updateCaseState(root, readCaseState(root).revision, { section, data });
}

function advance(root: string, stage: Stage): CaseState {
	return advanceCaseStage(root, readCaseState(root).revision, stage);
}

function prepareDraft(root: string): CaseState {
	update(root, "scope", {
		objective: "形成有待核项的法律意见",
		jurisdiction: "中国大陆",
		procedure: "侦查阶段，待核",
		legalAsOf: "未指定，未核现行效力",
	});
	advance(root, "evidence");
	update(root, "facts", [
		{ id: "F1", kind: "recorded", text: "卷内材料记载事件；未证明真实性。", refs: [ref] },
		{ id: "F2", kind: "party_claim", text: "当事人称另有情形。", refs: [], note: "用户在本轮陈述，尚无原件。" },
	]);
	update(root, "issues", {
		id: "I1",
		question: "事件性质有争议",
		forFacts: ["F1"],
		againstFacts: ["F2"],
		gaps: ["缺完整原件与旁证"],
		analysis: "如果原件核实且无反证，可形成暂定判断；目前保持分歧。",
	});
	update(root, "tasks", { id: "T1", title: "核查原件和适用法律", status: "open" });
	advance(root, "analysis");
	update(root, "laws", {
		id: "L1",
		title: "拟检索相关法律依据",
		version: "版本待核",
		status: "pending",
		refs: [],
		note: "尚未完成权威来源检索，不使用模型记忆作为核验。",
	});
	advance(root, "strategy");
	update(root, "strategy", {
		primary: "先在核实事实的条件下提出主张。",
		alternative: "保留相反事实成立时的备选方案。",
		risks: "证据不足与法律适用时间待核。",
		conditions: "核查原件和现行效力后再决定提交内容。",
	});
	return advance(root, "draft");
}

const body =
	"# 法律意见草案\n\n## 事实与证据\n目前卷内文本记载某事件发生，当事人另有尚未取得原件的补充陈述。两者是否一致以及材料真实性仍然需要核查，不能先按法院已经认定填写。\n\n## 法律分析\n在原件核实且关键时间节点确认的条件下，可以围绕争点分析事件性质。若相反陈述取得可靠证据，应重新审查主张成立条件。目前法律文本版本及适用时间仍待检索，因此仅形成条件意见，不作确定结论。\n\n## 请求与结论\n建议先核查关键材料与适用依据，再由专业人员决定具体主张和提交内容。";

test("state survives fresh reads, partial updates preserve entities, original stays untouched", () => {
	const root = makeCase();
	assert.equal(readCaseState(root).revision, 0);
	const state = update(root, "scope", { objective: "接案目标" });
	assert.equal(state.revision, 1);
	assert.equal(readCaseState(root).scope.objective, "接案目标");
	update(root, "scope", { jurisdiction: "中国大陆" });
	assert.equal(readCaseState(root).scope.objective, "接案目标");
	update(root, "facts", { id: "F1", kind: "recorded", text: "材料记载", refs: [ref] });
	update(root, "facts", {
		id: "F2",
		kind: "inference",
		text: "需要核查",
		refs: [ref],
		note: "仅推论，原件真伪未核。",
	});
	assert.deepEqual(
		readCaseState(root).facts.map((fact) => fact.id),
		["F1", "F2"],
	);
	assert.match(readCaseState(root).facts[0].refs[0].text_sha256 ?? "", /^[a-f0-9]{64}$/);
	assert.equal(readFileSync(join(root, "原件.txt"), "utf8"), "保持原件不变");
	assert.ok(buildCaseCheckpoint(root).includes("recorded=卷内记载"));
});

test("stale concurrent revision fails without losing the first writer", () => {
	const root = makeCase();
	const revision = readCaseState(root).revision;
	updateCaseState(root, revision, { section: "scope", data: { objective: "第一个写者" } });
	assert.throws(
		() => updateCaseState(root, revision, { section: "scope", data: { objective: "第二个写者" } }),
		/revision 冲突/,
	);
	assert.equal(readCaseState(root).scope.objective, "第一个写者");
	assert.equal(readCaseState(root).revision, 1);
});

test("gates require work products, allow conditional plans, permit returning to earlier stage", () => {
	const root = makeCase();
	assert.throws(() => advance(root, "evidence"), /先记录目标/);
	assert.equal(readCaseState(root).revision, 0);
	update(root, "scope", { objective: "案情分析", jurisdiction: "待核", procedure: "待核", legalAsOf: "未指定" });
	assert.throws(() => advance(root, "strategy"), /逐阶段/);
	advance(root, "evidence");
	assert.throws(() => advance(root, "analysis"), /至少整理/);
	advance(root, "intake");
	prepareDraft(root);
	const draftState = readCaseState(root);
	assert.equal(draftState.stage, "draft");
	assert.throws(() => advance(root, "review"), /尚无已保存的草稿/);
	advance(root, "evidence");
	assert.equal(readCaseState(root).stage, "evidence");
	assert.equal(readCaseState(root).strategy.primary, draftState.strategy.primary);
});

test("invalid, truncated, changed, or missing source references cannot masquerade as recorded facts", () => {
	const root = makeCase();
	assert.throws(
		() => update(root, "facts", { id: "F1", kind: "recorded", text: "无证据", refs: [] }),
		/必须有材料引用/,
	);
	assert.throws(
		() =>
			update(root, "facts", { id: "F1", kind: "recorded", text: "伪造来源", refs: [{ ...ref, source_id: "S404" }] }),
		/未找到 source id/,
	);
	assert.throws(
		() => update(root, "facts", { id: "F1", kind: "recorded", text: "结束行越界", refs: [{ ...ref, end_line: 4 }] }),
		/结束行超出/,
	);
	assert.throws(
		() => update(root, "facts", { id: "F1", kind: "party_claim", text: "用户声称", refs: [] }),
		/说明是谁的说法/,
	);
	update(root, "facts", { id: "F1", kind: "recorded", text: "材料记载", refs: [ref] });
	writeFileSync(join(root, ".legalagent", "sources", "S001.txt"), "[p0001:L0001] 材料改写后的新内容。\n");
	assert.match(readCaseState(root).sourceWarnings.join(""), /引用段落已变更/);
	assert.ok(update(root, "scope", { objective: "修复期间可更新任务范围" }).sourceWarnings.length > 0);
	update(root, "facts", { id: "F1", kind: "recorded", text: "已重新读取新内容，真实性仍待核", refs: [ref] });
	assert.equal(readCaseState(root).sourceWarnings.length, 0);
	writeFileSync(join(root, ".legalagent", "sources", "manifest.json"), JSON.stringify({ version: 1, sources: [] }));
	assert.match(readCaseState(root).sourceWarnings.join(""), /未找到 source id/);
});

test("issue cross references and law status are constrained without adjudicating law", () => {
	const root = makeCase();
	assert.throws(() => update(root, "issues", { id: "I1", question: "问题", forFacts: ["F404"] }), /不存在的事实/);
	assert.throws(
		() => update(root, "laws", { id: "L1", title: "模型记忆", version: "未知", status: "checked", note: "已证明" }),
		/status 须为 pending/,
	);
	assert.throws(
		() =>
			update(root, "laws", {
				id: "L1",
				title: "已有条文",
				version: "",
				status: "provided",
				note: "文本已提供",
				refs: [ref],
			}),
		/须填写材料引用和版本/,
	);
	assert.throws(() => update(root, "tasks", { id: "T1", title: "核查法律", status: "done" }), /记录处理结果/);
});

test("drafts are immutable, stay pending professional review, and need disclosed gaps", () => {
	const root = makeCase();
	const state = prepareDraft(root);
	assert.throws(
		() =>
			saveCaseDraft(root, state.revision, {
				filename: "草案.md",
				title: "意见",
				content: body,
				refs: [ref],
				unresolved: [],
			}),
		/须在 unresolved/,
	);
	const saved = saveCaseDraft(root, state.revision, {
		filename: "意见-v1.md",
		title: "意见",
		content: body,
		refs: [ref],
		unresolved: ["原件真伪与法律版本待核"],
	});
	assert.equal(saved.drafts[0].reviewStatus, "awaiting_professional_review");
	assert.match(readFileSync(join(root, "outputs", "legalagent", "意见-v1.md"), "utf8"), /不代表事实已获法院认定/);
	assert.throws(
		() =>
			saveCaseDraft(root, saved.revision, {
				filename: "意见-v1.md",
				title: "覆盖",
				content: body,
				refs: [ref],
				unresolved: ["原件真伪与版本待核"],
			}),
		/拒绝覆盖/,
	);
	const reviewed = advance(root, "review");
	assert.equal(reviewed.stage, "review");
	assert.equal(reviewed.drafts[0].reviewStatus, "awaiting_professional_review");
	writeFileSync(join(root, "outputs", "legalagent", "意见-v1.md"), "被外部改变");
	assert.match(stageRequirements(root, readCaseState(root), "review").join(""), /内容已改变/);
	const newer = saveCaseDraft(root, readCaseState(root).revision, {
		filename: "意见-v2.md",
		title: "意见",
		content: body,
		refs: [ref],
		unresolved: ["专业人员复核法律及证据"],
	});
	assert.equal(newer.drafts.length, 2);
	assert.equal(advance(root, "review").stage, "review");
});

test("changed materials can be repaired entity by entity and new draft supersedes stale historical references", () => {
	const root = makeCase();
	const state = prepareDraft(root);
	update(root, "laws", {
		id: "L1",
		title: "用户提供法律文本",
		version: "用户说明版本待独立核查",
		status: "provided",
		refs: [ref],
		note: "仅已有文本，未完成现行效力核查。",
	});
	saveCaseDraft(root, readCaseState(root).revision, {
		filename: "草稿-v1.md",
		title: "意见",
		content: body,
		refs: [ref],
		unresolved: ["核对原件及法律版本"],
	});
	writeFileSync(
		join(root, ".legalagent", "sources", "S001.txt"),
		"[p0001:L0001] 重新导入的材料段落，仍待核真实性与适用范围。\n",
	);
	assert.ok(readCaseState(root).sourceWarnings.length > 0);
	update(root, "facts", { id: "F1", kind: "recorded", text: "已经重新读取新材料，尚未核实真伪。", refs: [ref] });
	assert.ok(
		readCaseState(root).sourceWarnings.length > 0,
		"Law and draft references remain stale, but fact repair is saved",
	);
	update(root, "laws", {
		id: "L1",
		title: "新法律文本需独立核查",
		version: "新文本版本待核",
		status: "provided",
		refs: [ref],
		note: "已重新定位文本，仍未独立核查现行效力。",
	});
	assert.throws(() => advance(root, "review"), /引用须修复/);
	const newer = saveCaseDraft(root, readCaseState(root).revision, {
		filename: "草稿-v2.md",
		title: "意见",
		content: body,
		refs: [ref],
		unresolved: ["原件真实性及适用范围仍待核"],
	});
	assert.equal(newer.sourceWarnings.length, 0);
	assert.equal(newer.drafts.length, 2);
	assert.equal(advance(root, "review").stage, "review");
	assert.ok(state.revision < newer.revision);
});

test("draft review rejects outlines and missing conclusions, while supporting common combined headings", () => {
	const root = makeCase();
	const state = prepareDraft(root);
	const input = { filename: "草稿.md", title: "草稿", refs: [ref], unresolved: ["核对原件真实性及适用依据版本"] };
	assert.throws(
		() =>
			saveCaseDraft(root, state.revision, {
				...input,
				content: "# 法律意见\n\n已经完成分析并形成意见。稍后可以补充事实、分析和结论，目前先保存这个文件。",
			}),
		/草稿结构不完整/,
	);
	assert.throws(
		() => saveCaseDraft(root, state.revision, { ...input, content: body.split("## 请求与结论")[0] }),
		/请求\/结论/,
	);
	const combined =
		"# 民事起诉状草案\n\n一、诉讼请求\n请求人民法院根据依法核查的材料审理争议，并对待确认的请求进行专业复核。\n\n二、事实与理由\n" +
		"目前已提供文本记载双方争议，具体原件真实性及法律适用尚待核查。在相关事实和适用规范确认后，应就主张成立条件与相反事实展开分析，并保留证据缺口对结论的影响。";
	const saved = saveCaseDraft(root, state.revision, { ...input, content: combined });
	assert.equal(saved.drafts.length, 1);
});

test("draft filenames and linked metadata/output directories cannot cross case boundary", (context) => {
	const root = makeCase();
	const state = prepareDraft(root);
	for (const filename of ["../原件.md", "D:\\越界.md", "outputs/草稿.md", "NUL.md", "草稿.txt"]) {
		assert.throws(
			() =>
				saveCaseDraft(root, state.revision, {
					filename,
					title: "意见",
					content: body,
					refs: [ref],
					unresolved: ["待核"],
				}),
			/普通 .md 文件名/,
		);
	}
	const outside = makeCase();
	try {
		symlinkSync(outside, join(root, "outputs"), "junction");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EPERM") {
			context.skip("Windows requires symlink permission");
			return;
		}
		throw error;
	}
	assert.throws(
		() =>
			saveCaseDraft(root, state.revision, {
				filename: "意见.md",
				title: "意见",
				content: body,
				refs: [ref],
				unresolved: ["原件真伪与版本待核"],
			}),
		/符号链接/,
	);
	const linked = makeCase();
	symlinkSync(outside, join(linked, ".legalagent", "workflow"), "junction");
	assert.throws(() => readCaseState(linked), /符号链接/);
});

test("malformed state is never silently replaced; summary is bounded", () => {
	const root = makeCase();
	const state = prepareDraft(root);
	const large = {
		...state,
		scope: { ...state.scope, objective: "长".repeat(600) },
		strategy: {
			primary: "主".repeat(2000),
			alternative: "备".repeat(1500),
			risks: "险".repeat(1500),
			conditions: "条".repeat(1500),
		},
	};
	assert.ok(summarizeCaseState(large).length <= 2500);
	writeFileSync(join(root, ".legalagent", "workflow", "state.json"), "{broken");
	assert.throws(() => readCaseState(root), /不是有效 JSON/);
	assert.throws(() => updateCaseState(root, 0, { section: "scope", data: { objective: "覆盖" } }), /不是有效 JSON/);
	assert.equal(readFileSync(join(root, ".legalagent", "workflow", "state.json"), "utf8"), "{broken");
});

test("extension injects checkpoint every turn and respects disabled draft writer", async () => {
	const root = makeCase();
	update(root, "scope", { objective: "跨轮保留目标" });
	const tools: string[] = [];
	let handler: ((event: unknown, ctx: { cwd: string }) => { message: { content: string } }) | undefined;
	workflow({
		registerTool: (definition: { name: string }) => {
			tools.push(definition.name);
		},
		getActiveTools: () => ["legal_case_status", "legal_case_update", "legal_case_advance"],
		on: (event: string, callback: typeof handler) => {
			if (event === "before_agent_start") handler = callback;
		},
	} as unknown as ExtensionAPI);
	assert.deepEqual(tools, ["legal_case_status", "legal_case_update", "legal_case_advance", "legal_draft_save"]);
	assert.ok(handler);
	const checkpoint = handler({}, { cwd: root }).message.content;
	assert.match(checkpoint, /跨轮保留目标/);
	assert.match(checkpoint, /未开启草稿写入/);
	assert.match(checkpoint, /不能.*review/);
});

test("shared loop guard stops only after a complete turn and resets for the next user request", () => {
	const root = makeCase();
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	const notices: { customType: string; content: string }[] = [];
	let aborts = 0;
	const context = {
		cwd: root,
		abort: () => {
			aborts++;
		},
	};
	workflow({
		registerTool: () => {},
		getActiveTools: () => ["legal_case_status"],
		sendMessage: (message: { customType: string; content: string }) => {
			notices.push(message);
		},
		on: (name: string, handler: (event: unknown, context: unknown) => unknown) => {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI);
	const call = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		assert.ok(handler);
		return handler(event, context);
	};
	call("before_agent_start");
	for (let index = 0; index < 3; index++)
		call("tool_result", { toolName: "legal_source_read", input: { source_id: "S001", start_line: 1, end_line: 1 } });
	assert.equal(aborts, 0, "Never abort in the middle of the tool batch");
	call("turn_end");
	assert.equal(aborts, 1);
	assert.equal(notices[0].customType, "legal-workflow-stopped");
	assert.match(notices[0].content, /工作未完成/);
	call("turn_end");
	assert.equal(aborts, 1, "Stop notice should not repeat");
	call("before_agent_start");
	call("turn_end");
	assert.equal(aborts, 1, "New user prompt resets counts");
	for (let index = 0; index < 24; index++)
		call("tool_result", {
			toolName: "legal_source_read",
			input: { source_id: "S001", start_line: index + 1, end_line: index + 1 },
		});
	assert.equal(aborts, 1);
	call("turn_end");
	assert.equal(aborts, 2);
	assert.match(notices[1].content, /24 次/);
});

test("external knowledge references support laws and drafts but cannot masquerade as this case's recorded facts", () => {
	const root = makeCase();
	const sourceId = saveKnowledgeSnapshot(
		root,
		{
			document_id: "law-test",
			text: "第一条 测试规范原文，适用性及效力仍须复核。",
			metadata: { title: "测试规范", version: "测试v1", jurisdiction: "测试法域" },
		},
		{ fingerprint: "test-index", as_of: "2026-10-07" },
	);
	const external = { source_id: sourceId, start_line: 1, end_line: 1 };
	assert.throws(
		() => update(root, "facts", { id: "F1", kind: "recorded", text: "从外部案例拼成的本案事实", refs: [external] }),
		/不是本案证据/,
	);
	prepareDraft(root);
	update(root, "laws", {
		id: "L1",
		title: "外部提供的测试规范",
		version: "测试v1",
		status: "provided",
		refs: [external],
		note: "来自知识库缓存，仅核验文本；适用性和效力待核。",
	});
	const state = readCaseState(root);
	assert.equal(state.laws[0].refs[0].source_id, sourceId);
	assert.match(state.laws[0].refs[0].text_sha256 ?? "", /^[a-f0-9]{64}$/);
	assert.equal(state.sourceWarnings.length, 0);
	assert.ok(
		summarizeCaseState(state).includes(sourceId),
		"The checkpoint must preserve an exact external source locator",
	);
	const saved = saveCaseDraft(root, state.revision, {
		filename: "知识库引用-v1.md",
		title: "知识库引用测试",
		content: body,
		refs: [ref, external],
		unresolved: ["原件真实性与法源适用时间仍待核"],
	});
	assert.equal(saved.drafts[0].refs[1].source_id, sourceId);
	assert.equal(advance(root, "review").stage, "review");
	const cache = join(root, ".legalagent", "rag", "sources", `${sourceId}.json`);
	const snapshot = JSON.parse(readFileSync(cache, "utf8"));
	snapshot.text = "篡改知识库缓存";
	writeFileSync(cache, JSON.stringify(snapshot));
	assert.match(readCaseState(root).sourceWarnings.join(""), /内容哈希不匹配/);
	assert.equal(
		advance(root, "draft").stage,
		"draft",
		"Backward moves remain available for repairing invalid references",
	);
	assert.throws(() => advance(root, "review"), /引用须修复|引用失效/);
});

test("registered law update failures show the actionable section schema without changing saved state", async () => {
	const root = makeCase();
	const state = update(root, "scope", { objective: "保留已有案件记录" });
	const path = join(root, ".legalagent", "workflow", "state.json");
	const before = readFileSync(path, "utf8");
	const tools: ToolDefinition[] = [];
	workflow({
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		on: () => {},
	} as unknown as ExtensionAPI);
	const tool = tools.find((tool) => tool.name === "legal_case_update");
	assert.ok(tool);
	for (const data of [
		JSON.stringify({
			id: "L1",
			name: "错误的平铺依据",
			source_id: "S001",
			start_line: 1,
			end_line: 1,
			status: "provided",
		}),
		JSON.stringify({
			id: "L1",
			title: "错误的引用容器",
			version: "测试v1",
			status: "provided",
			refs: ref,
			note: "效力待核",
		}),
		"{invalid-json",
	]) {
		await assert.rejects(
			tool.execute(
				"law-update",
				{ expected_revision: state.revision, section: "laws", data },
				undefined,
				undefined,
				{ cwd: root } as ExtensionContext,
			),
			(error) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /本次更新未保存/);
				assert.match(error.message, /laws=\{id,title,version,status/);
				assert.match(error.message, /refs:\[\{source_id,start_line,end_line\}\]/);
				assert.match(error.message, /refs必须是数组/);
				assert.match(error.message, /不要使用name/);
				assert.match(error.message, /平铺在实体顶层/);
				return true;
			},
		);
		assert.equal(readFileSync(path, "utf8"), before);
		assert.equal(readCaseState(root).revision, state.revision);
		assert.equal(readCaseState(root).laws.length, 0);
	}
});
