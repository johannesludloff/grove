/** Live event feed — stream grove events to the terminal */

import { eventsSince, latestEventId, recentEvents } from "./events.ts";
import type { GroveEvent } from "./events.ts";

/** Colour codes per event type prefix */
const TYPE_COLORS: Record<string, string> = {
	"agent.": "\x1b[36m",   // cyan
	"task.":  "\x1b[33m",   // yellow
	"mail.":  "\x1b[35m",   // magenta
	"memory.":"\x1b[32m",   // green
};

const RESET = "\x1b[0m";
const DIM   = "\x1b[2m";

function colorFor(type: string): string {
	for (const [prefix, color] of Object.entries(TYPE_COLORS)) {
		if (type.startsWith(prefix)) return color;
	}
	return "";
}

function formatEvent(ev: GroveEvent): string {
	const ts = ev.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
	const color = colorFor(ev.type);
	const agent = ev.agent ? `${DIM}[${ev.agent}]${RESET} ` : "";
	const detail = ev.detail ? `${DIM} — ${ev.detail}${RESET}` : "";
	return `${DIM}${ts}${RESET}  ${color}${ev.type.padEnd(18)}${RESET}  ${agent}${ev.summary}${detail}`;
}

/** Print recent events (newest last) */
export function showRecentEvents(limit: number): void {
	const events = recentEvents(limit).reverse();
	if (events.length === 0) {
		console.log("No events recorded yet.");
		return;
	}
	for (const ev of events) {
		console.log(formatEvent(ev));
	}
}

/** Follow the event stream, polling for new events */
export function startFeed(opts: { limit: number; interval: number }): void {
	// Show recent history first
	showRecentEvents(opts.limit);

	let cursor = latestEventId();

	const poll = setInterval(() => {
		const newEvents = eventsSince(cursor, 100);
		for (const ev of newEvents) {
			console.log(formatEvent(ev));
			cursor = ev.id;
		}
	}, opts.interval);

	// Keep process alive; Ctrl-C exits
	process.on("SIGINT", () => {
		clearInterval(poll);
		process.exit(0);
	});
}
