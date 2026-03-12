/** Agent checkpoint system for recovery from stalls/restarts */

import { existsSync } from "node:fs";
import { getDb } from "./db.ts";

/** Checkpoint data saved per agent */
export interface Checkpoint {
	/** Current phase of work */
	phase: "scout" | "build" | "review" | "plan" | "complete";
	/** Files the agent has explored/read */
	filesExplored: string[];
	/** Files the agent has modified/created */
	filesModified: string[];
	/** Key findings or decisions made */
	keyFindings: string[];
	/** Description of the current step being worked on */
	currentStep: string;
	/** ISO timestamp of last checkpoint write */
	timestamp: string;
}

/** Path to checkpoint.json for a given agent */
function checkpointPath(agentName: string): string {
	return `${process.cwd()}/.grove/logs/${agentName}/checkpoint.json`;
}

/**
 * Write a checkpoint for an agent.
 * Merges with existing checkpoint data (appends to arrays, overwrites scalars).
 */
export async function writeCheckpoint(
	agentName: string,
	data: Partial<Checkpoint>,
): Promise<void> {
	const filePath = checkpointPath(agentName);

	// Read existing checkpoint to merge
	let existing: Partial<Checkpoint> = {};
	try {
		if (existsSync(filePath)) {
			existing = JSON.parse(await Bun.file(filePath).text()) as Partial<Checkpoint>;
		}
	} catch {
		// Corrupted file — start fresh
	}

	// Merge: arrays are deduplicated unions, scalars are overwritten
	const merged: Checkpoint = {
		phase: data.phase ?? existing.phase ?? "scout",
		filesExplored: dedup([...(existing.filesExplored ?? []), ...(data.filesExplored ?? [])]),
		filesModified: dedup([...(existing.filesModified ?? []), ...(data.filesModified ?? [])]),
		keyFindings: dedup([...(existing.keyFindings ?? []), ...(data.keyFindings ?? [])]),
		currentStep: data.currentStep ?? existing.currentStep ?? "",
		timestamp: new Date().toISOString(),
	};

	await Bun.write(filePath, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Read a checkpoint for an agent. Returns null if no checkpoint exists.
 */
export function readCheckpoint(agentName: string): Checkpoint | null {
	const filePath = checkpointPath(agentName);
	try {
		if (!existsSync(filePath)) return null;
		const raw = require("node:fs").readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as Checkpoint;
	} catch {
		return null;
	}
}

/**
 * Build a prompt block from a previous agent's checkpoint on the same task.
 * Looks up prior agents (failed/stopped/completed) for the same taskId and
 * loads their checkpoint.json if available.
 */
export function buildCheckpointBlock(taskId: string, selfName: string): string {
	const db = getDb();

	// Find prior agents on the same task, most recent first
	const priorAgents = db
		.prepare(
			`SELECT name, capability, status
			 FROM agents
			 WHERE task_id = ? AND name != ? AND status IN ('failed', 'stopped', 'completed')
			 ORDER BY updated_at DESC LIMIT 3`,
		)
		.all(taskId, selfName) as Array<{
		name: string;
		capability: string;
		status: string;
	}>;

	if (priorAgents.length === 0) return "";

	const sections: string[] = [];

	for (const agent of priorAgents) {
		const checkpoint = readCheckpoint(agent.name);
		if (!checkpoint) continue;

		const lines: string[] = [
			`### Checkpoint from ${agent.name} (${agent.capability}, ${agent.status})`,
			`- **Phase**: ${checkpoint.phase}`,
			`- **Last step**: ${checkpoint.currentStep || "(none)"}`,
			`- **Timestamp**: ${checkpoint.timestamp}`,
		];

		if (checkpoint.filesExplored.length > 0) {
			lines.push(`- **Files explored**: ${checkpoint.filesExplored.join(", ")}`);
		}
		if (checkpoint.filesModified.length > 0) {
			lines.push(`- **Files modified**: ${checkpoint.filesModified.join(", ")}`);
		}
		if (checkpoint.keyFindings.length > 0) {
			lines.push("- **Key findings**:");
			for (const finding of checkpoint.keyFindings) {
				lines.push(`  - ${finding}`);
			}
		}

		sections.push(lines.join("\n"));
	}

	if (sections.length === 0) return "";

	return [
		"## Previous Agent Checkpoint (resume from here)",
		"",
		"A previous agent worked on this task but was stopped/failed. Use this checkpoint to resume where it left off — avoid re-reading files it already explored and build on its findings.",
		"",
		...sections,
	].join("\n");
}

/**
 * Auto-update checkpoint with file tracking from PostToolUse hook data.
 * Called from the tool-metric hook to passively track files explored/modified.
 */
export async function autoCheckpointFromTool(
	agentName: string,
	toolName: string,
	toolInput: Record<string, unknown>,
): Promise<void> {
	// Extract file paths from tool input
	const filePath = extractFilePath(toolInput);
	if (!filePath) return;

	const data: Partial<Checkpoint> = {};

	// Categorize by tool type
	if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
		data.filesExplored = [filePath];
	} else if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
		data.filesModified = [filePath];
	} else {
		return; // Not a file-related tool
	}

	await writeCheckpoint(agentName, data);
}

/** Extract a file path from tool input JSON */
function extractFilePath(input: Record<string, unknown>): string | null {
	// Common field names for file paths in Claude tool inputs
	const pathFields = ["file_path", "filePath", "path", "file"];
	for (const field of pathFields) {
		const val = input[field];
		if (typeof val === "string" && val.length > 0) {
			return val;
		}
	}

	// For Grep, check the path field
	if (typeof input.pattern === "string" && typeof input.path === "string") {
		return input.path;
	}

	return null;
}

/** Deduplicate an array preserving order */
function dedup(arr: string[]): string[] {
	return [...new Set(arr)];
}
