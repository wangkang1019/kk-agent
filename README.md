# KK-Agent

[中文](README.md) | [English](README.EN.md)

一个用于个人学习的本地命令行智能体

## 作者

我是王康，人工智能在读博士。在读于重庆邮电大学人工智能学院，于重庆人工智能学院联合培养。

- GitHub: <https://github.com/wangkang1019>
- 抖音: [点击进入我的抖音](https://www.douyin.com/user/MS4wLjABAAAAxRZTSupsJ4AqmOKjY7JLgcN4gW2jnzbP_CtqEO3v_Xo)
- Email: wangkang19971019@163.com / wangkang19971019@gmail.com

## 项目简介

KK-Agent 是我在学习和复现 Claude Code、Codex 等终端智能体核心能力时，从零逐步构建的本地 命令行工具。它不是简单的“大模型 API 包装器”，而是一个按工程分层逐步搭建的 Agent CLI：

- 能和大模型进行多轮对话
- 能流式输出回复
- 能读取、搜索、编辑项目文件
- 能执行 Shell 命令
- 能通过权限系统控制高风险动作
- 能管理上下文、会话、记忆、任务、Hooks、Skills、MCP、SubAgent 等能力

大多数人会先从“Agent 是什么”或“如何使用 Claude Code / Codex”开始理解智能体。但我认为，只有自己一步一步构建一个 Agent，才能真正理解它背后的工具调用、权限边界、上下文工程、会话编排和系统韧性。

这个项目就是这个学习过程的工程化沉淀。

## 技术栈

- Language: TypeScript
- Runtime: Node.js
- Module System: ESM
- CLI UI: React + Ink
- LLM SDK: `@anthropic-ai/sdk`
- MCP: `@modelcontextprotocol/sdk`
- Dev Runner: `tsx`
- Build: `tsc`
- Package Manager: npm

建议使用 Node.js 20+。

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/wangkang1019/kk-agent.git
cd KK-Agent
```

### 2. 配置模型服务

项目里提供了 `.env.example`，先复制一份为 `.env`：

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

Windows CMD：

```cmd
copy .env.example .env
```

macOS / Linux：

```bash
cp .env.example .env
```

然后打开 `.env`，填写你的 DeepSeek API Key：

```env
ANTHROPIC_AUTH_TOKEN=
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_MODEL=deepseek-v4-pro
```

说明：

- `ANTHROPIC_AUTH_TOKEN`：填写你的 DeepSeek API Key
- `ANTHROPIC_BASE_URL`：DeepSeek 的 Anthropic 兼容 API 地址
- `ANTHROPIC_MODEL`：默认使用 `deepseek-v4-pro`

也可以在 `~/.kk-agent/settings.json` 或项目 `.kk-agent/settings.json` 中配置模型等设置。

### 3. 快速开发者模式启动

适合第一次体验、开发调试、修改源码后快速启动：

```bash
npm install
npm run dev
```

`npm install` 用来安装依赖，第一次克隆项目后必须先执行一次。  
`npm run dev` 会直接运行 `src/entrypoint/cli.ts`，不需要提前构建。

### 4. 持久化启动

如果你希望以后在任意命令行目录直接输入 `kk` 启动，可以注册成本机全局命令：

```bash
npm install
npm run build
npm link
```

完成后，在命令行输入：

```bash
kk
```

就可以启动 KK-Agent。

```text
想快速体验或开发：npm install -> npm run dev
想以后直接输入 kk：npm install -> npm run build -> npm link，然后输入 kk
```

## 常用命令

启动后，在 KK-Agent 对话框里可以输入以下 slash commands：

```text
/help                         查看命令帮助
/clear                        清空当前会话上下文
/history                      查看历史会话
/resume [latest|session-id]   恢复历史会话
/compact [focus]              压缩上下文
/rewind [preview] [n]         预览或回滚到前 n 轮对话前的文件状态
/cost                         查看 token 使用情况
/mode [default|plan|auto]     查看或切换权限模式
/model [name|default]         查看或切换模型
/tasks [task|todo|reset]      切换或重置任务系统
/mcp                          查看 MCP 服务状态
/skills                       查看已加载 Skills
/commands                     查看用户自定义命令
/agents                       查看 SubAgent 和后台任务
/teams                        查看 Agent Teams 状态
/sandbox                      查看 Bash 沙箱状态
/hooks                        查看 Hooks 状态
/config                       查看或修改配置
/output-style [name]          查看或切换输出风格
/exit 或 /quit                退出
```

常用快捷键：

```text
Ctrl+C      中断当前请求，空闲时退出
Ctrl+D      退出
Shift+Tab   循环切换权限模式
Ctrl+O      打开 transcript 对话回看
```

## 功能模块

下面按照项目迭代记录总结当前已经实现的主要能力。

### 1. 基础 CLI 与流式通信

- TypeScript / Node.js / ESM 工程骨架
- CLI 入口 `src/entrypoint/cli.ts`
- Anthropic Messages API 通信层
- 流式输出
- usage token 记录

### 2. React / Ink 终端 UI

- 终端对话界面
- 可编辑输入框
- slash command 建议
- 命令选择面板
- 权限确认卡片
- Transcript overlay
- 启动 Header UI

### 3. Agentic Loop

- 模型输出 `tool_use`
- 本地执行工具
- 把 `tool_result` 回填给模型
- 多轮循环直到模型停止调用工具
- 最大轮数保护
- 中断控制

### 4. 工具系统

内置核心工具包括：

- `Read`：读取文件
- `Write`：创建或覆盖文件
- `Edit`：精确替换文件内容
- `Grep`：搜索文件内容
- `Glob`：查找文件
- `Bash`：执行 Shell 命令

工具统一走注册表和权限系统，方便后续扩展。

### 5. 权限系统

支持 Allow / Ask / Deny 三级权限模型：

- `default`：安全操作自动放行，写入和风险操作需要确认
- `plan`：只读规划模式
- `auto`：自动执行模式

权限确认支持键盘选择，也支持 session 级 always allow。

### 6. System Prompt 与上下文工程

- 动态组装 system prompt
- 注入当前目录、日期、OS、Git 状态
- 支持项目规则与记忆
- 支持 `--dump-system-prompt` 调试最终 prompt
- 融合了适合本地 Agent CLI 的行为规范、工具纪律、安全边界和上下文规则

### 7. 会话持久化

- JSONL transcript 存储
- `/history` 查看历史
- `/resume` 恢复历史会话
- 支持会话恢复后的继续对话

### 8. 项目记忆系统

- 项目级 memory 目录
- `MEMORY.md` 入口索引
- 文件级长期记忆
- 适合沉淀用户偏好、项目事实、测试约定等跨对话信息

### 9. 上下文压缩与 Token 预算

- MicroCompact 清理旧工具结果
- 全量摘要压缩
- `/compact [focus]` 手动压缩
- 自动压缩
- 上下文窗口百分比提示
- token warning / blocking 策略

### 10. Plan Mode

- 进入计划模式
- 生成计划
- `ExitPlanMode` 审批
- 支持清空上下文执行计划、保留上下文执行计划、手动确认编辑、继续规划

### 11. Todo 与 Task 系统

- `TodoWrite`：会话内轻量任务清单
- Task V2：持久化任务图
- 支持任务依赖、阻塞关系、状态更新
- `/tasks task|todo|reset` 切换任务系统

### 12. MCP 集成

- 支持 stdio / http / sse MCP server
- 自动把 MCP tools 包装成本地工具
- `/mcp` 查看服务状态
- `/mcp tools <name>` 查看工具
- `/mcp reconnect <name>` 重连

### 13. Skills 系统

- 从 `SKILL.md` 加载可复用工作流
- 用户级目录：`~/.kk-agent/skills`
- 项目级目录：`.kk-agent/skills`
- 模型可通过 `Skill` 工具加载完整 skill
- 用户可通过 `/skill-name args` 显式调用

### 14. Sandbox 沙箱机制

- Bash 沙箱策略层
- macOS 可接 `sandbox-exec`
- Windows 当前实现安全降级：不伪装成硬沙箱
- 支持 `/sandbox` 查看状态
- 支持配置是否允许非沙箱命令回退

### 15. SubAgent

- `Agent` 工具可把任务委派给子 Agent
- 子 Agent 拥有独立上下文
- 支持自定义 Agent 定义
- 支持后台 Agent
- 支持 git worktree 隔离
- 支持后台任务完成通知

### 16. Agent Teams

- 可创建 Agent Team
- 命名 teammate
- teammate 通过 mailbox 传递消息
- 支持后台多智能体协作
- 默认关闭，可通过配置或启动参数开启

### 17. Hooks 生命周期系统

支持生命周期事件：

- `PreToolUse`
- `PostToolUse`
- `UserPromptSubmit`
- `SessionStart`
- `Stop`
- `SubagentStop`

Hook 可以拦截工具、注入上下文、修改权限行为。

### 18. Output Styles 与 User Commands

- 自定义回答风格
- `/output-style` 切换输出风格
- 用户自定义 slash command
- 命令模板支持参数替换

### 19. 配置系统

- 用户配置：`~/.kk-agent/settings.json`
- 用户状态：`~/.kk-agent/state.json`
- 项目配置：`.kk-agent/settings.json`
- 本地配置：`.kk-agent/settings.local.json`
- MCP 专用配置：`.kk-agent/mcp.json`
- 支持多源合并、项目信任、风险配置过滤
- `/config` 查看或修改配置

### 20. 对话级文件回滚

- 每轮用户对话开始创建文件快照
- `Write` / `Edit` 执行前备份文件
- `/rewind preview [n]` 预览回滚影响
- `/rewind [n]` 回滚到前 n 轮开始前
- 使用 `diff` 做行级变更统计

### 21. 错误处理与韧性

- API 错误分类
- 自动重试
- 529 / 429 / 网络错误处理
- prompt too long 后 reactive compact
- max output token 后续写恢复
- 用户友好的错误提示

## 项目结构

```text
src/
├── entrypoint/      # CLI 启动入口
├── ui/              # React/Ink 终端界面
├── core/            # QueryEngine 与 Agentic Loop
├── tools/           # 本地工具与工具注册系统
├── services/        # API、MCP、Skills、Extensions
├── permissions/     # 权限系统
├── context/         # system prompt、上下文压缩、token 预算
├── session/         # 会话持久化、transcript、file history
├── memory/          # 项目记忆系统
├── state/           # Todo、Task、后台 Agent 等运行状态
├── agents/          # SubAgent 定义与运行
├── teams/           # Agent Teams
├── hooks/           # 生命周期 Hooks
├── sandbox/         # Bash 沙箱策略
├── config/          # 统一配置系统
├── types/           # 共享类型
└── utils/           # 工具函数
```

## 常见配置示例

### `AGENT.md`

项目根目录下的 `AGENT.md` 可以用来约束 KK-Agent 运行时的项目提示词。它适合写项目约定、回答偏好、开发规范、测试要求等内容。

示例：

```md
回答时先给结论。
修改代码前先阅读 README.md 和相关源码。
新增功能后尽量运行 npm run build 验证。
```

启动后，KK-Agent 会把 `AGENT.md` 作为项目上下文的一部分注入给模型，让模型在当前项目里按这些规则工作。

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

用户自定义 slash command 目录。每个 Markdown 文件会变成一个命令。

示例：

```text
.kk-agent/
└── commands/
    └── review.md
```

启动后可以输入：

```text
/review src/core/queryEngine.ts
```

`review.md` 中可以写 prompt 模板，并使用 `$ARGUMENTS`、`$1`、`$2` 等参数占位。

### `.kk-agent/skills`

项目级 Skills 目录。每个 Skill 通常包含一个 `SKILL.md`：

```text
.kk-agent/
└── skills/
    └── my-skill/
        └── SKILL.md
```

启动后可以用：

```text
/skills
```

查看已加载的 skills。模型也可以通过 `Skill` 工具按需加载完整 skill 内容。

### `.kk-agent/worktrees`

SubAgent 使用 worktree 隔离时生成的目录：

```text
.kk-agent/
└── worktrees/
```

当后台 Agent 或子 Agent 使用 `isolation: "worktree"` 时，它会在独立 git worktree 里尝试修改代码。干净的 worktree 会自动清理；如果有改动，会保留下来，方便你检查、合并或删除。

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
