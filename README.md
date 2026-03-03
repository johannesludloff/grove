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

## Quick Start

```bash
# Install globally
bun link

# Initialize in any project
cd your-project
grove init

# Start a new Claude Code session — grove hooks activate automatically
```

The orchestrator sees every user request and dispatches it:

```bash
grove task add auth "Add JWT authentication" --description "Login endpoint, middleware, tests"
grove spawn auth -n auth-lead -c lead
# Lead autonomously scouts, spawns builders, verifies, and reports back
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
