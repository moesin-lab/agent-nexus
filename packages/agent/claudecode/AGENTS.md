# packages/agent/claudecode

本文件叠加仓库根目录 `AGENTS.md`。这里只写 Claude Code backend package 的局部导航与开发约束；架构、契约、决策事实仍以 `docs/dev/` 下 owner 文档为准。

## 本包职责

- 实现 `@agent-nexus/agent-claudecode`，把 Claude Code CLI 适配为 `AgentRuntime`。
- 入口在 `src/index.ts`；配置解析、自检、usage 归一化分别看同目录相关模块与测试。
- 本包只服务 Claude Code backend，不承载 daemon、platform 或 CLI 拼装逻辑。

## 先看哪里

- Agent runtime 契约：[`../../../docs/dev/spec/agent-runtime.md`](../../../docs/dev/spec/agent-runtime.md)
- Claude Code CLI 契约：[`../../../docs/dev/spec/agent-backends/claude-code-cli.md`](../../../docs/dev/spec/agent-backends/claude-code-cli.md)
- 配置与路由契约：[`../../../docs/dev/spec/config-routing.md`](../../../docs/dev/spec/config-routing.md)
- import 方向：[`../../../docs/dev/architecture/dependencies.md`](../../../docs/dev/architecture/dependencies.md)

## 本地命令

- `corepack pnpm --filter @agent-nexus/agent-claudecode test`
- `corepack pnpm --filter @agent-nexus/agent-claudecode typecheck`
- `corepack pnpm --filter @agent-nexus/agent-claudecode build`

## 修改约束

- 改 `AgentRuntime`、事件字段、配置字段或 Claude Code CLI 调用语义时，先改对应 spec，再改测试和实现。
- 不在本文件复述字段表、默认值、错误码；需要说明时 link 到 owner 文档。
- 不 import 其他 agent 或 platform package；共享抽象只能来自 `@agent-nexus/daemon` 和 `@agent-nexus/protocol`。
