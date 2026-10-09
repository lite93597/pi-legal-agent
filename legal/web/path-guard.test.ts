import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isAllowedReadPath } from "./path-guard.ts";

test("web read stays inside the case and legal skills roots", (t) => {
	const root = mkdtempSync(join(tmpdir(), "legal-web-guard-"));
	const caseDir = join(root, "case");
	const skillsDir = join(root, "skills");
	const outsideDir = join(root, "case-other");
	const caseFile = join(caseDir, "notes.txt");
	const skillFile = join(skillsDir, "SKILL.md");
	const outsideFile = join(outsideDir, "secret.txt");
	const junction = join(caseDir, "escape");
	let linked = false;
	mkdirSync(caseDir);
	mkdirSync(skillsDir);
	mkdirSync(outsideDir);
	writeFileSync(caseFile, "case");
	writeFileSync(skillFile, "skill");
	writeFileSync(outsideFile, "outside");
	try {
		assert.equal(isAllowedReadPath("notes.txt", caseDir, skillsDir), true);
		assert.equal(isAllowedReadPath(skillFile, caseDir, skillsDir), true);
		assert.equal(isAllowedReadPath(outsideFile, caseDir, skillsDir), false);
		assert.equal(isAllowedReadPath("../case-other/secret.txt", caseDir, skillsDir), false);
		assert.equal(isAllowedReadPath("missing.txt", caseDir, skillsDir), false);
		try {
			symlinkSync(outsideDir, junction, "junction");
			linked = true;
		} catch {
			t.diagnostic("This Windows environment cannot create a test junction");
		}
		if (linked) assert.equal(isAllowedReadPath(join(junction, "secret.txt"), caseDir, skillsDir), false);
	} finally {
		if (linked) unlinkSync(junction);
		unlinkSync(caseFile);
		unlinkSync(skillFile);
		unlinkSync(outsideFile);
		rmdirSync(caseDir);
		rmdirSync(skillsDir);
		rmdirSync(outsideDir);
		rmdirSync(root);
	}
});

test("declared root aliases are canonicalized without allowing an external junction", () => {
	const root = mkdtempSync(join(tmpdir(), "legal-web-root-alias-"));
	const caseDir = join(root, "case");
	const skillsDir = join(root, "skills");
	const outsideDir = join(root, "outside");
	const caseAlias = join(root, "case-alias");
	const skillsAlias = join(root, "skills-alias");
	const escapeLink = join(caseDir, "escape");
	for (const directory of [caseDir, skillsDir, outsideDir]) mkdirSync(directory);
	const caseFile = join(caseDir, "notes.txt");
	const skillFile = join(skillsDir, "SKILL.md");
	const outsideFile = join(outsideDir, "outside.txt");
	for (const file of [caseFile, skillFile, outsideFile]) writeFileSync(file, "synthetic");
	const links: string[] = [];
	try {
		for (const [target, alias] of [
			[caseDir, caseAlias],
			[skillsDir, skillsAlias],
			[outsideDir, escapeLink],
		]) {
			symlinkSync(target, alias, "junction");
			links.push(alias);
		}
		assert.equal(isAllowedReadPath("notes.txt", caseAlias, skillsAlias), true);
		assert.equal(isAllowedReadPath(join(skillsAlias, "SKILL.md"), caseAlias, skillsAlias), true);
		assert.equal(isAllowedReadPath(join(escapeLink, "outside.txt"), caseAlias, skillsAlias), false);
		assert.equal(isAllowedReadPath(outsideFile, caseAlias, skillsAlias), false);
	} finally {
		for (const link of links.reverse()) unlinkSync(link);
		for (const file of [caseFile, skillFile, outsideFile]) unlinkSync(file);
		for (const directory of [caseDir, skillsDir, outsideDir, root]) rmdirSync(directory);
	}
});
