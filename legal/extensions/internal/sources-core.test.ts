import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import legalSources from "../legal-sources.ts";
import { isOutputPath, loadSources, readSource, verifyQuote } from "./sources-core.ts";

const cases: string[] = [];

function makeCase(processedPath = "processed/source.txt", metadata: Record<string, unknown> = {}): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-legal-sources-"));
	cases.push(cwd);
	const sourceDir = join(cwd, ".legalagent", "sources");
	mkdirSync(join(sourceDir, "processed"), { recursive: true });
	writeFileSync(
		join(sourceDir, "manifest.json"),
		JSON.stringify({
			version: 1,
			sources: [
				{
					id: "contract-1",
					original_path: "原件/合同.pdf",
					processed_path: processedPath,
					sha256: "a".repeat(64),
					kind: "pdf",
					...metadata,
				},
			],
		}),
	);
	writeFileSync(
		join(sourceDir, "processed", "source.txt"),
		"[p0001:L0001] 甲方应于十日内付款。\n[p0001:L0002] 乙方收到款项后交付货物。\n",
	);
	return cwd;
}

afterEach(() => {
	for (const cwd of cases.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

test("lists, reads, and verifies exact case citations", () => {
	const cwd = makeCase();
	assert.deepEqual(
		loadSources(cwd).map((source) => source.id),
		["contract-1"],
	);
	assert.deepEqual(readSource(cwd, "contract-1", 2, 2), {
		source_id: "contract-1",
		source: loadSources(cwd)[0],
		total_lines: 2,
		lines: [{ line: 2, ref: "p0001:L0002", text: "乙方收到款项后交付货物。" }],
	});
	assert.deepEqual(verifyQuote(cwd, "contract-1", "十日内付款"), {
		source_id: "contract-1",
		found: true,
		count: 1,
		locations: [
			{
				start_ref: "p0001:L0001",
				end_ref: "p0001:L0001",
				start_line: 1,
				end_line: 1,
				start_column: 5,
				end_column: 9,
			},
		],
		truncated: false,
	});
	const acrossLines = verifyQuote(cwd, "contract-1", "付款。\n乙方");
	assert.equal(acrossLines.found, true);
	assert.equal(acrossLines.locations[0].start_ref, "p0001:L0001");
	assert.equal(acrossLines.locations[0].end_ref, "p0001:L0002");
	assert.equal(verifyQuote(cwd, "contract-1", "应于三日内付款").found, false);
});

test("retains extraction warnings and distinguishes physical and synthetic page references", () => {
	const quality = {
		bytes: 1024,
		page_count: 3,
		page_numbering: "physical_pdf",
		line_count: 2,
		ocr_status: "not_performed",
		pages_without_extractable_text: [2, 3],
		warnings: ["PDF 第 2, 3 页没有可提取文字；未执行 OCR"],
	};
	const cwd = makeCase("processed/source.txt", quality);
	const source = loadSources(cwd)[0];
	for (const [key, value] of Object.entries(quality)) assert.deepEqual(source[key as keyof typeof source], value);
	assert.deepEqual(readSource(cwd, "contract-1", 1, 2).source, source);
	const docx = makeCase("processed/source.txt", {
		kind: "docx",
		page_numbering: "synthetic_p0001",
		ocr_status: "not_performed",
		warnings: ["DOCX 含嵌入图片；未执行 OCR，图片中的文字未提取"],
	});
	assert.equal(readSource(docx, "contract-1", 1, 1).source.page_numbering, "synthetic_p0001");
	assert.deepEqual(loadSources(docx)[0].warnings, ["DOCX 含嵌入图片；未执行 OCR，图片中的文字未提取"]);
	const unrecorded = loadSources(makeCase())[0];
	assert.equal(unrecorded.page_numbering, undefined);
	assert.equal(unrecorded.ocr_status, undefined);
	assert.equal(unrecorded.pages_without_extractable_text, undefined);
	assert.equal(unrecorded.warnings, undefined);
});

test("rejects malformed extraction quality metadata instead of reporting it as usable", () => {
	for (const metadata of [
		{ bytes: -1 },
		{ page_count: "3" },
		{ line_count: 1.5 },
		{ page_numbering: "verified_original" },
		{ ocr_status: true },
		{ pages_without_extractable_text: [0] },
		{ pages_without_extractable_text: ["2"] },
		{ warnings: [false] },
	]) {
		const cwd = makeCase("processed/source.txt", metadata);
		assert.throws(() => loadSources(cwd), /来源 contract-1 的/);
	}
});

test("rejects missing manifests, missing files, and invalid line ranges", () => {
	const absent = mkdtempSync(join(tmpdir(), "pi-legal-empty-"));
	cases.push(absent);
	assert.throws(() => loadSources(absent), /清单不存在/);
	const cwd = makeCase("processed/missing.txt");
	assert.throws(() => readSource(cwd, "contract-1", 1, 1), /处理文件不存在/);
	assert.throws(() => readSource(cwd, "contract-1", 0, 1), /行范围无效/);
	assert.throws(() => readSource(cwd, "contract-1", 1, 201), /单次最多读取/);
});

test("rejects lexical traversal and symlink escapes from source storage", () => {
	const cwd = makeCase("../outside.txt");
	assert.throws(() => readSource(cwd, "contract-1", 1, 1), /越过了清单目录/);
	const manifest = join(cwd, ".legalagent", "sources", "manifest.json");
	const data = JSON.parse(requireManifest(manifest));
	data.sources[0].processed_path = resolve(cwd, "outside.txt");
	writeFileSync(manifest, JSON.stringify(data));
	assert.throws(() => readSource(cwd, "contract-1", 1, 1), /必须是清单目录内的相对路径/);
	data.sources[0].processed_path = "processed/link.txt";
	writeFileSync(manifest, JSON.stringify(data));
	const outside = join(cwd, "outside.txt");
	writeFileSync(outside, "[p0001:L0001] 外部文本");
	try {
		symlinkSync(outside, join(cwd, ".legalagent", "sources", "processed", "link.txt"));
		assert.throws(() => readSource(cwd, "contract-1", 1, 1), /处理文件越过了清单目录/);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
	}
});

test("allows write and edit targets only under the real outputs directory", () => {
	const cwd = makeCase();
	assert.equal(isOutputPath(cwd, "outputs/draft.md"), true);
	assert.equal(isOutputPath(cwd, "outputs/nested/draft.md"), true);
	assert.equal(isOutputPath(cwd, "outputs/../原件/合同.pdf"), false);
	assert.equal(isOutputPath(cwd, ".legalagent/sources/manifest.json"), false);
	assert.equal(isOutputPath(cwd, "outputs"), false);
	const outside = mkdtempSync(join(tmpdir(), "pi-legal-other-"));
	cases.push(outside);
	try {
		symlinkSync(outside, join(cwd, "outputs"), "junction");
		assert.equal(isOutputPath(cwd, "outputs/draft.md"), false);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
	}
});

test("extension registers read-only source tools and blocks built-in edits outside outputs", () => {
	const cwd = makeCase();
	const toolNames: string[] = [];
	const commandNames: string[] = [];
	let toolCallHandler: ((event: unknown, context: unknown) => unknown) | undefined;
	legalSources({
		registerTool: (definition: { name: string }) => {
			toolNames.push(definition.name);
		},
		registerCommand: (name: string) => {
			commandNames.push(name);
		},
		on: (name: string, handler: (event: unknown, context: unknown) => unknown) => {
			if (name === "tool_call") toolCallHandler = handler;
		},
	} as unknown as ExtensionAPI);
	assert.deepEqual(toolNames, ["legal_sources_list", "legal_source_read", "legal_citation_verify"]);
	assert.deepEqual(commandNames, ["sources"]);
	assert.ok(toolCallHandler);
	const blocked = toolCallHandler(
		{ toolName: "write", input: { path: ".legalagent/sources/manifest.json" } },
		{ cwd },
	);
	assert.deepEqual(blocked, {
		block: true,
		reason: "法律 Agent 只允许 write/edit 写入当前案件的 outputs/ 目录。",
	});
	assert.equal(toolCallHandler({ toolName: "edit", input: { path: "outputs/draft.md" } }, { cwd }), undefined);
	assert.equal(toolCallHandler({ toolName: "read", input: { path: "原件/合同.pdf" } }, { cwd }), undefined);
});

test("registered source tools expose quality information to the model as well as structured details", async () => {
	const cwd = makeCase("processed/source.txt", {
		page_numbering: "synthetic_p0001",
		ocr_status: "not_performed",
		pages_without_extractable_text: [2],
		warnings: ["图片中的文字未提取"],
	});
	const tools = registeredTools();
	const ctx = { cwd } as ExtensionContext;
	const list = await tools[0].execute("list", {}, undefined, undefined, ctx);
	assert.deepEqual(list.details, { count: 1, sources: loadSources(cwd) });
	assert.equal(list.content[0].type, "text");
	if (list.content[0].type === "text") assert.match(list.content[0].text, /synthetic_p0001/);
	const read = await tools[1].execute(
		"read",
		{ source_id: "contract-1", start_line: 1, end_line: 1 },
		undefined,
		undefined,
		ctx,
	);
	assert.deepEqual(read.details, readSource(cwd, "contract-1", 1, 1));
	assert.equal(read.content[0].type, "text");
	if (read.content[0].type === "text") {
		assert.match(read.content[0].text, /synthetic_p0001/);
		assert.match(read.content[0].text, /not_performed/);
		assert.match(read.content[0].text, /pages_without_extractable_text":\[2\]/);
		assert.match(read.content[0].text, /图片中的文字未提取/);
		assert.match(read.content[0].text, /不证明原件真实性、提取完整性或法条效力/);
		assert.match(read.content[0].text, /\[p0001:L0001\] 甲方应于十日内付款。/);
	}
});

test("registered source tools throw failures so the agent runtime marks error results", async () => {
	const tools = registeredTools();
	const absent = mkdtempSync(join(tmpdir(), "pi-legal-empty-"));
	cases.push(absent);
	const ctx = { cwd: absent } as ExtensionContext;
	// AgentToolResult has no isError field; the runtime marks a thrown execute failure as isError:true.
	await assert.rejects(tools[0].execute("list", {}, undefined, undefined, ctx), /来源读取失败：案件来源清单不存在/);
	await assert.rejects(
		tools[1].execute("read", { source_id: "contract-1", start_line: 1, end_line: 1 }, undefined, undefined, ctx),
		/来源读取失败：案件来源清单不存在/,
	);
	await assert.rejects(
		tools[2].execute("verify", { source_id: "contract-1", quote: "合同" }, undefined, undefined, ctx),
		/引文核验失败：案件来源清单不存在/,
	);
	const escaped = { cwd: makeCase("../outside.txt") } as ExtensionContext;
	await assert.rejects(
		tools[1].execute("read", { source_id: "contract-1", start_line: 1, end_line: 1 }, undefined, undefined, escaped),
		/processed_path 越过了清单目录/,
	);
	const usable = { cwd: makeCase() } as ExtensionContext;
	const noMatch = await tools[2].execute(
		"verify",
		{ source_id: "contract-1", quote: "不存在的引文" },
		undefined,
		undefined,
		usable,
	);
	assert.deepEqual(noMatch.details, verifyQuote(usable.cwd, "contract-1", "不存在的引文"));
});

function registeredTools(): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	legalSources({
		registerTool: (definition: ToolDefinition) => {
			tools.push(definition);
		},
		registerCommand: () => {},
		on: () => {},
	} as unknown as ExtensionAPI);
	return tools;
}

function requireManifest(path: string): string {
	return readFileSync(path, "utf8");
}
