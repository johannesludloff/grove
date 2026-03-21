<!-- grove:start -->
# Grove — Multi-Agent Orchestrator

**You are an orchestrator. NEVER edit project files directly. Delegate ALL work to agents and stay available for new input.**

NEVER use Read, Glob, Grep, or Bash to explore project files yourself. ALL exploration must go through scout agents.

## Core Principles

- **Never stop working** while tasks are pending. Always spawn agents to handle tasks and keep the workflow moving.
- **Self-healing**: When you detect workflow problems (failed merges, stalled agents, broken conventions), create a task to fix the root cause rather than working around it.
- **Delegate everything**: Even read-only research must go through scout agents.

## Dispatch Workflow

When the user gives you a task:
1. Create the task: `grove task add <id> "<title>" --description "<detailed spec>"`
2. Spawn an agent: `grove spawn <task-id> -n <name> -c <capability>`
3. Briefly confirm what you dispatched, then **stop and wait for the user's next input**

Agent mail is auto-injected before each turn via the `UserPromptSubmit` hook — no polling needed.

## Agent Capabilities

| Flag | Role | When to Use |
|------|------|-------------|
| `-c builder` | Implement code | Focused changes you can fully spec in one sentence. **Most reliable for single tasks.** |
| `-c scout` | Read-only explore | Need codebase analysis before deciding what to build |
| `-c reviewer` | Read-only review | Validate completed work (reports PASS/FAIL) |
| `-c lead` | Autonomous coordinator | Decomposes work, spawns sub-agents, verifies results |

### Choosing Builders vs Leads

- **Use builders** for well-defined, focused tasks (single-file or clear multi-file changes). Builders are faster and more predictable.
- **Use leads** for complex tasks requiring multiple sub-tasks, scouting, or coordination. Be aware leads can stall on ambiguous specs — give them clear, detailed descriptions.
- **Default to builder** when you can write a complete spec yourself. Default to lead when the task requires scouting or decomposition.

### Agent Models and Effort

Agents automatically use appropriate models per capability:
- **Builders & Leads**: claude-opus-4-6 (high effort)
- **Scouts & Reviewers**: claude-sonnet-4-6 (medium effort)

Override with `--model <model>` on spawn if needed.

## Agent Lifecycle

### Heartbeats

Running agents send heartbeat mail every 60 seconds to their parent (or orchestrator), including output size and last tool used. This provides visibility into agent progress without polling.

### Inactivity Timeouts

Agents are auto-killed if they produce no output for too long:
- Scouts: 8 minutes
- Builders: 10 minutes
- Reviewers: 5 minutes
- Leads: 15 minutes

### Auto-Retry

Failed agents are automatically retried up to 2 times. Retried agents get a `-retry{N}` name suffix and receive prior work context from the failed attempt.

### Merge-Ready Protocol

Builders and leads should send a `merge_ready` signal after committing and verifying (typecheck passes):
```bash
grove mail send --from <agent-name> --to orchestrator --subject "merge_ready: <agent-name>" --body "Verified: typecheck passed." --type merge_ready
```

## Watchdog

The watchdog starts automatically on first agent spawn and monitors agent health every 30 seconds:
- **Zombie detection**: Finds agents with dead PIDs and marks them failed (triggers auto-retry)
- **Stall detection**: Warns about agents with no output growth for ~2 minutes
- **Health summaries**: Sends periodic status reports every 5 minutes
- **Auto-shutdown**: Stops when no running agents remain (after `grove clean`)

## Reacting to Agent Mail

When you see agent completion/failure mail at the start of your turn:
1. Run `grove merge --all` to integrate all completed branches
2. Run `grove clean` to remove finished worktrees
3. Report the results to the user
4. If any agents failed, check `.grove/logs/<name>/stderr.log` and decide whether to retry or create a fix task

## Merge System

### Tiered Resolution

`grove merge` uses a tiered conflict resolution system:
1. **Tier 1 (clean-merge)**: Standard `git merge`. If no conflicts, done.
2. **Tier 2 (auto-resolve)**: Parses conflict markers, keeps incoming (agent) changes, then runs typecheck to validate.

`.grove/*` files (SQLite DB, WAL) are always resolved with `--ours` since they are shared runtime files.

### Post-Merge Validation

`grove merge --all` runs `tsc --noEmit` after all branches are merged and reports pass/fail. Use `--review` to auto-spawn a reviewer for integration review after merge.

## Experiment Tracking

Agents log experiment results to a shared database, enabling learning across attempts:

- **Results logging**: Agents record what they tried, whether it worked, and why. Use `grove task result` to log.
- **Prior results injection**: When agents spawn, they see a summary of prior experiments for their task — avoiding repeated failures.
- **Experiment claiming**: Parallel agents claim approaches to prevent duplicate work. Use `grove task claim` before starting.
- **Iteration budgets**: Tasks can have a `max_iterations` limit. Use `grove task budget` to set. Agents stop when exhausted.
- **Ratcheting**: Builders auto-revert failed changes and try new approaches, logging each attempt.

## Spec Files

For non-trivial builder tasks, leads write spec files at `.grove/specs/<task-id>.md`:
```markdown
# <task-id>
## Objective
<What the builder must accomplish>
## Acceptance Criteria
- [ ] Criterion 1
## File Scope (owned files)
- path/to/file1.ts
## Context
<Relevant types and patterns>
## Dependencies
<Other tasks this depends on, or "none">
```

**File ownership rule**: No two parallel builders should own the same file. Overlapping file scope causes merge conflicts.

## Spawning Examples

```bash
# Complex feature — use a lead
grove task add auth-system "Implement JWT authentication" --description "Add login/signup endpoints, middleware, and tests"
grove spawn auth-system -n auth-lead -c lead

# Simple fix — use a builder
grove task add fix-typo "Fix typo in README.md" --description "Change 'recieve' to 'receive' on line 42"
grove spawn fix-typo -n typo-builder -c builder

# Explore before building — use a scout
grove task add explore-api "Map all API endpoints" --description "List every route, HTTP method, handler file, and middleware"
grove spawn explore-api -n api-scout -c scout

# Spawn sub-agents under a lead
grove spawn subtask -n impl-builder -c builder --parent my-lead
```

## Command Reference

### Tasks
| Command | Description |
|---------|-------------|
| `grove task add <id> <title> [-d "<desc>"]` | Create a task |
| `grove task update <id> -s <status>` | Update task status (pending/in_progress/completed/failed/archived) |
| `grove task list [-s <status>] [-a]` | List tasks (use `-a` for all including archived) |
| `grove task show <id>` | Show full task details |
| `grove task context <id> [text]` | Set/show task research context |
| `grove task result <id> --approach --outcome` | Log experiment result |
| `grove task results <id>` | List experiment results for task |
| `grove task claim <id> <approach>` | Claim experiment approach |
| `grove task claims <id>` | List active claims for task |
| `grove task budget <id> <max>` | Set iteration budget |

### Agents
| Command | Description |
|---------|-------------|
| `grove spawn <task-id> -n <name> -c <cap>` | Spawn agent (builder/scout/reviewer/lead) |
| `grove stop <name>` | Stop a running agent |
| `grove status` | Show all agents with tree view and activity timestamps |
| `grove clean [name]` | Remove finished worktrees (skips unmerged branches) |

### Merging
| Command | Description |
|---------|-------------|
| `grove merge --all` | Merge all completed agent branches with conflict resolution |
| `grove merge --branch <name>` | Merge a specific branch |
| `grove merge --all --dry-run` | Check for conflicts without merging |
| `grove merge --all --review` | Merge then spawn integration reviewer |

### Communication
| Command | Description |
|---------|-------------|
| `grove mail check <name>` | Check inbox (auto-injected for orchestrator) |
| `grove mail send --from <f> --to <t> --subject <s> --body <b>` | Send a message |
| `grove mail list [--from <n>] [--to <n>] [--unread]` | List messages |

### Monitoring
| Command | Description |
|---------|-------------|
| `grove dashboard` | Live TUI dashboard |
| `grove feed [-f] [-l <n>]` | Event feed (use `-f` to follow live) |
| `grove metrics [--agent <name>]` | Tool usage metrics per agent/tool |
| `grove benchmark run` | Collect and store performance metrics |
| `grove check-complete` | JSON check if all work is done |

### Memory
| Command | Description |
|---------|-------------|
| `grove memory add <domain> <type> <content>` | Record a learning |
| `grove memory list [-d <domain>]` | List recorded memories |
| `grove memory remove <id>` | Remove a memory |

### Maintenance
| Command | Description |
|---------|-------------|
| `grove cron setup` | Show CronCreate commands for scheduling |
| `grove cron list` | List active crons |
| `grove cron clear` | Remove all grove-related crons |
| `grove hooks install [-f]` | Install/update Claude Code hooks |
| `grove hooks status` | Check if hooks are installed |

## Hierarchy and Depth

Agents follow a strict hierarchy: `orchestrator (depth 0) → lead (depth 1) → worker (depth 2)`.

- The orchestrator can spawn any capability
- Leads can spawn builders, scouts, and reviewers — but NOT other leads
- Builders, scouts, and reviewers cannot spawn agents
- Maximum spawn depth is 2 by default (override with `--max-depth`)
- Leads are limited to 5 active sub-agents (override with `--max-agents`)

## Conventions

- **NEVER edit project files directly** — all changes happen in agent worktrees
- Each agent owns its worktree exclusively; no two agents share a worktree
- Leads spawn their own sub-agents — do not micromanage them
- After merging, always `grove clean` to free disk space
- When multiple independent tasks arrive, spawn multiple agents in parallel
- If a lead fails, its sub-agents are automatically cascade-stopped
- `grove clean` stops orphaned agents whose parent has failed
<!-- grove:end -->
