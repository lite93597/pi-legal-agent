#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const agentDir = join(repoDir, ".local", "agent");
export const demoCaseDir = join(repoDir, ".local", "demo-case");

function usage() {
	return [
		"Usage: node scripts/legal-setup.mjs [--base-url URL] [--model MODEL_ID]",
		"",
		"Copies configuration templates to .local/agent and synthetic demo materials to .local/demo-case.",
		"Existing case materials are preserved; --base-url and --model update the local configuration.",
		"Set LEGALAGENT_API_KEY in your environment; the key value is never written to a file.",
	].join("\n");
}

export function parseSetupArgs(args) {
	const options = {};
	for (let index = 0; index < args.length; index++) {
		const option = args[index];
		if (option === "--help" || option === "-h") {
			options.help = true;
			continue;
		}
		if (option !== "--base-url" && option !== "--model") throw new Error(`Unknown option: ${option}`);
		const value = args[++index];
		if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
		options[option === "--base-url" ? "baseUrl" : "model"] = value;
	}
	return options;
}

function baseUrl(value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("--base-url must be an absolute HTTP(S) URL");
	}
	if (
		!(["http:", "https:"].includes(parsed.protocol)) ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) throw new Error("--base-url must be an HTTP(S) URL without credentials, query, or fragment");
	return parsed.href.replace(/\/$/, "");
}

function modelId(value) {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 200 || /[\x00-\x1f\x7f]/.test(trimmed)) {
		throw new Error("--model must be a nonempty model ID (at most 200 characters)");
	}
	return trimmed;
}

function readObject(path) {
	let value;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read JSON configuration ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid JSON object: ${path}`);
	return value;
}

function writeJson(path, value) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		if (existsSync(temporary)) {
			// A failed rename leaves only our own temporary file.
			unlinkSync(temporary);
		}
	}
}

function copyMissing(source, target) {
	const sourceInfo = lstatSync(source);
	if (sourceInfo.isSymbolicLink()) throw new Error(`Demo material must not be a symbolic link: ${source}`);
	if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
		throw new Error(`Demo target must not be a symbolic link: ${target}`);
	}
	if (sourceInfo.isDirectory()) {
		mkdirSync(target, { recursive: true });
		for (const entry of readdirSync(source)) copyMissing(join(source, entry), join(target, entry));
		return;
	}
	if (!sourceInfo.isFile()) throw new Error(`Unsupported demo material: ${source}`);
	if (!existsSync(target)) copyFileSync(source, target, constants.COPYFILE_EXCL);
}

/** Prepare local configuration without storing API key values. */
export function setupLegalAgent({ baseUrl: requestedBaseUrl, model: requestedModel } = {}) {
	const modelsTemplate = join(repoDir, "legal", "config", "models.json");
	const settingsTemplate = join(repoDir, "legal", "config", "settings.json");
	for (const path of [modelsTemplate, settingsTemplate]) {
		if (!existsSync(path)) throw new Error(`Missing configuration template: ${path}`);
	}
	mkdirSync(agentDir, { recursive: true });
	const modelsPath = join(agentDir, "models.json");
	const settingsPath = join(agentDir, "settings.json");
	if (!existsSync(modelsPath)) copyFileSync(modelsTemplate, modelsPath, constants.COPYFILE_EXCL);
	if (!existsSync(settingsPath)) copyFileSync(settingsTemplate, settingsPath, constants.COPYFILE_EXCL);
	const models = readObject(modelsPath);
	const settings = readObject(settingsPath);
	const providerId = settings.defaultProvider;
	const provider = models.providers?.[providerId];
	if (typeof providerId !== "string" || !provider || typeof provider !== "object" || !Array.isArray(provider.models) || !provider.models.length) {
		throw new Error("The local model and settings templates do not define a default provider with models");
	}
	let modelsChanged = false;
	let settingsChanged = false;
	if (requestedBaseUrl !== undefined) {
		const value = baseUrl(requestedBaseUrl);
		if (provider.baseUrl !== value) {
			provider.baseUrl = value;
			modelsChanged = true;
		}
	}
	if (requestedModel !== undefined) {
		const value = modelId(requestedModel);
		if (!provider.models.some((item) => item?.id === value)) {
			provider.models = [{ ...provider.models[0], id: value, name: value }];
			modelsChanged = true;
		}
		if (settings.defaultModel !== value || JSON.stringify(settings.enabledModels) !== JSON.stringify([`${providerId}/${value}`])) {
			settings.defaultModel = value;
			settings.enabledModels = [`${providerId}/${value}`];
			settingsChanged = true;
		}
	}
	if (provider.apiKey !== "$LEGALAGENT_API_KEY") {
		provider.apiKey = "$LEGALAGENT_API_KEY";
		modelsChanged = true;
	}
	if (modelsChanged) writeJson(modelsPath, models);
	if (settingsChanged) writeJson(settingsPath, settings);
	const demoSource = join(repoDir, "examples", "demo-case");
	if (!existsSync(demoSource)) throw new Error(`Missing synthetic demo case: ${demoSource}`);
	copyMissing(demoSource, demoCaseDir);
	return { agentDir, demoCaseDir, provider: providerId, model: settings.defaultModel, baseUrl: provider.baseUrl };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseSetupArgs(process.argv.slice(2));
		if (options.help) console.log(usage());
		else {
			const result = setupLegalAgent(options);
			console.log(`Configuration: ${result.agentDir}`);
			console.log(`Demo case: ${result.demoCaseDir}`);
			console.log(`Model: ${result.provider}/${result.model}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
