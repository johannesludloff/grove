/**
 * Live TUI dashboard — clean frameless layout with cursor positioning.
 *
 * Layout:
 *   Header bar
 *   Agents section (full width)
 *   ─── separator ───
 *   Feed (left 60%)    Tasks (right 40%)
 *   ─── separator ───
 *   Mail (left 50%)    Memory (right 50%)
 */

import { listAgents } from "./agent.ts";
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
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
	gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
	brandBold: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
} as const;

/** Strip ANSI codes for visible length calculation */
function visibleLength(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Truncate a string with ANSI codes to maxLen visible characters, appending '…' */
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
				result += "…";
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
	return `${str.slice(0, maxLen - 1)}…`;
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

/** Dim horizontal separator line */
function separator(width: number): string {
	return c.dim("─".repeat(width));
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
	running: { icon: "●", color: c.green },
	spawning: { icon: "●", color: c.yellow },
	failed: { icon: "●", color: c.red },
	completed: { icon: "●", color: c.cyan },
	stopped: { icon: "●", color: c.gray },
};

function taskStatusDot(status: string): string {
	switch (status) {
		case "in_progress": return c.green("●");
		case "completed": return c.cyan("●");
		case "failed": return c.red("●");
		case "pending": return c.yellow("●");
		default: return c.gray("●");
	}
}

function mailTypeColor(type: string): (s: string) => string {
	switch (type) {
		case "done": return c.green;
		case "error": return c.red;
		case "question": return c.yellow;
		case "result": return c.cyan;
		default: return c.gray;
	}
}

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

// ── Section renderers ───────────────────────────────────────────────────

function renderAgents(agents: Agent[], width: number, maxRows: number, startRow: number): { output: string; rowsUsed: number } {
	let output = "";
	const indent = " ".repeat(PAD_LEFT);

	// Section header
	output += writeLine(startRow, 1, `${indent}${c.bold("Agents")} ${c.dim(`(${agents.length})`)}`, width);

	if (agents.length === 0) {
		output += writeLine(startRow + 1, 1, `${indent}${c.dim("No agents")}`, width);
		return { output, rowsUsed: 2 };
	}

	// Column headers
	output += writeLine(startRow + 1, 1,
		`${indent}${c.dim(pad("", 3))}${c.dim(pad("Name", 16))} ${c.dim(pad("Cap", 12))} ${c.dim(pad("State", 10))} ${c.dim(pad("Task", 14))} ${c.dim("Time")}`,
		width,
	);

	const sorted = [...agents].sort((a, b) => {
		const activeStates = ["running", "spawning"];
		const aActive = activeStates.includes(a.status);
		const bActive = activeStates.includes(b.status);
		if (aActive && !bActive) return -1;
		if (!aActive && bActive) return 1;
		return 0;
	});

	const visible = sorted.slice(0, maxRows);
	const now = Date.now();

	for (let i = 0; i < visible.length; i++) {
		const a = visible[i]!;
		const theme = STATUS_THEME[a.status];
		const icon = theme.color(theme.icon);
		const name = c.cyan(pad(truncate(a.name, 16), 16));
		const cap = pad(a.capability, 12);
		const state = theme.color(pad(a.status, 10));
		const taskId = c.cyan(pad(truncate(a.taskId, 14), 14));
		const endTime =
			a.status === "completed" || a.status === "failed" || a.status === "stopped"
				? new Date(a.updatedAt + "Z").getTime()
				: now;
		const elapsed = endTime - new Date(a.createdAt + "Z").getTime();
		const dur = formatDuration(elapsed);
		output += writeLine(startRow + 2 + i, 1, `${indent}${icon}  ${name} ${cap} ${state} ${taskId} ${dur}`, width);
	}

	return { output, rowsUsed: 2 + visible.length };
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
		const typeTag = c.dim(colorFn(pad(shortEventType(ev.type), 5)));
		const agentPart = ev.agent ? ` ${c.cyan(truncate(ev.agent, 8))}` : "";
		const agentPartLen = ev.agent ? 1 + Math.min(ev.agent.length, 8) : 0;
		const time = c.dim(formatRelativeTime(ev.createdAt));
		const timeLen = visibleLength(time);
		const summaryMax = Math.max(0, contentWidth - 5 - agentPartLen - 1 - timeLen - 1 - 3);
		const summary = truncate(ev.summary, summaryMax);
		const leftPart = `${typeTag}${agentPart} ${summary}`;
		const leftPartLen = visibleLength(leftPart);
		const midPadLen = Math.max(1, contentWidth - leftPartLen - timeLen);
		const line = `${indent}${leftPart}${" ".repeat(midPadLen)}${time}`;
		output += writeLine(startRow + 1 + i, startCol, line, width);
	}
	for (let i = visible.length; i < maxRows; i++) {
		output += writeLine(startRow + 1 + i, startCol, " ".repeat(width), width);
	}

	return output;
}

function renderTasks(tasks: Task[], width: number, maxRows: number, startRow: number, startCol: number): string {
	let output = "";
	const indent = " ".repeat(PAD_LEFT);
	const contentWidth = width - PAD_LEFT - PAD_RIGHT;
	const idWidth = contentWidth < 36 ? 8 : 14;

	output += writeLine(startRow, startCol, `${indent}${c.bold("Tasks")} ${c.dim(`(${tasks.length})`)}`, width);

	if (tasks.length === 0) {
		output += writeLine(startRow + 1, startCol, `${indent}${c.dim("No tasks")}`, width);
		for (let i = 2; i <= maxRows; i++) {
			output += writeLine(startRow + i, startCol, " ".repeat(width), width);
		}
		return output;
	}

	const visible = tasks.slice(0, maxRows);
	for (let i = 0; i < visible.length; i++) {
		const t = visible[i]!;
		const dot = taskStatusDot(t.status);
		const id = c.cyan(pad(truncate(t.taskId, idWidth), idWidth));
		const titleMax = Math.max(0, contentWidth - 1 - 1 - idWidth - 1);
		const title = truncate(t.title, titleMax);
		output += writeLine(startRow + 1 + i, startCol, `${indent}${dot} ${id} ${title}`, width);
	}
	for (let i = visible.length; i < maxRows; i++) {
		output += writeLine(startRow + 1 + i, startCol, " ".repeat(width), width);
	}

	return output;
}

function renderMail(messages: Mail[], width: number, maxRows: number, startRow: number, startCol: number): string {
	let output = "";
	const indent = " ".repeat(PAD_LEFT);

	output += writeLine(startRow, startCol, `${indent}${c.bold("Mail")} ${c.dim(`(${messages.length} unread)`)}`, width);

	if (messages.length === 0) {
		output += writeLine(startRow + 1, startCol, `${indent}${c.dim("No unread messages")}`, width);
		for (let i = 2; i <= maxRows; i++) {
			output += writeLine(startRow + i, startCol, " ".repeat(width), width);
		}
		return output;
	}

	const shown = messages.slice(0, maxRows);
	for (let i = 0; i < shown.length; i++) {
		const m = shown[i]!;
		const colorFn = mailTypeColor(m.type);
		const typeTag = colorFn(`[${m.type}]`);
		const from = c.cyan(truncate(m.from, 12));
		const to = c.cyan(truncate(m.to, 12));
		const subj = truncate(m.subject, width - 40);
		const time = c.dim(formatRelativeTime(m.createdAt));
		output += writeLine(startRow + 1 + i, startCol, `${indent}${typeTag} ${from} → ${to}: ${subj} ${time}`, width);
	}
	for (let i = shown.length; i < maxRows; i++) {
		output += writeLine(startRow + 1 + i, startCol, " ".repeat(width), width);
	}

	return output;
}

function renderMemory(memories: Memory[], width: number, maxRows: number, startRow: number, startCol: number): string {
	let output = "";
	const indent = " ".repeat(PAD_LEFT);

	output += writeLine(startRow, startCol, `${indent}${c.bold("Memory")} ${c.dim(`(${memories.length})`)}`, width);

	if (memories.length === 0) {
		output += writeLine(startRow + 1, startCol, `${indent}${c.dim("No memories")}`, width);
		for (let i = 2; i <= maxRows; i++) {
			output += writeLine(startRow + i, startCol, " ".repeat(width), width);
		}
		return output;
	}

	const byDomain = new Map<string, number>();
	for (const m of memories) {
		byDomain.set(m.domain, (byDomain.get(m.domain) ?? 0) + 1);
	}

	const domainParts: string[] = [];
	for (const [domain, count] of byDomain) {
		domainParts.push(`${c.cyan(domain)} ${c.dim(`${count}`)}`);
	}
	output += writeLine(startRow + 1, startCol, `${indent}${domainParts.join(c.dim("  ·  "))}`, width);

	for (let i = 2; i <= maxRows; i++) {
		output += writeLine(startRow + i, startCol, " ".repeat(width), width);
	}

	return output;
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

	// Rows 1-2: header
	const title = "GROVE DASHBOARD";
	const titlePadded = " ".repeat(Math.max(0, Math.floor((width - title.length) / 2))) + c.brandBold(title);
	output += writeLine(1, 1, titlePadded, width);
	output += writeLine(2, 1, ` ${separator(width - 2)}`, width);

	let row = 3;

	// Agents
	const agentMaxRows = Math.max(3, Math.min(Math.floor(height * 0.25), agents.length + 1));
	const agentResult = renderAgents(agents, width, agentMaxRows, row);
	output += agentResult.output;
	row += agentResult.rowsUsed;

	// Separator
	row += 1;
	output += writeLine(row, 1, ` ${separator(width - 2)}`, width);
	row += 1;

	// Middle zone: Feed (left 60%) | Tasks (right 40%)
	const bottomRows = 4;
	const middleRows = Math.max(4, height - row - bottomRows - 3);
	const feedWidth = Math.floor(width * 0.6);
	const taskWidth = width - feedWidth;

	output += renderFeed(events, feedWidth, middleRows, row, 1);
	output += renderTasks(tasks, taskWidth, middleRows, row, feedWidth + 1);
	row += middleRows + 1;

	// Separator
	output += writeLine(row, 1, ` ${separator(width - 2)}`, width);
	row += 1;

	// Bottom: Mail (left 50%) | Memory (right 50%)
	const mailWidth = Math.floor(width * 0.5);
	const memoryWidth = width - mailWidth;

	output += renderMail(unreadMail, mailWidth, bottomRows, row, 1);
	output += renderMemory(memories, memoryWidth, bottomRows, row, mailWidth + 1);
	row += bottomRows + 1;

	output += CURSOR.clearDown;
	process.stdout.write(output);
}

/** Start the live dashboard loop */
export function startDashboard(intervalMs: number): void {
	process.stdout.write(CURSOR.altScreenOn + CURSOR.hide);

	let running = true;
	let rendering = false;
	let resizeTimeout: ReturnType<typeof setTimeout> | undefined;
	let timer: ReturnType<typeof setInterval>;

	const tick = () => {
		if (!running) return;
		if (rendering) return;
		rendering = true;
		try {
			renderDashboard();
		} finally {
			rendering = false;
		}
	};

	const restartTimer = () => {
		clearInterval(timer);
		timer = setInterval(tick, intervalMs);
	};

	const onResize = () => {
		if (resizeTimeout !== undefined) clearTimeout(resizeTimeout);
		resizeTimeout = setTimeout(() => {
			resizeTimeout = undefined;
			restartTimer();
			tick();
		}, 50);
	};

	tick();
	timer = setInterval(tick, intervalMs);

	const cleanup = () => {
		running = false;
		clearInterval(timer);
		if (resizeTimeout !== undefined) clearTimeout(resizeTimeout);
		process.stdout.off("resize", onResize);
		process.stdout.write(CURSOR.show + CURSOR.altScreenOff);
		process.exit(0);
	};

	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
	process.stdout.on("resize", onResize);
}
