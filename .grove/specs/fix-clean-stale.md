# fix-clean-stale

## Objective

Fix a bug in `grove clean` where it keeps trying to clean agents whose branches and worktrees have already been manually deleted. The agent record stays in the DB indefinitely because the "branch not merged" check fails when the branch no longer exists.

## Problem

1. `grove clean` queries the SQLite DB for agents to clean
2. It checks if the branch has been merged before cleaning (src/index.ts ~line 953)
3. But if the branch was already deleted (via `git branch -D`), the check fails and it says "branch not merged" forever
4. The agent record stays in the DB indefinitely

Also, `cleanAgent()` in `src/agent.ts` calls `removeWorktree()` without checking if the worktree directory still exists, which throws an error if it was already manually deleted.

## Required Changes

### 1. src/worktree.ts — Add branchExists helper

Add a new exported async function `branchExists(branchName: string): Promise<boolean>` that runs `git rev-parse --verify <branchName>` and returns true if exit code is 0, false otherwise. Place it before the `isGitRepo` function.

### 2. src/index.ts — Fix the skip logic in grove clean (~line 950-958)

Import `branchExists` from `./worktree.ts` alongside the existing imports on line 6.

In the for loop that partitions agents into cleanable vs skipped, change the skip condition:
- Before skipping a completed agent whose branch is not in `mergedBranches`, check if the branch actually still exists using `await branchExists(a.branch)`
- If the branch does NOT exist, log a message like `  Branch ${a.branch} no longer exists for ${a.name}, cleaning up.` and let it proceed to `toClean` (don't skip)
- Only skip if the branch DOES still exist and is not merged

### 3. src/agent.ts — Make cleanAgent resilient to missing worktrees

Import `branchExists` from `./worktree.ts` alongside the existing imports on line 11.

In the `cleanAgent` function (line ~1576), before calling `removeWorktree(name)`:
- `existsSync` is already imported (line 2)
- Check if the worktree directory exists: `const worktreePath = process.cwd() + '/.grove/worktrees/' + name;`
- Also check if the branch still exists using `await branchExists(agent.branch)`
- Only call `removeWorktree(name)` if the worktree directory actually exists
- If neither the worktree nor the branch exist, just skip removal silently
- If the worktree exists but the branch doesn't (or vice versa), still try `removeWorktree` but wrap it in try/catch so it doesn't fail the whole clean operation
- Always proceed to the DB update at the end regardless

### 4. Validation

After making changes, run: `bun run typecheck` to verify no type errors.

## Acceptance Criteria

- [ ] `branchExists` helper added to worktree.ts
- [ ] `grove clean` no longer gets stuck on agents with deleted branches — it detects missing branches and cleans them
- [ ] `cleanAgent()` gracefully handles missing worktree directories and branches
- [ ] `bun run typecheck` passes

## File Scope (owned files)

- src/worktree.ts
- src/agent.ts
- src/index.ts

## Context

Key types/imports:
- `removeWorktree(agentName: string)` in `src/worktree.ts` — runs `git worktree remove` then `git branch -D`
- `cleanAgent(name: string)` in `src/agent.ts` — forwards mail, removes worktree, updates DB status to 'cleaned'
- `existsSync` is already imported in `src/agent.ts`
- The `grove clean` command in `src/index.ts` line ~933 partitions agents and calls `cleanAgent`

## Dependencies

None
