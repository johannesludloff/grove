/** Hook generation and installation for Claude Code integration */

import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Shape of a single hook entry */
interface HookEntry {
	type: "command";
	command: string;
}

/** Shape of a hook group (matcher + hooks array) */
interface HookGroup {
	matcher?: string;
	hooks: HookEntry[];
}

/** Shape of the hooks section in settings.local.json */
interface HooksConfig {
	SessionStart?: HookGroup[];
	UserPromptSubmit?: HookGroup[];
	PreToolUse?: HookGroup[];
	[key: string]: HookGroup[] | undefined;
}

/** Shape of Claude Code settings.local.json */
interface ClaudeSettings {
	hooks?: HooksConfig;
	[key: string]: unknown;
}

/** Returns the hooks config object for grove integration */
export function buildHooksJson(): HooksConfig {
	return {
		SessionStart: [
			{
				hooks: [
					{
						type: "command",
						command: "grove prime",
					},
				],
			},
		],
		UserPromptSubmit: [
			{
				hooks: [
					{
						type: "command",
						command: "grove mail check orchestrator",
					},
				],
			},
		],
		PreToolUse: [
			{
				matcher: "Write|Edit|NotebookEdit",
				hooks: [
					{
						type: "command",
						command: "grove guard",
					},
				],
			},
			{
				matcher: "Read|Glob|Grep",
				hooks: [
					{
						type: "command",
						command: "grove guard --warn-read",
					},
				],
			},
		],
		Stop: [
			{
				hooks: [
					{
						type: "command",
						command: "grove mail deliver",
					},
				],
			},
		],
	};
}

/** Path to the .claude/settings.local.json for a project */
function settingsPath(projectRoot: string): string {
	return path.join(projectRoot, ".claude", "settings.local.json");
}

/** Check if a command already exists in a HookGroup array (deduplication) */
function hasCommand(groups: HookGroup[], command: string): boolean {
	return groups.some((g) => g.hooks.some((h) => h.command === command));
}

/** Merge new hook groups into existing ones, deduplicating by command */
function mergeGroups(existing: HookGroup[], incoming: HookGroup[]): HookGroup[] {
	const result = [...existing];
	for (const group of incoming) {
		for (const hook of group.hooks) {
			if (!hasCommand(result, hook.command)) {
				// Add a new group entry for this hook
				result.push({ ...(group.matcher ? { matcher: group.matcher } : {}), hooks: [hook] });
			}
		}
	}
	return result;
}

/**
 * Install grove hooks into .claude/settings.local.json.
 * Creates .claude/ if needed, preserves existing non-hooks keys,
 * and deduplicates hook entries.
 * @param projectRoot Root directory of the target project
 * @param force Overwrite existing hooks entries entirely (skip dedup merge)
 */
export async function installHooks(projectRoot: string, force = false): Promise<void> {
	const claudeDir = path.join(projectRoot, ".claude");
	const filePath = settingsPath(projectRoot);

	// Ensure .claude/ directory exists
	if (!existsSync(claudeDir)) {
		await mkdir(claudeDir, { recursive: true });
	}

	// Read existing settings or start fresh
	let settings: ClaudeSettings = {};
	if (existsSync(filePath)) {
		const raw = await Bun.file(filePath).text();
		try {
			settings = JSON.parse(raw) as ClaudeSettings;
		} catch {
			// Malformed JSON — overwrite with clean settings
			settings = {};
		}
	}

	const newHooks = buildHooksJson();

	if (force || !settings.hooks) {
		settings.hooks = newHooks;
	} else {
		// Merge each event type, deduplicating by command
		const merged: HooksConfig = { ...settings.hooks };
		for (const [event, groups] of Object.entries(newHooks)) {
			const existing = merged[event] ?? [];
			merged[event] = mergeGroups(existing, groups as HookGroup[]);
		}
		settings.hooks = merged;
	}

	await Bun.write(filePath, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Remove the hooks key from .claude/settings.local.json, preserving other settings.
 * No-op if the file doesn't exist.
 */
export async function uninstallHooks(projectRoot: string): Promise<void> {
	const filePath = settingsPath(projectRoot);
	if (!existsSync(filePath)) return;

	const raw = await Bun.file(filePath).text();
	let settings: ClaudeSettings;
	try {
		settings = JSON.parse(raw) as ClaudeSettings;
	} catch {
		return; // Nothing to do if file is malformed
	}

	delete settings.hooks;
	await Bun.write(filePath, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Returns true if grove hooks are currently installed in the project.
 * Checks for presence of the SessionStart grove prime command.
 */
export function statusHooks(projectRoot: string): boolean {
	const filePath = settingsPath(projectRoot);
	if (!existsSync(filePath)) return false;

	try {
		const content = readFileSync(filePath, "utf-8");
		const settings = JSON.parse(content) as ClaudeSettings;
		const sessionStart = settings.hooks?.SessionStart ?? [];
		return hasCommand(sessionStart, "grove prime");
	} catch {
		return false;
	}
}
