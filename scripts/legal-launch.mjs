#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, demoCaseDir, repoDir, setupLegalAgent } from "./legal-setup.mjs";

const legalTools = [
	"read",
	"grep",
	"find",
	"ls",
	"legal_sources_list",
	"legal_source_read",
	"legal_citation_verify",
	"legal_retrieve",
	"legal_case_status",
	"legal_case_update",
	"legal_case_advance",
];

function usage(mode) {
	return [
		`Usage: node scripts/legal-launch.mjs ${mode || "<web|cli>"} [options]`,
		"",
		"Common: --case-dir PATH (default: .local/demo-case), --base-url URL, --model MODEL_ID",
		"Web:    --port PORT (default: 18005), --allow-write to enable draft saving",
		"CLI:    --prompt TEXT for a one-shot answer, --allow-write to enable drafts and outputs/ writes,",
		"        --no-save-session to disable conversation storage (sessions are saved by default)",
		"",
		"Set LEGALAGENT_API_KEY in the environment before starting. No model weights are included.",
	].join("\n");
}

export function parseLaunchArgs(args) {
	const [mode, ...rest] = args;
	if (mode !== "web" && mode !== "cli") throw new Error("First argument must be web or cli");
	const options = { mode, saveSession: true, allowWrite: false };
	for (let index = 0; index < rest.length; index++) {
		const option = rest[index];
		if (option === "--help" || option === "-h") {
			options.help = true;
			continue;
		}
		if (option === "--allow-write") {
			options.allowWrite = true;
			continue;
		}
		if (option === "--no-save-session" && mode === "cli") {
			options.saveSession = false;
			continue;
		}
		if (option === "--save-session" && mode === "cli") {
			options.saveSession = true;
			continue;
		}
		if (!["--case-dir", "--base-url", "--model", "--port", "--prompt"].includes(option)) {
			throw new Error(`Unknown option: ${option}`);
		}
		if ((option === "--port" && mode !== "web") || (option === "--prompt" && mode !== "cli")) {
			throw new Error(`${option} is not valid for ${mode}`);
		}
		const value = rest[++index];
		if (!value || (value.startsWith("--") && option !== "--prompt")) throw new Error(`${option} requires a value`);
		options[{
			"--case-dir": "caseDir",
			"--base-url": "baseUrl",
			"--model": "model",
			"--port": "port",
			"--prompt": "prompt",
		}[option]] = value;
	}
	if (options.port !== undefined) {
		const port = Number(options.port);
		if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be 1024–65535");
		options.port = port;
	}
	return options;
}

function requireFile(path, hint) {
	if (!existsSync(path)) throw new Error(`Missing ${path}. ${hint}`);
}

function runNodeSource(entry, args, cwd, env) {
	let tsx;
	try {
		tsx = import.meta.resolve("tsx");
	} catch {
		throw new Error("tsx is not installed. Run npm ci --ignore-scripts from the repository root.");
	}
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(process.execPath, ["--import", tsx, entry, ...args], { cwd, env, stdio: "inherit" });
		child.once("error", rejectRun);
		child.once("exit", (code, signal) => resolveRun(signal ? 1 : (code ?? 1)));
	});
}

/** Start the checked-in Pi source with only the legal resources selected. */
export async function launchLegalAgent(options) {
	const setup = setupLegalAgent({ baseUrl: options.baseUrl, model: options.model });
	const modelCatalog = join(repoDir, "packages", "ai", "src", "providers", "data", ".manifest.json");
	requireFile(modelCatalog, "The Pi catalog is missing; run npm run hydrate:model-data.");
	const requestedCaseDir = resolve(options.caseDir ?? demoCaseDir);
	if (!existsSync(requestedCaseDir)) throw new Error(`Case directory does not exist: ${requestedCaseDir}`);
	const caseDir = realpathSync(requestedCaseDir);
	if (!statSync(caseDir).isDirectory()) throw new Error(`Case directory is not a directory: ${caseDir}`);
	const env = {
		...process.env,
		LEGALAGENT_CODING_AGENT_DIR: agentDir,
		LEGALAGENT_ALLOW_WRITE: options.allowWrite ? "1" : "0",
		PI_OFFLINE: "1",
	};
	if (options.mode === "web") {
		const server = join(repoDir, "legal", "web", "server.ts");
		requireFile(server, "The web server source is missing.");
		console.log(`LegalAgent web: http://127.0.0.1:${options.port ?? 18005}/`);
		return runNodeSource(server, ["--case-dir", caseDir, "--port", String(options.port ?? 18005)], repoDir, env);
	}
	const cli = join(repoDir, "packages", "coding-agent", "src", "cli.ts");
	const guide = join(repoDir, "legal", "AGENT_GUIDE.md");
	const sources = join(repoDir, "legal", "extensions", "legal-sources.ts");
	const workflow = join(repoDir, "legal", "extensions", "legal-workflow.ts");
	const rag = join(repoDir, "legal", "extensions", "legal-rag.ts");
	const skills = join(repoDir, "legal", "skills");
	const prompts = join(repoDir, "legal", "prompts");
	for (const path of [cli, guide, sources, workflow, rag, skills, prompts]) requireFile(path, "The legal source tree is incomplete.");
	const tools = options.allowWrite ? [...legalTools, "write", "legal_draft_save"] : legalTools;
	const args = [
		"--offline",
		"--no-approve",
		"--no-context-files",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--append-system-prompt", guide,
		"--extension", sources,
		"--extension", workflow,
		"--extension", rag,
		"--skill", skills,
		"--prompt-template", prompts,
		"--tools", tools.join(","),
		"--provider", setup.provider,
		"--model", setup.model,
		...(options.saveSession ? ["--session-dir", join(caseDir, ".legalagent", "sessions")] : ["--no-session"]),
		...(options.prompt !== undefined ? ["--print", "--", options.prompt] : []),
	];
	return runNodeSource(cli, args, caseDir, env);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseLaunchArgs(process.argv.slice(2));
		if (options.help) console.log(usage(options.mode));
		else process.exitCode = await launchLegalAgent(options);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
