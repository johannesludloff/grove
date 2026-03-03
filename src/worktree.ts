/** Git worktree management */

const WORKTREE_DIR = ".grove/worktrees";

/** Create a git worktree for an agent */
export async function createWorktree(
	agentName: string,
	baseBranch: string,
): Promise<{ worktreePath: string; branch: string }> {
	const branch = `grove/${agentName}`;
	const worktreePath = `${process.cwd()}/${WORKTREE_DIR}/${agentName}`;

	// Clean up stale branch/worktree if they exist from a previous run
	const pruneProc = Bun.spawn(["git", "worktree", "prune"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	await pruneProc.exited;

	const branchCheck = Bun.spawn(["git", "rev-parse", "--verify", branch], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	if ((await branchCheck.exited) === 0) {
		// Branch exists — delete it so we can recreate from baseBranch
		const delProc = Bun.spawn(["git", "branch", "-D", branch], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		});
		await delProc.exited;
	}

	const proc = Bun.spawn(["git", "worktree", "add", worktreePath, "-b", branch, baseBranch], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`Failed to create worktree: ${stderr.trim()}`);
	}

	return { worktreePath, branch };
}

/** Remove a git worktree */
export async function removeWorktree(agentName: string): Promise<void> {
	const worktreePath = `${process.cwd()}/${WORKTREE_DIR}/${agentName}`;

	const proc = Bun.spawn(["git", "worktree", "remove", worktreePath, "--force"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`Failed to remove worktree: ${stderr.trim()}`);
	}
}

/** List all grove worktrees */
export async function listWorktrees(): Promise<string[]> {
	const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) return [];

	const output = await new Response(proc.stdout).text();
	const worktrees: string[] = [];

	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ") && line.includes(WORKTREE_DIR)) {
			worktrees.push(line.replace("worktree ", ""));
		}
	}

	return worktrees;
}

/** Get the current branch name */
export async function getCurrentBranch(): Promise<string> {
	const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error("Not a git repository");

	return (await new Response(proc.stdout).text()).trim();
}
