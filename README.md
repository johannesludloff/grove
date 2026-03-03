# Grove

Windows-native multi-agent orchestrator for Claude Code. Turns a single Claude Code session into a dispatch hub that spawns worker agents in git worktrees, coordinates them through SQLite mail, and merges their work back automatically.

## How It Works

Your Claude Code session becomes the **orchestrator**. It never edits project files directly — instead it creates tasks, spawns agents, and merges their completed branches.

```
Orchestrator (your Claude Code session)
  --> Lead (decomposes work, spawns sub-agents, verifies results)
        --> Builder (implements code changes)
        --> Scout (read-only exploration)
        --> Reviewer (read-only code review)
```

Hooks enforce this: a `PreToolUse` guard blocks the orchestrator from using Write/Edit tools on project files, forcing delegation.

## Prerequisites

- **[Bun](https://bun.sh) ≥ 1.0** — runtime and package manager (replaces Node/npm)
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI)** — must be on your `PATH`; agents are spawned via `claude -p`
- **Git** — repositories must be initialized; grove uses git worktrees for agent isolation
- **An Anthropic API key** — configured for Claude Code (see `claude auth` or `ANTHROPIC_API_KEY`)

> **Windows note:** Grove is designed and tested on Windows (MINGW64/Git Bash). It runs on macOS/Linux too, but Windows is the primary target.

## Installation

**1. Clone the grove repository**

```bash
git clone https://github.com/your-org/grove.git
cd grove
```

**2. Install dependencies**

```bash
bun install
```

**3. Link the `grove` command globally**

```bash
bun link
```

This registers `grove` as a global command. Verify:

```bash
grove --version
```

## Project Setup

Run `grove init` once inside any git repository you want to orchestrate:

```bash
cd your-project
grove init
```

`grove init` does three things:
1. Creates `.grove/` — the runtime directory (SQLite DB, worktrees, logs)
2. Installs Claude Code hooks into `.claude/settings.local.json` — enables automatic mail delivery and the orchestrator guard
3. Writes (or updates) `CLAUDE.md` — injects orchestrator instructions so Claude Code knows to delegate all work

**Verify hooks are installed:**

```bash
grove hooks status
# Hooks installed.
```

## Quick Start

Open a new Claude Code session in the initialized project. Grove hooks activate automatically — the `SessionStart` hook primes Claude with orchestrator context, and `UserPromptSubmit` injects unread agent mail before each turn.

Give Claude a task:

```bash
grove task add auth "Add JWT authentication" --description "Login endpoint, middleware, tests"
grove spawn auth -n auth-lead -c lead
# Lead autonomously scouts, spawns builders, verifies, and reports back
```

When the lead reports back (injected automatically into your next prompt), merge its work:

```bash
grove merge --all
grove clean
```

## Agent Capabilities

| Flag | Role | Description |
|------|------|-------------|
| `-c lead` | Lead | Autonomous coordinator. Decomposes work, spawns sub-agents, verifies results. **Default for most tasks.** |
| `-c builder` | Builder | Implements code changes in its worktree. |
| `-c scout` | Scout | Read-only codebase exploration and analysis. |
| `-c reviewer` | Reviewer | Read-only code review and validation. |

## Architecture

- **Runtime:** Bun (TypeScript, no build step)
- **Database:** Single SQLite file (`.grove/grove.db`) with WAL mode for concurrent access
- **Agent spawning:** `Bun.spawn` running `claude -p` in isolated git worktrees
- **Communication:** SQLite-backed mail system, auto-injected via Claude Code hooks
- **Merge:** Two-tier resolver (clean merge, then auto-resolve keeping agent changes)
- **Guard:** `PreToolUse` hook blocks orchestrator file edits, enforcing delegation

## Commands

| Command | Description |
|---------|-------------|
| `grove init` | Initialize `.grove/` and install Claude Code hooks |
| `grove task add <id> <title>` | Create a task |
| `grove spawn <task-id> -n <name> -c <cap>` | Spawn an agent |
| `grove status` | Show all agents and their state |
| `grove merge --all` | Merge all completed branches |
| `grove mail check <name>` | Check agent inbox |
| `grove stop <name>` | Stop a running agent |
| `grove clean` | Remove finished worktrees |
| `grove dashboard` | Live TUI dashboard |
| `grove feed` | Stream event feed |
| `grove memory add <domain> <type> <content>` | Record a cross-session learning |

## Acknowledgments

Inspired by [Overstory](https://github.com/jayminwest/overstory) by Jaymin West — a project-agnostic swarm system for Claude Code agent orchestration. Grove takes Overstory's core ideas (worktree isolation, SQLite mail, tiered merge, hook-driven orchestration) and reimplements them as a lightweight, Windows-native alternative using Bun's built-in APIs.

## License

MIT
