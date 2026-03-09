/**
 * Live TUI dashboard — visual hierarchy with hero metrics, collapsed cleaned agents,
 * color-by-meaning, feed age fade, task status grouping, and compact bottom strip.
 *
 * Layout:
 *   Hero metrics strip
 *   Agents section (running/spawning/completed/failed only; cleaned collapsed)
 *   ─── separator ───
 *   Feed (left 60%)    Tasks (right 40%)
 *   ─── separator ───
 *   Mail + Memory compact strip
 */

import { existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { listAgents } from "./agent.ts";
import { getDb, groveDir } from "./db.ts";
import { recentEvents, type EventType, type GroveEvent } from "./events.ts";
import { listMail } from "./mail.ts";
import { listMemories } from "./memory.ts";
import { listTasks } from "./tasks.ts";
import type { Agent, AgentStatus, Mail, Task } from "./types.ts";
import type { Memory } from "./memory.ts";

// ── Terminal control ────────────────────────────────────────────────────

const CURSOR = {
	clear: "\x1b[2J\x1b[H",
	home: "\x1b[H",
	clearDown: "\x1b[J",
	to: (row: number, col: number) => `\x1b[${row};${col}H`,
	hide: "\x1b[?25l",
	show: "\x1b[?25h",
	altScreenOn: "\x1b[?1049h",
	altScreenOff: "\x1b[?1049l",
} as const;

// ── ANSI color helpers ──────────────────────────────────────────────────

const c = {
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	brightGreen: (s: string) => `\x1b[1;32m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
	gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
	white: (s: string) => `\x1b[37m${s}\x1b[0m`,
	brightWhite: (s: string) => `\x1b[1;37m${s}\x1b[0m`,
	dimWhite: (s: string) => `\x1b[2;37m${s}\x1b[0m`,
	brandBold: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
} as const;

/** Strip ANSI codes for visible length calculation */
function visibleLength(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Truncate a string with ANSI codes to maxLen visible characters, appending '...' */
function truncateAnsi(s: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (visibleLength(s) <= maxLen) return s;
	let count = 0;
	let result = "";
	let i = 0;
	while (i < s.length) {
		if (s[i] === "\x1b" && s[i + 1] === "[") {
			let j = i + 2;
			while (j < s.length && s[j] !== "m") j++;
			result += s.slice(i, j + 1);
			i = j + 1;
		} else {
			if (count === maxLen - 1) {
				result += "\u2026";
				result += "\x1b[0m";
				return result;
			}
			result += s[i];
			count++;
			i++;
		}
	}
	return result;
}

// ── Layout constants ────────────────────────────────────────────────────

const PAD_LEFT = 2; // left padding for content
const PAD_RIGHT = 1; // right margin

// ── Formatting helpers ──────────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}\u2026`;
}

function pad(str: string, width: number): string {
	if (width <= 0) return "";
	if (str.length >= width) return str.slice(0, width);
	return str + " ".repeat(width - str.length);
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}

function formatRelativeTime(timestamp: string): string {
	const ts = timestamp.endsWith("Z") ? timestamp : timestamp + "Z";
	const diffMs = Date.now() - new Date(ts).getTime();
	if (diffMs < 0) return "now";
	const s = Math.floor(diffMs / 1000);
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	const d = Math.floor(h / 24);
	if (d > 0) return `${d}d ago`;
	if (h > 0) return `${h}h ago`;
	if (m > 0) return `${m}m ago`;
	return `${s}s ago`;
}

/** Get age in minutes from a timestamp */
function ageMinutes(timestamp: string): number {
	const ts = timestamp.endsWith("Z") ? timestamp : timestamp + "Z";
	return (Date.now() - new Date(ts).getTime()) / 60_000;
}

/** Dim horizontal separator line */
function separator(width: number): string {
	return c.dim("\u2500".repeat(width));
}

/** Write a line at a position, padded/truncated to fit width */
function writeLine(row: number, col: number, content: string, width: number): string {
	const vis = visibleLength(content);
	if (vis > width) {
		return `${CURSOR.to(row, col)}${truncateAnsi(content, width)}`;
	}
	return `${CURSOR.to(row, col)}${content}${" ".repeat(Math.max(0, width - vis))}`;
}

// ── Status theme ────────────────────────────────────────────────────────

const STATUS_THEME: Record<AgentStatus, { icon: string; color: (s: string) => string }> = {
	running: { icon: "\u25cf", color: c.brightGreen },
	spawning: { icon: "\u25cf", color: c.yellow },
	failed: { icon: "\u25cf", color: c.red },
	completed: { icon: "\u25cf", color: c.dimWhite },
	stopped: { icon: "\u25cf", color: c.gray },
	cleaned: { icon: "\u25cb", color: c.gray },
};

function eventTypeColor(type: EventType): (s: string) => string {
	if (type.startsWith("agent.")) return c.cyan;
	if (type.startsWith("task.")) return c.yellow;
	if (type === "mail.sent") return c.blue;
	if (type === "memory.added") return c.magenta;
	return c.gray;
}

function shortEventType(type: EventType): string {
	const map: Record<EventType, string> = {
		"agent.spawn": "spawn",
		"agent.running": "run",
		"agent.completed": "done",
		"agent.failed": "fail",
		"agent.stopped": "stop",
		"task.created": "new",
		"task.assigned": "asgn",
		"task.completed": "done",
		"task.failed": "fail",
		"mail.sent": "sent",
		"memory.added": "mem+",
		"merge.enqueued": "mrgq",
		"merge.started": "mrg>",
		"merge.completed": "mrg+",
		"merge.conflict": "mrg!",
		"merge.failed": "mrgx",
	};
	return map[type] ?? type.split(".").pop() ?? type;
}

// ── 1. Hero Metrics Strip ───────────────────────────────────────────────

function renderHeroStrip(
	agents: Agent[],
	tasks: Task[],
	memories: Memory[],
	width: number,
	startRow: number,
): string {
	const indent = " ".repeat(PAD_LEFT);
	const runningCount = agents.filter((a) => a.status === "running" || a.status === "spawning").length;
	const completedCount = agents.filter((a) => a.status === "completed").length;
	const taskCount = tasks.length;
	const memoryCount = memories.length;

	const runningColor = runningCount > 0 ? c.brightGreen : c.dim;
	const dot = c.dim("\u00b7");

	const strip =
		`${indent}${c.brandBold("\u258c GROVE")}   ` +
		`${runningColor(`${runningCount} running`)}  ${dot}  ` +
		`${c.dimWhite(`${completedCount} completed`)}  ${dot}  ` +
		`${c.dimWhite(`${taskCount} tasks`)}  ${dot}  ` +
		`${c.dimWhite(`${memoryCount} memories`)}   ` +
		`${c.dim("\u27f3 2s")}`;

	return writeLine(startRow, 1, strip, width);
}

// ── 2. Agents (collapsed cleaned) ───────────────────────────────────────

/** Color agent name by capability: lead=bold, scout/reviewer=dim, builder=normal */
function colorByCapability(name: string, capability: string): string {
	switch (capability) {
		case "lead": return c.bold(name);
		case "scout":
		case "reviewer": return c.dim(name);
		default: return name;
	}
}

/** Color agent name by status: running=bright green, completed=dim white, failed=red */
function colorByStatus(name: string, status: AgentStatus): string {
	switch (status) {
		case "running":
		case "spawning": return c.brightGreen(name);
		case "completed": return c.dimWhite(name);
		case "failed": return c.red(name);
		default: return c.gray(name);
	}
}

const MAX_AGENTS_PER_LEAD = 5;

/** Count children per parent agent name */
function getSubAgentCounts(agents: Agent[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const a of agents) {
		if (a.parentName) {
			counts.set(a.parentName, (counts.get(a.parentName) ?? 0) + 1);
		}
	}
	return counts;
}

/** Parse file count from agent completion mail body ("Files changed:\n..." section) */
function getFileCountsFromMail(): Map<string, number> {
	const counts = new Map<string, number>();
	try {
		const db = getDb();
		const rows = db
			.prepare(
				"SELECT from_agent, body FROM mail WHERE type IN ('done', 'result') AND body LIKE '%Files changed:%'",
			)
			.all() as Array<{ from_agent: string; body: string }>;
		for (const row of rows) {
			const match = row.body.match(/Files changed:\n([\s\S]*?)(?:\n\n|\nOutput |$)/);
			if (match) {
				const fileLines = match[1]!.trim().split("\n").filter((l) => l.trim());
				counts.set(row.from_agent, fileLines.length);
			}
		}
	} catch {
		// DB may not be ready
	}
	return counts;
}

/** Get file count from git diff for a branch (returns undefined if unavailable) */
function getFileCountFromGit(branch: string): number | undefined {
	try {
		const output = execSync(`git diff --name-only main...${branch}`, {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		if (!output) return 0;
		return output.split("\n").length;
	} catch {
		return undefined;
	}
}

/** Format byte size compactly: 1.2kb, 340b, 5.1mb */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}b`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
}

/** Get stdout file size for a running agent */
function getStdoutSize(agentName: string): string | undefined {
	try {
		const logPath = `${groveDir()}/logs/${agentName}/stdout.txt`;
		if (existsSync(logPath)) {
			const size = statSync(logPath).size;
			return formatSize(size);
		}
	} catch {
		// Log may not exist
	}
	return undefined;
}

function renderAgents(agents: Agent[], width: number, maxRows: number, startRow: number): { output: string; rowsUsed: number } {
	let output = "";
	const indent = " ".repeat(PAD_LEFT);

	// Separate cleaned from visible agents
	const cleanedAgents = agents.filter((a) => a.status === "cleaned");
	const visibleAgents = agents.filter((a) => a.status !== "cleaned");

	const totalLabel = `${visibleAgents.length}${cleanedAgents.length > 0 ? `+${cleanedAgents.length}` : ""}`;
	output += writeLine(startRow, 1, `${indent}${c.bold("Agents")} ${c.dim(`(${totalLabel})`)}`, width);

	if (visibleAgents.length === 0 && cleanedAgents.length === 0) {
		output += writeLine(startRow + 1, 1, `${indent}${c.dim("No agents")}`, width);
		return { output, rowsUsed: 2 };
	}

	// Build file counts: prefer git diff for active branches, fall back to mail body
	const mailFileCounts = getFileCountsFromMail();
	const fileCounts = new Map<string, number>();
	for (const a of visibleAgents) {
		if (mailFileCounts.has(a.name)) {
			fileCounts.set(a.name, mailFileCounts.get(a.name)!);
		} else if (a.status === "running" || a.status === "spawning" || a.status === "completed") {
			const gitCount = getFileCountFromGit(a.branch);
			if (gitCount !== undefined) fileCounts.set(a.name, gitCount);
		}
	}

	// Build sub-agent counts (all agents, not just visible)
	const subCounts = getSubAgentCounts(agents);

	// Column headers
	output += writeLine(startRow + 1, 1,
		`${indent}${c.dim(pad("", 3))}${c.dim(pad("Name", 22))} ${c.dim(pad("Cap", 10))} ${c.dim(pad("State", 12))} ${c.dim(pad("Task", 18))} ${c.dim(pad("Files", 5))} ${c.dim(pad("Sub", 5))} ${c.dim("Time")}`,
		width,
	);

	const activeStates = ["running", "spawning"];
	const sortScore = (a: Agent) => (activeStates.includes(a.status) ? 0 : 1);

	// Build hierarchy (only from visible agents)
	const agentNames = new Set(visibleAgents.map((a) => a.name));
	const childrenMap = new Map<string, Agent[]>();
	const roots: Agent[] = [];

	for (const a of visibleAgents) {
		if (a.parentName && agentNames.has(a.parentName)) {
			const siblings = childrenMap.get(a.parentName) ?? [];
			siblings.push(a);
			childrenMap.set(a.parentName, siblings);
		} else {
			roots.push(a);
		}
	}

	roots.sort((a, b) => sortScore(a) - sortScore(b));
	for (const children of childrenMap.values()) {
		children.sort((a, b) => sortScore(a) - sortScore(b));
	}

	const ordered: Array<{ agent: Agent; isChild: boolean }> = [];
	for (const root of roots) {
		ordered.push({ agent: root, isChild: false });
		for (const child of childrenMap.get(root.name) ?? []) {
			ordered.push({ agent: child, isChild: true });
		}
	}

	// Reserve 1 row for cleaned summary if needed
	const cleanedRow = cleanedAgents.length > 0 ? 1 : 0;
	const agentSlots = Math.max(0, maxRows - cleanedRow);
	const visible = ordered.slice(0, agentSlots);
	const now = Date.now();

	for (let i = 0; i < visible.length; i++) {
		const { agent: a, isChild } = visible[i]!;
		const theme = STATUS_THEME[a.status];
		const icon = theme.color(theme.icon);
		const rawName = isChild ? ` \u2514\u2500 ${truncate(a.name, 18)}` : truncate(a.name, 22);
		// Apply capability coloring, then status coloring
		const styledName = colorByStatus(colorByCapability(pad(rawName, 22), a.capability), a.status);
		const cap = pad(a.capability, 10);
		const endTime =
			a.status === "completed" || a.status === "failed" || a.status === "stopped"
				? new Date(a.updatedAt + "Z").getTime()
				: now;
		const elapsed = endTime - new Date(a.createdAt + "Z").getTime();
		const dur = formatDuration(elapsed);

		// Stall detection
		const isActive = a.status === "running" || a.status === "spawning";
		const activityTs = a.lastActivityAt ?? a.createdAt;
		const activityAge = now - new Date(activityTs + (activityTs.endsWith("Z") ? "" : "Z")).getTime();
		const isStalled = isActive && activityAge > 5 * 60_000;
		const stateLabel = isStalled ? "stalled?" : a.status;
		const state = isStalled ? c.yellow(pad(stateLabel, 12)) : theme.color(pad(stateLabel, 12));
		const staleIcon = isStalled ? c.yellow("\u26a0") : " ";

		const taskId = c.dim(pad(truncate(a.taskId, 18), 18));

		// Files column
		const fileCount = fileCounts.get(a.name);
		const filesCol = fileCount !== undefined ? pad(String(fileCount), 5) : pad("-", 5);

		// Sub column: show used/max for leads, '-' for others
		let subCol: string;
		if (a.capability === "lead") {
			const used = subCounts.get(a.name) ?? 0;
			subCol = pad(`${used}/${MAX_AGENTS_PER_LEAD}`, 5);
		} else {
			subCol = pad("-", 5);
		}

		// For running agents, append stdout size after duration
		let timeStr = dur;
		if (isActive) {
			const stdoutSz = getStdoutSize(a.name);
			if (stdoutSz) {
				timeStr = `${dur} ${c.dim(stdoutSz)}`;
			}
		}

		output += writeLine(startRow + 2 + i, 1, `${indent}${icon}  ${styledName} ${cap} ${state} ${taskId} ${filesCol} ${subCol} ${timeStr} ${staleIcon}`, width);
	}

	let rowsUsed = 2 + visible.length;

	// Collapsed cleaned summary
	if (cleanedAgents.length > 0) {
		output += writeLine(startRow + rowsUsed, 1,
			`${indent}${c.dim(`\u25b8 ${cleanedAgents.length} cleaned`)}`,
			width,
		);
		rowsUsed += 1;
	}

	return { output, rowsUsed };
}

// ── 4. Feed with age fade ───────────────────────────────────────────────

/** Apply age-based color fade: <2min bright white, 2-10min normal, >10min dim */
function ageFade(text: string, timestamp: string): string {
	const age = ageMinutes(timestamp);
	if (age < 2) return c.brightWhite(text);
	if (age < 10) return text;
	return c.dim(text);
}

function renderFeed(events: GroveEvent[], width: number, maxRows: number, startRow: number, startCol: number): string {
	let output = "";
	const indent = " ".repeat(PAD_LEFT);
	const contentWidth = width - PAD_LEFT - PAD_RIGHT;

	output += writeLine(startRow, startCol, `${indent}${c.bold("Feed")}`, width);

	if (events.length === 0) {
		output += writeLine(startRow + 1, startCol, `${indent}${c.dim("No events")}`, width);
		for (let i = 2; i <= maxRows; i++) {
			output += writeLine(startRow + i, startCol, " ".repeat(width), width);
		}
		return output;
	}

	const visible = events.slice(0, maxRows);
	for (let i = 0; i < visible.length; i++) {
		const ev = visible[i]!;
		const colorFn = eventTypeColor(ev.type);
		const typeTag = colorFn(pad(shortEventType(ev.type), 5));
		const agentPart = ev.agent ? ` ${truncate(ev.agent, 8)}` : "";
		const agentPartLen = ev.agent ? 1 + Math.min(ev.agent.length, 8) : 0;
		const time = formatRelativeTime(ev.createdAt);
		const timeLen = visibleLength(time);
		const summaryMax = Math.max(0, contentWidth - 5 - agentPartLen - 1 - timeLen - 1 - 3);
		const summary = truncate(ev.summary, summaryMax);
		const rawLine = `${typeTag}${agentPart} ${summary}`;
		const rawLineLen = visibleLength(rawLine);
		const midPadLen = Math.max(1, contentWidth - rawLineLen - timeLen);

		// Apply age fade to the entire line
		const fadedLine = ageFade(`${rawLine}${" ".repeat(midPadLen)}${time}`, ev.createdAt);
		output += writeLine(startRow + 1 + i, startCol, `${indent}${fadedLine}`, width);
	}
	for (let i = visible.length; i < maxRows; i++) {
		output += writeLine(startRow + 1 + i, startCol, " ".repeat(width), width);
	}

	return output;
}

// ── 5. Tasks with status grouping ───────────────────────────────────────

function renderTasks(tasks: Task[], width: number, maxRows: number, startRow: number, startCol: number): string {
	let output = "";
	const indent = " ".repeat(PAD_LEFT);
	const contentWidth = width - PAD_LEFT - PAD_RIGHT;
	const idWidth = contentWidth < 36 ? 8 : 14;

	// Count by status
	const inProgress = tasks.filter((t) => t.status === "in_progress");
	const pending = tasks.filter((t) => t.status === "pending");
	const completed = tasks.filter((t) => t.status === "completed");
	const failed = tasks.filter((t) => t.status === "failed");

	// Status summary header
	const parts: string[] = [];
	if (inProgress.length > 0) parts.push(c.green(`\u25cf ${inProgress.length} in progress`));
	if (pending.length > 0) parts.push(c.yellow(`\u25cb ${pending.length} pending`));
	if (completed.length > 0) parts.push(c.dimWhite(`\u2713 ${completed.length} done`));
	if (failed.length > 0) parts.push(c.red(`\u2717 ${failed.length} failed`));
	const statusSummary = parts.join(c.dim("  "));

	output += writeLine(startRow, startCol, `${indent}${c.bold("Tasks")} ${statusSummary}`, width);

	// Show in_progress first, then pending. Hide completed.
	const displayTasks = [...inProgress, ...pending, ...failed];

	if (displayTasks.length === 0) {
		output += writeLine(startRow + 1, startCol, `${indent}${c.dim("No active tasks")}`, width);
		for (let i = 2; i <= maxRows; i++) {
			output += writeLine(startRow + i, startCol, " ".repeat(width), width);
		}
		return output;
	}

	const shown = displayTasks.slice(0, maxRows);
	for (let i = 0; i < shown.length; i++) {
		const t = shown[i]!;
		const dot = t.status === "in_progress" ? c.green("\u25cf") : t.status === "failed" ? c.red("\u25cf") : c.yellow("\u25cb");
		const id = c.cyan(pad(truncate(t.taskId, idWidth), idWidth));
		const titleMax = Math.max(0, contentWidth - 1 - 1 - idWidth - 1);
		const title = truncate(t.title, titleMax);
		output += writeLine(startRow + 1 + i, startCol, `${indent}${dot} ${id} ${title}`, width);
	}
	for (let i = shown.length; i < maxRows; i++) {
		output += writeLine(startRow + 1 + i, startCol, " ".repeat(width), width);
	}

	return output;
}

// ── 6. Compact Mail + Memory strip ──────────────────────────────────────

function renderCompactStrip(
	unreadMail: Mail[],
	memories: Memory[],
	width: number,
	startRow: number,
): string {
	const indent = " ".repeat(PAD_LEFT);

	// Mail part
	let mailPart: string;
	if (unreadMail.length === 0) {
		mailPart = c.dim("\u2709 0 unread");
	} else {
		const subjects = unreadMail.slice(0, 3).map((m) => m.subject).join(", ");
		mailPart = c.yellow(`\u2709 ${unreadMail.length} unread`) + c.dim(`: ${truncate(subjects, 30)}`);
	}

	// Memory part
	const byDomain = new Map<string, number>();
	for (const m of memories) {
		byDomain.set(m.domain, (byDomain.get(m.domain) ?? 0) + 1);
	}
	const domainParts: string[] = [];
	for (const [domain, count] of byDomain) {
		domainParts.push(`${domain}(${count})`);
	}
	const domainStr = truncate(domainParts.join(" "), 40);
	const memPart = c.dim(`${memories.length} memories: ${domainStr}`);

	// Combine on one line
	const mailLen = visibleLength(mailPart);
	const memLen = visibleLength(memPart);
	const available = width - PAD_LEFT - PAD_RIGHT;
	const gap = Math.max(3, available - mailLen - memLen);
	const line = `${indent}${mailPart}${" ".repeat(gap)}${memPart}`;

	return writeLine(startRow, 1, line, width);
}

// ── Main render ─────────────────────────────────────────────────────────

function renderDashboard(): void {
	const width = process.stdout.columns ?? 100;
	const height = process.stdout.rows ?? 30;

	const agents = listAgents();
	const tasks = listTasks();
	const unreadMail = listMail({ unread: true });
	const memories = listMemories();
	const events = recentEvents(30);

	let output = CURSOR.clear;
	let row = 2;

	// Hero metrics strip
	output += renderHeroStrip(agents, tasks, memories, width, row);
	row += 2;

	// Agents (cleaned collapsed)
	const visibleAgentCount = agents.filter((a) => a.status !== "cleaned").length;
	const cleanedCount = agents.filter((a) => a.status === "cleaned").length;
	const agentMaxRows = Math.max(3, Math.min(Math.floor(height * 0.25), visibleAgentCount + 1 + (cleanedCount > 0 ? 1 : 0)));
	const agentResult = renderAgents(agents, width, agentMaxRows, row);
	output += agentResult.output;
	row += agentResult.rowsUsed;

	// Separator
	row += 1;
	output += writeLine(row, 1, ` ${separator(width - 2)}`, width);
	row += 1;

	// Middle zone: Feed (left 60%) | Tasks (right 40%)
	const bottomRows = 1; // compact strip is just 1 row
	const middleRows = Math.max(4, height - row - bottomRows - 3);
	const feedWidth = Math.floor(width * 0.6);
	const taskWidth = width - feedWidth;

	output += renderFeed(events, feedWidth, middleRows, row, 1);
	output += renderTasks(tasks, taskWidth, middleRows, row, feedWidth + 1);
	row += middleRows + 1;

	// Separator
	output += writeLine(row, 1, ` ${separator(width - 2)}`, width);
	row += 1;

	// Compact mail + memory strip (single row)
	output += renderCompactStrip(unreadMail, memories, width, row);
	row += 1;

	output += CURSOR.clearDown;
	process.stdout.write(output);
}

/** Start the live dashboard loop */
export function startDashboard(intervalMs: number): void {
	process.stdout.write(CURSOR.altScreenOn + CURSOR.hide);

	let running = true;

	const tick = () => {
		if (!running) return;
		renderDashboard();
	};

	tick();

	const timer = setInterval(tick, intervalMs);

	const cleanup = () => {
		running = false;
		clearInterval(timer);
		process.stdout.write(CURSOR.show + CURSOR.altScreenOff);
		process.exit(0);
	};

	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
}
