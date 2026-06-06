# packages/cli

本文件叠加仓库根目录 `AGENTS.md`。这里只写 CLI package 的局部导航与开发约束；架构、契约、决策事实仍以 `docs/dev/` 下 owner 文档为准。

## 本包职责

- 实现 `@agent-nexus/cli` 与 `agent-nexus` 可执行入口。
- 入口在 `src/index.ts`；agent 选择与配置解析看 `src/agent.ts`、`src/config.ts` 及对应测试。
- CLI 是拼装层：读取配置、创建 daemon、注册启用的 platform / agent，并处理进程入口行为。

## 先看哪里

- 配置与路由契约：[`../../docs/dev/spec/config-routing.md`](../../docs/dev/spec/config-routing.md)
- 消息流：[`../../docs/dev/spec/message-flow.md`](../../docs/dev/spec/message-flow.md)
- import 方向与 CLI 职责：[`../../docs/dev/architecture/dependencies.md`](../../docs/dev/architecture/dependencies.md)
- Agent runtime 契约：[`../../docs/dev/spec/agent-runtime.md`](../../docs/dev/spec/agent-runtime.md)
- Platform adapter 契约：[`../../docs/dev/spec/platform-adapter.md`](../../docs/dev/spec/platform-adapter.md)

## 本地命令

- `corepack pnpm --filter @agent-nexus/cli test`
- `corepack pnpm --filter @agent-nexus/cli typecheck`
- `corepack pnpm --filter @agent-nexus/cli build`
- `corepack pnpm --filter @agent-nexus/cli dev`

## 修改约束

- 改配置 schema、backend/platform 选择、路由匹配或 CLI 对外行为时，先改对应 spec，再改测试和实现。
- CLI 可以 import daemon、platform、agent、protocol；其他 package 不应 import CLI。
- 不把业务逻辑下沉到 CLI；能归属 daemon、agent 或 platform 的行为放回 owner package。
