#!/usr/bin/env bun
/**
 * Sync script: reads CLAUDE.md from the project root, extracts the grove section,
 * and verifies that src/claude-md.ts can read it correctly at runtime.
 *
 * Usage: bun scripts/sync-claude-md.ts
 *
 * This script is a validation tool — since src/claude-md.ts now reads CLAUDE.md
 * at runtime, this script simply verifies the markers are present and well-formed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CLAUDE_MD_PATH = join(ROOT, "CLAUDE.md");
const grovePattern = /<!-- grove:start -->[\s\S]*?<!-- grove:end -->/;

function main(): void {
	console.log(`Checking ${CLAUDE_MD_PATH}...`);

	let content: string;
	try {
		content = readFileSync(CLAUDE_MD_PATH, "utf-8");
	} catch {
		console.error(`ERROR: Cannot read ${CLAUDE_MD_PATH}`);
		process.exit(1);
	}

	const match = grovePattern.exec(content);
	if (!match) {
		console.error(
			"ERROR: CLAUDE.md does not contain <!-- grove:start --> ... <!-- grove:end --> markers.",
		);
		process.exit(1);
	}

	const lines = match[0].split("\n").length;
	console.log(`OK: Grove section found (${lines} lines).`);
	console.log(
		"src/claude-md.ts reads directly from CLAUDE.md at runtime — no codegen needed.",
	);
}

main();
