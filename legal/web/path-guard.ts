import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { resolveReadPath } from "../../packages/coding-agent/src/core/tools/path-utils.ts";

function within(path: string, root: string): boolean {
	const candidate = process.platform === "win32" ? path.toLowerCase() : path;
	const allowedRoot = process.platform === "win32" ? root.toLowerCase() : root;
	return (
		candidate === allowedRoot ||
		candidate.startsWith(allowedRoot.endsWith(sep) ? allowedRoot : `${allowedRoot}${sep}`)
	);
}

/** Restrict the web read tool to the fixed case and bundled legal skills. */
export function isAllowedReadPath(path: string, caseDir: string, skillsDir: string): boolean {
	if (!path.trim()) return false;
	try {
		const caseRoot = realpathSync.native(caseDir);
		const skillsRoot = realpathSync.native(skillsDir);
		const target = realpathSync.native(resolveReadPath(path, caseRoot));
		return within(target, caseRoot) || within(target, skillsRoot);
	} catch {
		return false;
	}
}
