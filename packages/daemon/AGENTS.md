# packages/daemon

本文件叠加仓库根目录 `AGENTS.md`。这里只写 daemon package 的局部导航与开发约束；架构、契约、决策事实仍以 `docs/dev/` 下 owner 文档为准。

## 本包职责

- 实现 `@agent-nexus/daemon`，作为 platform 与 agent 之间的中枢。
- 入口在 `src/index.ts`；engine、auth、config、router、session store 看同目录模块与测试。
- daemon 只依赖 protocol 与准入的基础库，不感知具体 agent / platform 实现。

## 先看哪里

- 消息流：[`../../docs/dev/spec/message-flow.md`](../../docs/dev/spec/message-flow.md)
- 配置与路由契约：[`../../docs/dev/spec/config-routing.md`](../../docs/dev/spec/config-routing.md)
- 会话模型：[`../../docs/dev/architecture/session-model.md`](../../docs/dev/architecture/session-model.md)
- 身份与 allowlist：[`../../docs/dev/spec/security/auth.md`](../../docs/dev/spec/security/auth.md)
- import 方向：[`../../docs/dev/architecture/dependencies.md`](../../docs/dev/architecture/dependencies.md)

## 本地命令

- `corepack pnpm --filter @agent-nexus/daemon test`
- `corepack pnpm --filter @agent-nexus/daemon typecheck`
- `corepack pnpm --filter @agent-nexus/daemon build`

## 修改约束

- 改路由、session、auth、engine 事件流或持久化语义时，先改对应 spec / architecture，再改测试和实现。
- 不 import `@agent-nexus/agent-*` 或 `@agent-nexus/platform-*`。
- 不把具体 backend 或具体 IM 平台的特殊行为写进 daemon；通过 protocol / runtime / adapter 契约表达。
