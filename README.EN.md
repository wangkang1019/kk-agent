# KK-Agent

[中文](README.md) | [English](README.EN.md)

A local command-line agent for personal learning.

## Author

I am Kang Wang, a PhD student in Artificial Intelligence.

Affiliation: School of Artificial Intelligence, Chongqing University of Posts and Telecommunications, Chongqing 400065, China; Chongqing College of Artificial Intelligence, Chongqing 401339, China.

- GitHub: <https://github.com/wangkang1019>
- Douyin: [My Douyin Profile](https://www.douyin.com/user/MS4wLjABAAAAxRZTSupsJ4AqmOKjY7JLgcN4gW2jnzbP_CtqEO3v_Xo)
- Email: wangkang19971019@163.com / wangkang19971019@gmail.com

## Overview

KK-Agent is a local command-line tool that I built from scratch while learning and reproducing the core ideas behind terminal-native coding agents such as Claude Code and Codex. It is not just a thin wrapper around an LLM API. It is an agentic CLI system built layer by layer with clear engineering boundaries.

It can:

- hold multi-turn conversations with LLMs
- stream model responses
- read, search, and edit project files
- execute shell commands
- control risky actions through a permission system
- manage context, sessions, memory, tasks, Hooks, Skills, MCP, SubAgents, and more

Many people first learn about agents by reading concepts or using tools like Claude Code and Codex. I believe that building an agent step by step is the best way to deeply understand tool calling, permission boundaries, context engineering, session orchestration, and system resilience.

This project is the engineering record of that learning process.

## Tech Stack

- Language: TypeScript
- Runtime: Node.js
- Module System: ESM
- CLI UI: React + Ink
- LLM SDK: `@anthropic-ai/sdk`
- MCP: `@modelcontextprotocol/sdk`
- Dev Runner: `tsx`
- Build: `tsc`
- Package Manager: npm

Node.js 20+ is recommended.

## Quick Start

### 1. Clone The Project

```bash
git clone https://github.com/wangkang1019/kk-agent.git
cd KK-Agent
```

### 2. Configure The Model Service

The project provides `.env.example`. Copy it to `.env` first:

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Windows CMD:

```cmd
copy .env.example .env
```

macOS / Linux:

```bash
cp .env.example .env
```

Then open `.env` and fill in your DeepSeek API key:

```env
ANTHROPIC_AUTH_TOKEN=
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_MODEL=deepseek-v4-pro
```

Notes:

- `ANTHROPIC_AUTH_TOKEN`: fill in your DeepSeek API key
- `ANTHROPIC_BASE_URL`: DeepSeek's Anthropic-compatible API endpoint
- `ANTHROPIC_MODEL`: defaults to `deepseek-v4-pro`

You can also configure model-related settings in `~/.kk-agent/settings.json` or `.kk-agent/settings.json`.

### 3. Quick Developer Mode

Use this when trying the project for the first time, developing, debugging, or restarting after source changes:

```bash
npm install
npm run dev
```

`npm install` installs project dependencies. You must run it once after cloning the project.  
`npm run dev` runs `src/entrypoint/cli.ts` directly and does not require a build step.

### 4. Persistent Startup

If you want to start KK-Agent from any terminal directory by typing `kk`, register it as a local global command:

```bash
npm install
npm run build
npm link
```

Then run:

```bash
kk
```

This starts KK-Agent.

```text
For quick development: npm install -> npm run dev
For the kk command:   npm install -> npm run build -> npm link, then run kk
```

## Common Commands

Inside KK-Agent, you can use these slash commands:

```text
/help                         Show command help
/clear                        Clear the current conversation context
/history                      Show saved sessions
/resume [latest|session-id]   Resume a saved session
/compact [focus]              Compact conversation context
/rewind [preview] [n]         Preview or restore files to an earlier conversation turn
/cost                         Show token usage
/mode [default|plan|auto]     Show or switch permission mode
/model [name|default]         Show or switch the active model
/tasks [task|todo|reset]      Switch or reset task tracking mode
/mcp                          Show MCP server status
/skills                       Show loaded Skills
/commands                     Show user-defined commands
/agents                       Show SubAgents and background jobs
/teams                        Show Agent Teams status
/sandbox                      Show Bash sandbox status
/hooks                        Show Hooks status
/config                       View or edit configuration
/output-style [name]          Show or switch output style
/exit or /quit                Exit
```

Useful shortcuts:

```text
Ctrl+C      Interrupt the current request, or exit when idle
Ctrl+D      Exit
Shift+Tab   Cycle permission mode
Ctrl+O      Open transcript viewer
```

## Feature Modules

The current capabilities are summarized from the project's local iteration history.

### 1. Basic CLI And Streaming Communication

- TypeScript / Node.js / ESM project scaffold
- CLI entrypoint: `src/entrypoint/cli.ts`
- Anthropic Messages API communication layer
- Streaming output
- Usage token tracking

### 2. React / Ink Terminal UI

- Terminal conversation interface
- Editable input line
- Slash command suggestions
- Command selection panels
- Permission confirmation cards
- Transcript overlay
- Startup Header UI

### 3. Agentic Loop

- Model emits `tool_use`
- Local runtime executes tools
- `tool_result` is returned to the model
- Multi-turn loop continues until the model stops calling tools
- Max-turn protection
- Interrupt control

### 4. Tool System

Core built-in tools:

- `Read`: read files
- `Write`: create or overwrite files
- `Edit`: precise string replacement
- `Grep`: search file contents
- `Glob`: find files
- `Bash`: execute shell commands

Tools are managed through a registry and the permission system.

### 5. Permission System

Supports Allow / Ask / Deny:

- `default`: safe actions are allowed; writes and risky actions require confirmation
- `plan`: read-only planning mode
- `auto`: automatic execution mode

Permission confirmation supports keyboard selection and session-level always-allow rules.

### 6. System Prompt And Context Engineering

- Dynamic system prompt assembly
- Injects cwd, date, OS, and Git status
- Supports project rules and memory
- Supports `--dump-system-prompt`
- Includes behavior rules, tool discipline, safety boundaries, and context rules for a local Agent CLI

### 7. Session Persistence

- JSONL transcript storage
- `/history` for saved sessions
- `/resume` for restoring previous sessions
- Continue conversations after restore

### 8. Project Memory

- Project-level memory directory
- `MEMORY.md` as an index
- File-level long-term memory
- Useful for user preferences, project facts, and testing policies

### 9. Context Compaction And Token Budget

- MicroCompact for old tool results
- Full summary compaction
- Manual `/compact [focus]`
- Automatic compaction
- Context window percentage display
- token warning / blocking strategy

### 10. Plan Mode

- Enter plan mode
- Generate plans
- Approve `ExitPlanMode`
- Supports clearing context to execute, keeping context, manual edit confirmation, or continuing planning

### 11. Todo And Task Systems

- `TodoWrite`: lightweight session todo list
- Task V2: persistent task graph
- Task dependencies, blockers, and status updates
- `/tasks task|todo|reset`

### 12. MCP Integration

- Supports stdio / http / sse MCP servers
- Wraps MCP tools as local tools
- `/mcp` shows server status
- `/mcp tools <name>` lists tools
- `/mcp reconnect <name>` reconnects a server

### 13. Skills

- Loads reusable workflows from `SKILL.md`
- User directory: `~/.kk-agent/skills`
- Project directory: `.kk-agent/skills`
- The model can load a full skill through the `Skill` tool
- Users can invoke a skill explicitly with `/skill-name args`

### 14. Sandbox

- Bash sandbox policy layer
- macOS can integrate with `sandbox-exec`
- Windows currently uses a safe fallback and does not pretend to provide hard OS sandboxing
- `/sandbox` shows sandbox status
- Configurable unsandboxed fallback behavior

### 15. SubAgent

- The `Agent` tool delegates tasks to child agents
- Child agents have independent context
- Custom Agent definitions
- Background agents
- git worktree isolation
- Background task notifications

### 16. Agent Teams

- Create Agent Teams
- Named teammates
- Teammate communication through mailbox files
- Background multi-agent collaboration
- Disabled by default; can be enabled through config or startup flags

### 17. Hooks

Supported lifecycle events:

- `PreToolUse`
- `PostToolUse`
- `UserPromptSubmit`
- `SessionStart`
- `Stop`
- `SubagentStop`

Hooks can block tools, inject context, or modify permission behavior.

### 18. Output Styles And User Commands

- Custom answer styles
- `/output-style` switches the active style
- User-defined slash commands
- Command templates with argument substitution

### 19. Configuration System

- User config: `~/.kk-agent/settings.json`
- User state: `~/.kk-agent/state.json`
- Project config: `.kk-agent/settings.json`
- Local config: `.kk-agent/settings.local.json`
- MCP config: `.kk-agent/mcp.json`
- Multi-source merging, project trust, risky config filtering
- `/config` to view or edit configuration

### 20. Conversation-Level File Rewind

- Creates file snapshots at the start of each user turn
- Backs up files before `Write` / `Edit`
- `/rewind preview [n]` previews rewind impact
- `/rewind [n]` restores files to an earlier turn
- Uses `diff` for line-level statistics

### 21. Error Handling And Resilience

- API error classification
- Automatic retry
- 529 / 429 / network error handling
- Reactive compact after prompt-too-long
- Continuation recovery after max output token limits
- User-friendly error messages

## Project Structure

```text
src/
├── entrypoint/      # CLI startup entry
├── ui/              # React/Ink terminal UI
├── core/            # QueryEngine and Agentic Loop
├── tools/           # Local tools and tool registry
├── services/        # API, MCP, Skills, Extensions
├── permissions/     # Permission system
├── context/         # system prompt, compaction, token budget
├── session/         # transcript, session persistence, file history
├── memory/          # Project memory
├── state/           # Todo, Task, background Agent runtime state
├── agents/          # SubAgent definitions and runners
├── teams/           # Agent Teams
├── hooks/           # Lifecycle Hooks
├── sandbox/         # Bash sandbox policy
├── config/          # Unified configuration system
├── types/           # Shared types
└── utils/           # Utilities
```

## Common Configuration Examples

### `AGENT.md`

The `AGENT.md` file in the project root can be used to define project-level runtime instructions for KK-Agent. It is a good place for project conventions, response preferences, development rules, and testing requirements.

Example:

```md
Start answers with the conclusion.
Before editing code, read README.md and the relevant source files.
After adding a feature, try to run npm run build for verification.
```

When KK-Agent starts, it injects `AGENT.md` as part of the project context so the model can follow these rules while working in the current project.

### `.kk-agent/settings.json`

```json
{
  "mode": "default",
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": true
  },
  "agentTeams": {
    "enabled": false
  }
}
```

### `.kk-agent/commands`

Project-level user command directory. Each Markdown file becomes a slash command.

Example:

```text
.kk-agent/
└── commands/
    └── review.md
```

Then you can run:

```text
/review src/core/queryEngine.ts
```

`review.md` can contain a prompt template and use placeholders such as `$ARGUMENTS`, `$1`, and `$2`.

### `.kk-agent/skills`

Project-level Skills directory. Each Skill usually contains a `SKILL.md`:

```text
.kk-agent/
└── skills/
    └── my-skill/
        └── SKILL.md
```

Use:

```text
/skills
```

to list loaded skills. The model can also load full skill content through the `Skill` tool.

### `.kk-agent/worktrees`

Directory generated by SubAgent worktree isolation:

```text
.kk-agent/
└── worktrees/
```

When a background Agent or child Agent uses `isolation: "worktree"`, it can modify code in an independent git worktree. Clean worktrees are removed automatically. Worktrees with changes are kept for review, merge, or deletion.

### `.kk-agent/mcp.json`

```json
{
  "mcpServers": {
    "everything-search": {
      "command": "cmd",
      "args": ["/c", "uvx", "mcp-server-everything-search"],
      "env": {
        "EVERYTHING_SDK_PATH": "D:/MySoftware/027everything/dll/Everything64.dll"
      }
    }
  }
}
```
