/** Tiered merge conflict resolver for agent branches */

export interface MergeResult {
	success: boolean;
	tier: string;
	conflictFiles: string[];
	errorMessage: string | null;
}

export interface ResolveOptions {
	branchName: string;
	canonicalBranch: string;
	repoRoot: string;
}

/** Run a git command in the repo root, return exit code and stdout/stderr */
async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { code, stdout, stderr };
}

/** Get list of unmerged (conflicted) files */
async function getConflictFiles(cwd: string): Promise<string[]> {
	const { stdout } = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
	return stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

/** Parse conflict markers and return content keeping the incoming (agent/theirs) side */
function resolveConflictMarkers(content: string): string {
	const lines = content.split("\n");
	const result: string[] = [];
	type State = "normal" | "ours" | "theirs";
	let state: State = "normal";

	for (const line of lines) {
		if (line.startsWith("<<<<<<< ")) {
			state = "ours";
			continue;
		}
		if (line === "=======") {
			state = "theirs";
			continue;
		}
		if (line.startsWith(">>>>>>> ")) {
			state = "normal";
			continue;
		}

		if (state === "normal" || state === "theirs") {
			result.push(line);
		}
		// "ours" (HEAD) lines are discarded — we keep incoming agent changes
	}

	return result.join("\n");
}

/** Run tsc --noEmit to typecheck the resolved code before committing */
async function runTypecheck(cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { code, stdout, stderr };
}

/**
 * Resolve merge conflicts between an agent branch and the canonical branch.
 *
 * Tier 1 (clean-merge): attempt git merge --no-edit. If it succeeds, done.
 * Tier 2 (auto-resolve): parse conflict markers, keep incoming changes, commit.
 * On total failure: run git merge --abort to leave the repo clean.
 */
export async function resolve(opts: ResolveOptions): Promise<MergeResult> {
	const { branchName, repoRoot } = opts;

	// ── Tier 1: clean merge ──────────────────────────────────────────────────
	const mergeResult = await git(["merge", "--no-edit", branchName], repoRoot);

	if (mergeResult.code === 0) {
		return {
			success: true,
			tier: "clean-merge",
			conflictFiles: [],
			errorMessage: null,
		};
	}

	// Gather conflicted files
	const allConflictFiles = await getConflictFiles(repoRoot);

	if (allConflictFiles.length === 0) {
		// Non-conflict merge failure (e.g. unrelated histories, missing branch)
		await git(["merge", "--abort"], repoRoot);
		return {
			success: false,
			tier: "clean-merge",
			conflictFiles: [],
			errorMessage: mergeResult.stderr.trim() || "Merge failed with no conflict files",
		};
	}

	// Resolve .grove/* conflicts by keeping our (canonical) version — these are
	// shared runtime files (SQLite DB, WAL) that cannot be text-merged and may
	// be locked by the running Grove process.
	const groveConflicts = allConflictFiles.filter((f) => f.startsWith(".grove/"));
	const conflictFiles = allConflictFiles.filter((f) => !f.startsWith(".grove/"));

	for (const groveFile of groveConflicts) {
		await git(["checkout", "--ours", groveFile], repoRoot);
		await git(["add", groveFile], repoRoot);
	}

	// If all conflicts were .grove/* files, commit and succeed
	if (conflictFiles.length === 0) {
		const commitResult = await git(
			["commit", "--no-edit", "-m", `merge: skip .grove/ runtime files from ${branchName}`],
			repoRoot,
		);
		if (commitResult.code === 0) {
			return {
				success: true,
				tier: "clean-merge",
				conflictFiles: groveConflicts,
				errorMessage: null,
			};
		}
		await git(["merge", "--abort"], repoRoot);
		return {
			success: false,
			tier: "clean-merge",
			conflictFiles: groveConflicts,
			errorMessage: commitResult.stderr.trim() || "Commit after .grove/ resolution failed",
		};
	}

	// ── Tier 2: auto-resolve ─────────────────────────────────────────────────
	try {
		for (const relPath of conflictFiles) {
			const absPath = `${repoRoot}/${relPath}`;
			const raw = await Bun.file(absPath).text();
			const resolved = resolveConflictMarkers(raw);
			await Bun.write(absPath, resolved);
			await git(["add", relPath], repoRoot);
		}

		// Run typecheck before committing to catch type errors introduced by
		// blindly keeping the incoming (agent) side of conflicts.
		const hasTypeScript = conflictFiles.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
		if (hasTypeScript) {
			const tscResult = await runTypecheck(repoRoot);
			if (tscResult.code !== 0) {
				await git(["merge", "--abort"], repoRoot);
				return {
					success: false,
					tier: "auto-resolve",
					conflictFiles,
					errorMessage: `Typecheck failed after auto-resolve:\n${tscResult.stdout}${tscResult.stderr}`,
				};
			}
		}

		const commitResult = await git(
			["commit", "--no-edit", "-m", `merge: auto-resolve conflicts from ${branchName}`],
			repoRoot,
		);

		if (commitResult.code === 0) {
			return {
				success: true,
				tier: "auto-resolve",
				conflictFiles,
				errorMessage: null,
			};
		}

		// Commit failed after resolving — abort
		await git(["merge", "--abort"], repoRoot);
		return {
			success: false,
			tier: "auto-resolve",
			conflictFiles,
			errorMessage: commitResult.stderr.trim() || "Auto-resolve commit failed",
		};
	} catch (err) {
		await git(["merge", "--abort"], repoRoot);
		return {
			success: false,
			tier: "auto-resolve",
			conflictFiles,
			errorMessage: err instanceof Error ? err.message : String(err),
		};
	}
}
