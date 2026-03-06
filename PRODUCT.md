# Grove Product Document

## High-Level Overview

Grove is a multi-agent orchestration framework for AI-powered software engineering. It coordinates multiple Claude Code agents working in parallel on the same codebase, each in isolated git worktrees, with automated merge resolution, quality gates, and lifecycle management. The core idea: instead of one AI agent editing files sequentially, Grove dispatches a team of specialized agents (scouts, builders, reviewers, leads) all working simultaneously on separate branches that merge back cleanly. It mirrors how real engineering teams operate: decompose, delegate, build in parallel, merge, validate.

---

## Detailed Product Document

### Vision

Build an agent framework that securely and effectively handles changes in big codebases while developing a growing understanding of the codebase as work progresses.

### Architecture

Grove follows a dispatch-and-delegate model:

1. **Orchestrator** — The user's Claude Code session. It creates tasks (`grove task add`) and spawns agents (`grove spawn`). It never edits project files directly; all changes happen in agent worktrees.

2. **Four agent types**, each with a distinct role:

   | Type | Role | Can Write? |
   |------|------|------------|
   | **Lead** | Decompose tasks, spawn sub-agents, verify results | Yes |
   | **Builder** | Implement code changes | Yes |
   | **Scout** | Read-only codebase exploration | No |
   | **Reviewer** | Read-only code review | No |

3. **Git worktree isolation** — Each agent gets its own worktree (`.grove/worktrees/<name>`) and branch (`grove/<name>`). Agents never share a working directory.

4. **SQLite-backed state** — All agent state, tasks, mail, memories, merge queue, and events are stored in `.grove/grove.db` using `bun:sqlite` with WAL mode and a 5-second busy timeout.

5. **Mail system** — Agents communicate via a SQLite mail table. Messages have types (`status`, `question`, `result`, `error`, `done`) and are addressed by agent name. Unread mail is auto-delivered to the orchestrator via a Claude Code Stop hook.

6. **Claude Code hooks** — Two hooks integrate Grove with Claude Code sessions:
   - `SessionStart` (PreToolUse): Primes the orchestrator with Grove context and guards against direct file edits.
   - `Stop` (PostToolUse): Polls for agent completion mail and injects it into the conversation.

### Agent Capabilities and Model Selection

Each capability has a default model and inactivity timeout:

| Capability | Model | Timeout | Tools |
|------------|-------|---------|-------|
| Scout | claude-sonnet-4-6 | 3 min | Bash, Read, Glob, Grep |
| Builder | claude-opus-4-6 | 10 min | Bash, Read, Write, Edit, Glob, Grep |
| Reviewer | claude-sonnet-4-6 | 5 min | Bash, Read, Glob, Grep |
| Lead | claude-opus-4-6 | 15 min | Bash, Read, Write, Edit, Glob, Grep |

Models can be overridden per-agent with `grove spawn --model <model>`.

Agents are monitored via stdout polling every 10 seconds. If no new output is produced within the timeout window, the agent is killed and marked as failed. Active agents send heartbeat mail every 2 minutes.

### Task Decomposition

Leads assess task complexity using file-count thresholds:

| Tier | File Count | Strategy |
|------|-----------|----------|
| **Simple** | 1-3 files | Lead handles directly, no sub-agents needed |
| **Moderate** | 3-6 files | Single builder with a spec file; lead self-verifies the diff |
| **Complex** | 6+ files | Full scout, spec, build, review pipeline |

**Spec files** (`.grove/specs/<task-id>.md`) define:
- Objective and acceptance criteria
- File scope (owned files)
- Context from scout findings
- Dependencies on other tasks

**File ownership rule**: Each builder's spec lists the files it owns. No two builders may own the same file. This prevents the **OVERLAPPING_FILE_SCOPE** failure mode, where parallel builders editing the same file cause merge conflicts.

**Depth limit**: `maxDepth=2` enforces a three-level hierarchy:
- Orchestrator (depth 0) spawns leads (depth 1)
- Leads spawn workers — builders, scouts, reviewers (depth 2)
- Deeper spawning is blocked

**Dual-scout pattern**: For tasks spanning multiple subsystems (e.g., CLI + library, backend + frontend), leads spawn two scouts in parallel with distinct focus areas for broader coverage.

**Named failure modes** leads are trained to avoid:
- `SPEC_WITHOUT_SCOUT` — Writing a builder spec without reading relevant code first
- `SCOUT_SKIP` — Skipping scouts for complex multi-file tasks
- `UNNECESSARY_SPAWN` — Spawning agents for trivial 3-line changes
- `SILENT_FAILURE` — Not reporting failures to the orchestrator
- `INFINITE_REVISION` — Retrying a builder more than 3 times without escalating
- `SILENT_DELEGATION` — Not logging reasoning before delegation decisions
- `OVERLAPPING_FILE_SCOPE` — Two builders owning the same file

### Merge Pipeline

When agents complete their work, the orchestrator runs `grove merge --all`:

1. **Reconcile zombies** — Check PID liveness for all agents marked as running/spawning. Dead processes are marked failed with error mail sent.

2. **Sort by completion time** — Oldest completed agents merge first (`ORDER BY updatedAt ASC`).

3. **Skip already-merged** — The `merge_queue` table tracks which branches have been merged. Branches with status `merged` are skipped, providing idempotency.

4. **Tier 1: Clean merge** — `git merge --no-edit <branch>`. If it succeeds with no conflicts, done.

5. **Tier 2: Auto-resolve** — If conflicts exist, parse conflict markers and keep the incoming (agent) changes. `.grove/*` conflicts are auto-resolved with `--ours` since these are shared runtime files (SQLite DB, WAL) that cannot be text-merged.

6. **Post-merge typecheck** — Automatically runs `tsc --noEmit` after all branches are merged. Reports pass/fail with up to 20 lines of error output.

7. **Optional integration review** — With `grove merge --all --review`, a reviewer agent is spawned to check for duplicate implementations, conflicting patterns, missing cross-feature wiring, and logical regressions. Only spawned if the typecheck passes.

**Safety**: `grove clean` refuses to delete worktrees for completed agents whose branches have not been merged yet. Orphaned agents (parent failed/stopped) are automatically stopped and cleaned.

### Feature Evolution

Grove was built in five phases:

**Phase 1 — Foundation**
- Dashboard TUI with live agent monitoring
- Agent spawning with isolated git worktrees
- SQLite-backed state management
- Merge queue with tiered conflict resolver
- Claude Code hooks for session priming and mail delivery
- Event feed for real-time visibility

**Phase 2 — Agent Hierarchy**
- Parent-child relationships (`--parent` flag, `parentName` in DB)
- Tree views in `grove status` (children shown with `└─` prefix)
- Lead agents that decompose and delegate
- Cascade stop (stopping a lead stops all its children)
- Orphaned mail forwarding to orchestrator on agent cleanup

**Phase 3 — Reliability**
- Heartbeat mail every 2 minutes while agent is producing output
- Inactivity timeout detection with auto-kill
- Zombie PID reconciliation (ZFC principle: if PID is dead, agent is dead)
- Merge safety: skip already-merged branches, `.grove/*` conflict handling
- Poll guards (anti-loop in Stop hook via `stop_hook_active` check)

**Phase 4 — Quality and Efficiency**
- Post-merge typecheck (`tsc --noEmit`, automatic)
- Integration reviewer spawned after merge (optional `--review` flag)
- Per-capability model selection (Opus for builders/leads, Sonnet for scouts/reviewers)
- Per-capability inactivity timeouts
- Heartbeat mail with stdout size tracking

**Phase 5 — Smart Decomposition**
- File-count thresholds (Simple/Moderate/Complex)
- Spec files (`.grove/specs/`) with file ownership and acceptance criteria
- `OVERLAPPING_FILE_SCOPE` prevention
- Depth limits (`maxDepth=2`)
- Dual-scout pattern for multi-subsystem tasks
- Named failure modes for lead training

### Current Gaps and Future Direction

| Gap | Description |
|-----|-------------|
| Codebase memory | Auto-learn from scout findings, conflict patterns, and review outcomes to build persistent project understanding |
| Test suite | Zero tests exist; the framework has no automated test coverage |
| Configurable quality gates | Per-project `config.yaml` for custom validation commands beyond `tsc --noEmit` |
| Conflict learning | Track per-file tier outcomes to predict which files will conflict and pre-assign ownership |
| AI-assisted merge (Tier 3+) | LLM-powered conflict resolution for cases where auto-resolve produces incorrect results |
| `merge=union` gitattributes | Use git's union merge driver for append-only files (e.g., changelogs) |
| CI/CD integration | Trigger pipelines after merge, gate on CI status before marking branches as merged |
| Multi-project support | Orchestrate agents across multiple repositories or monorepo packages |

### What Makes Grove Different

1. **Isolation by default** — Every agent works in its own git worktree. No shared state, no file locking, no race conditions on disk.

2. **Hierarchical delegation** — Mirrors real engineering teams. Leads decompose work, builders implement, scouts gather context, reviewers validate. The orchestrator stays hands-off.

3. **Self-healing** — Zombie detection via PID reconciliation, inactivity timeouts with auto-kill, cascade stops when leads fail, merge safety guards that prevent data loss.

4. **Growing understanding** — Memory system records learnings across agent sessions. Scout findings inform builder specs. Conflict history teaches the system which files need careful ownership.

5. **Quality gates** — Post-merge typecheck catches integration errors immediately. Optional integration reviewer validates cross-cutting concerns that individual builders cannot see.

### Command Reference

| Command | Description |
|---------|-------------|
| `grove init` | Initialize `.grove/` directory, database, hooks, and CLAUDE.md |
| `grove prime` | Print orchestrator context (used by SessionStart hook) |
| `grove hooks install` | Install Claude Code hooks into `.claude/settings.local.json` |
| `grove hooks uninstall` | Remove grove hooks |
| `grove hooks status` | Check if hooks are installed |
| `grove task add <id> <title> [-d "<desc>"]` | Create a task |
| `grove task list [-s <status>]` | List tasks, optionally filtered by status |
| `grove spawn <task-id> -n <name> -c <cap> [--model <m>] [--parent <p>]` | Spawn an agent |
| `grove stop <name>` | Stop a running agent (cascades to children) |
| `grove status` | Show all agents with hierarchy, reconcile zombies first |
| `grove dashboard [-i <ms>]` | Live TUI dashboard for agent monitoring |
| `grove feed [-f] [-l <n>]` | Show event feed, optionally follow in real time |
| `grove mail send --from <f> --to <t> --subject <s> --body <b> [--type <type>]` | Send inter-agent mail |
| `grove mail check <name>` | Check inbox for an agent |
| `grove mail deliver` | Stop hook target: deliver pending orchestrator mail |
| `grove mail list [--from <f>] [--to <t>] [--unread]` | List mail messages |
| `grove memory add <domain> <type> <content>` | Record a learning |
| `grove memory list [-d <domain>]` | List stored memories |
| `grove memory remove <id>` | Remove a memory entry |
| `grove merge --branch <name>` | Merge a specific branch into canonical |
| `grove merge --all [--review] [--dry-run]` | Merge all completed agents, with optional typecheck and review |
| `grove clean [name]` | Remove finished worktrees (refuses unmerged) |
| `grove guard` | PreToolUse hook: block orchestrator from editing project files |

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Bun |
| Language | TypeScript (strict mode) |
| Database | SQLite via `bun:sqlite` (WAL mode) |
| Isolation | Git worktrees |
| AI backend | Claude Code CLI (`claude -p`) |
| CLI framework | Commander.js |
| Process management | `Bun.spawn` with PID tracking |
