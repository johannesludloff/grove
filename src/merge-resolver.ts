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
export function resolveConflictMarkers(content: string): string {
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

/** Parse AI response to extract resolved file contents delimited by === FILE/END FILE markers */
function parseAiResponse(output: string): Map<string, string> {
	const resolved = new Map<string, string>();
	const lines = output.split("\n");
	let currentFile: string | null = null;
	let currentContent: string[] = [];

	for (const line of lines) {
		const fileStart = line.match(/^=== FILE: (.+?) ===$/);
		const fileEnd = /^=== END FILE ===$/.test(line);

		if (fileStart) {
			if (currentFile) {
				resolved.set(currentFile, currentContent.join("\n"));
			}
			currentFile = (fileStart[1] ?? "").trim();
			currentContent = [];
		} else if (fileEnd && currentFile) {
			resolved.set(currentFile, currentContent.join("\n"));
			currentFile = null;
			currentContent = [];
		} else if (currentFile !== null) {
			currentContent.push(line);
		}
	}

	// Handle unclosed last file
	if (currentFile && currentContent.length > 0) {
		resolved.set(currentFile, currentContent.join("\n"));
	}

	return resolved;
}

interface AiResolveResult {
	success: boolean;
	resolvedFiles: Map<string, string>;
	errorMessage: string | null;
}

/** Use AI (Claude) to resolve merge conflicts that auto-resolve couldn't handle */
async function aiResolveConflicts(
	rawConflicts: Map<string, string>,
	repoRoot: string,
): Promise<AiResolveResult> {
	const parts: string[] = [
		"You are resolving git merge conflicts. Below are files with conflict markers (<<<<<<< ======= >>>>>>>).",
		"For each file, intelligently merge both sides of each conflict to produce correct, working code that preserves the intent of both changes.",
		"",
		"Output the COMPLETE resolved file contents using this exact format for each file:",
		"",
		"=== FILE: <path> ===",
		"<complete resolved file content>",
		"=== END FILE ===",
		"",
		"Rules:",
		"- Output ONLY the file markers and resolved content. No explanations, no markdown code fences.",
		"- Preserve all imports, type definitions, and function signatures from both sides.",
		"- If both sides add different code to the same location, include both additions in a logical order.",
		"- Ensure the result is valid TypeScript that will pass type checking.",
		"",
	];

	for (const [relPath, content] of rawConflicts) {
		parts.push(`=== CONFLICT: ${relPath} ===`);
		parts.push(content);
		parts.push(`=== END CONFLICT ===`);
		parts.push("");
	}

	const prompt = parts.join("\n");

	// Filter out CLAUDECODE env var from subprocess environment
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key !== "CLAUDECODE" && value !== undefined) {
			env[key] = value;
		}
	}

	const proc = Bun.spawn(["claude", "-p", "--model", "claude-sonnet-4-6"], {
		cwd: repoRoot,
		stdin: new Blob([prompt]),
		stdout: "pipe",
		stderr: "pipe",
		env,
	});

	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	if (exitCode !== 0) {
		return {
			success: false,
			resolvedFiles: new Map(),
			errorMessage: `claude -p failed (exit ${exitCode}): ${stderr.trim()}`,
		};
	}

	// Parse AI response
	const resolvedFiles = parseAiResponse(stdout);

	// Verify all conflict files were resolved
	const missingFiles: string[] = [];
	for (const relPath of rawConflicts.keys()) {
		if (!resolvedFiles.has(relPath)) {
			missingFiles.push(relPath);
		}
	}

	if (missingFiles.length > 0) {
		return {
			success: false,
			resolvedFiles,
			errorMessage: `AI did not resolve files: ${missingFiles.join(", ")}`,
		};
	}

	return { success: true, resolvedFiles, errorMessage: null };
}

/**
 * Resolve merge conflicts between an agent branch and the canonical branch.
 *
 * Tier 1 (clean-merge): attempt git merge --no-edit. If it succeeds, done.
 * Tier 2 (auto-resolve): parse conflict markers, keep incoming changes, typecheck, commit.
 * Tier 3 (ai-resolve): use Claude to intelligently resolve conflicts, typecheck, commit.
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

	// Save raw conflict content (with markers) for potential Tier 3 use
	const rawConflicts = new Map<string, string>();
	for (const relPath of conflictFiles) {
		const absPath = `${repoRoot}/${relPath}`;
		rawConflicts.set(relPath, await Bun.file(absPath).text());
	}

	// ── Tier 2: auto-resolve ─────────────────────────────────────────────────
	let tier2TypecheckFailed = false;
	try {
		for (const relPath of conflictFiles) {
			const raw = rawConflicts.get(relPath)!;
			const resolved = resolveConflictMarkers(raw);
			await Bun.write(`${repoRoot}/${relPath}`, resolved);
			await git(["add", relPath], repoRoot);
		}

		// Run typecheck before committing to catch type errors introduced by
		// blindly keeping the incoming (agent) side of conflicts.
		const hasTypeScript = conflictFiles.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
		if (hasTypeScript) {
			const tscResult = await runTypecheck(repoRoot);
			if (tscResult.code !== 0) {
				// Typecheck failed — don't abort yet, fall through to Tier 3
				tier2TypecheckFailed = true;
			}
		}

		if (!tier2TypecheckFailed) {
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

			// Commit failed after resolving — abort (Tier 3 won't help here)
			await git(["merge", "--abort"], repoRoot);
			return {
				success: false,
				tier: "auto-resolve",
				conflictFiles,
				errorMessage: commitResult.stderr.trim() || "Auto-resolve commit failed",
			};
		}
	} catch (err) {
		await git(["merge", "--abort"], repoRoot);
		return {
			success: false,
			tier: "auto-resolve",
			conflictFiles,
			errorMessage: err instanceof Error ? err.message : String(err),
		};
	}

	// ── Tier 3: AI-resolve ──────────────────────────────────────────────────
	// Tier 2 resolved markers (keep-theirs) but typecheck failed.
	// We're still in merge state — ask AI to re-resolve the conflicts intelligently.
	try {
		const aiResult = await aiResolveConflicts(rawConflicts, repoRoot);
		if (!aiResult.success) {
			await git(["merge", "--abort"], repoRoot);
			return {
				success: false,
				tier: "ai-resolve",
				conflictFiles,
				errorMessage: aiResult.errorMessage || "AI conflict resolution failed",
			};
		}

		// Write AI-resolved content and re-stage
		for (const [relPath, content] of aiResult.resolvedFiles) {
			await Bun.write(`${repoRoot}/${relPath}`, content);
			await git(["add", relPath], repoRoot);
		}

		// Typecheck the AI resolution
		const hasTypeScript = conflictFiles.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
		if (hasTypeScript) {
			const tscResult = await runTypecheck(repoRoot);
			if (tscResult.code !== 0) {
				await git(["merge", "--abort"], repoRoot);
				return {
					success: false,
					tier: "ai-resolve",
					conflictFiles,
					errorMessage: `AI-resolve typecheck failed:\n${tscResult.stdout}${tscResult.stderr}`,
				};
			}
		}

		const commitResult = await git(
			["commit", "--no-edit", "-m", `merge: ai-resolve conflicts from ${branchName}`],
			repoRoot,
		);

		if (commitResult.code === 0) {
			return {
				success: true,
				tier: "ai-resolve",
				conflictFiles,
				errorMessage: null,
			};
		}

		await git(["merge", "--abort"], repoRoot);
		return {
			success: false,
			tier: "ai-resolve",
			conflictFiles,
			errorMessage: commitResult.stderr.trim() || "AI-resolve commit failed",
		};
	} catch (err) {
		await git(["merge", "--abort"], repoRoot);
		return {
			success: false,
			tier: "ai-resolve",
			conflictFiles,
			errorMessage: err instanceof Error ? err.message : String(err),
		};
	}
}
