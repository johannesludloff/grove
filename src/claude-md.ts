/**
 * CLAUDE.md sync logic — reads the grove orchestrator section from CLAUDE.md
 * at the package root (single source of truth) and syncs it into project CLAUDE.md files.
 * Used by `grove init` and `grove update`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Grove source repo root (parent of src/) */
const GROVE_ROOT = join(import.meta.dir, "..");

/** Path to the canonical CLAUDE.md in the grove repo */
const GROVE_CLAUDE_MD = join(GROVE_ROOT, "CLAUDE.md");

/** Regex to extract the grove section (inclusive of markers) */
const grovePattern = /<!-- grove:start -->[\s\S]*?<!-- grove:end -->/;

/** Cached grove section content (read once from CLAUDE.md) */
let _groveSectionCache: string | null = null;

/**
 * Read the grove section from the canonical CLAUDE.md at the package root.
 * Caches after first read. Returns the content between (and including)
 * `<!-- grove:start -->` and `<!-- grove:end -->`.
 */
export function getGroveSection(): string {
	if (_groveSectionCache !== null) return _groveSectionCache;

	if (!existsSync(GROVE_CLAUDE_MD)) {
		throw new Error(
			`Cannot find grove CLAUDE.md at ${GROVE_CLAUDE_MD}. Is the grove package installed correctly?`,
		);
	}

	const content = readFileSync(GROVE_CLAUDE_MD, "utf-8");
	const match = grovePattern.exec(content);
	if (!match) {
		throw new Error(
			`CLAUDE.md at ${GROVE_CLAUDE_MD} does not contain <!-- grove:start --> ... <!-- grove:end --> markers.`,
		);
	}

	_groveSectionCache = match[0] + "\n";
	return _groveSectionCache;
}

/** Clear the cached grove section (useful for testing or after updates) */
export function clearGroveSectionCache(): void {
	_groveSectionCache = null;
}

/** Regex to find the existing grove section in a target CLAUDE.md */
const groveSectionPattern = /<!-- grove:start -->[\s\S]*?<!-- grove:end -->\n?/;

/**
 * Sync the grove section into CLAUDE.md at the given project directory.
 * - If CLAUDE.md exists and has markers, replaces the section in-place.
 * - If CLAUDE.md exists but markers are missing, appends the section.
 * - If no CLAUDE.md exists, creates it.
 */
export async function syncClaudeMd(projectDir: string): Promise<void> {
	const claudeMdPath = `${projectDir}/CLAUDE.md`;
	const section = getGroveSection();

	if (existsSync(claudeMdPath)) {
		const existing = await Bun.file(claudeMdPath).text();
		if (groveSectionPattern.test(existing)) {
			await Bun.write(claudeMdPath, existing.replace(groveSectionPattern, section));
		} else {
			await Bun.write(claudeMdPath, `${existing}\n${section}`);
		}
	} else {
		await Bun.write(claudeMdPath, section);
	}
}
