/**
 * Grove auto-update mechanism
 * - Lightweight update check on CLI startup (cached, once per hour)
 * - Manual `grove update` command for full update
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Grove source repo root (parent of src/) */
export const GROVE_ROOT = join(import.meta.dir, "..");

const CACHE_FILE = join(GROVE_ROOT, ".last-update-check");
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface UpdateCache {
	lastCheck: number;
	updatesAvailable: boolean;
}

function readCache(): UpdateCache | null {
	try {
		if (!existsSync(CACHE_FILE)) return null;
		return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
	} catch {
		return null;
	}
}

function writeCache(cache: UpdateCache): void {
	try {
		writeFileSync(CACHE_FILE, JSON.stringify(cache));
	} catch {
		// silently ignore write failures
	}
}

/** Read version from package.json */
export function getGroveVersion(): string {
	try {
		const pkg = JSON.parse(
			readFileSync(join(GROVE_ROOT, "package.json"), "utf-8"),
		);
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/**
 * Lightweight startup check. Reads cached result; if stale, compares
 * local HEAD with origin/main (fast local op) and triggers a background fetch.
 */
export function maybeNotifyUpdate(): void {
	try {
		const cache = readCache();
		const now = Date.now();

		// If cache is fresh, use cached result
		if (cache && now - cache.lastCheck < CHECK_INTERVAL_MS) {
			if (cache.updatesAvailable) {
				console.error(
					"\x1b[33m⚡ Grove update available. Run 'grove update' to upgrade.\x1b[0m",
				);
			}
			return;
		}

		// Compare local HEAD with last-known origin/main (fast, local-only)
		let updatesAvailable = false;
		try {
			const local = execSync("git rev-parse HEAD", {
				cwd: GROVE_ROOT,
				encoding: "utf-8",
				timeout: 2000,
			}).trim();
			const remote = execSync("git rev-parse origin/main", {
				cwd: GROVE_ROOT,
				encoding: "utf-8",
				timeout: 2000,
			}).trim();
			updatesAvailable = local !== remote;
		} catch {
			// can't compare — skip
		}

		writeCache({ lastCheck: now, updatesAvailable });

		if (updatesAvailable) {
			console.error(
				"\x1b[33m⚡ Grove update available. Run 'grove update' to upgrade.\x1b[0m",
			);
		}

		// Background fetch to refresh origin/main for next check
		try {
			const proc = Bun.spawn(
				["git", "fetch", "origin", "main", "--quiet"],
				{
					cwd: GROVE_ROOT,
					stdio: ["ignore", "ignore", "ignore"],
				},
			);
			proc.unref();
		} catch {
			// ignore — offline or git unavailable
		}
	} catch {
		// never block normal operation
	}
}

/**
 * Full update: git pull, bun install, bun link
 */
export function runUpdate(): void {
	console.log(`Updating Grove from ${GROVE_ROOT}...\n`);

	try {
		console.log("→ git pull origin main");
		execSync("git pull origin main", {
			cwd: GROVE_ROOT,
			stdio: "inherit",
			timeout: 30000,
		});
	} catch {
		console.error(
			"Failed to pull latest changes. Check your network connection.",
		);
		process.exit(1);
	}

	try {
		console.log("\n→ bun install");
		execSync("bun install", {
			cwd: GROVE_ROOT,
			stdio: "inherit",
			timeout: 60000,
		});
	} catch {
		console.error("Warning: bun install had issues, continuing...");
	}

	try {
		console.log("\n→ bun link");
		execSync("bun link", {
			cwd: GROVE_ROOT,
			stdio: "inherit",
			timeout: 30000,
		});
	} catch {
		console.error(
			"Warning: bun link failed. You may need to run 'bun link' manually in " +
				GROVE_ROOT,
		);
	}

	// Read updated version
	const version = getGroveVersion();
	console.log(`\n✓ Grove updated to v${version}`);

	// Clear update cache
	writeCache({ lastCheck: Date.now(), updatesAvailable: false });
}
