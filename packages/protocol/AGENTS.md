# packages/protocol

本文件叠加仓库根目录 `AGENTS.md`。这里只写 protocol package 的局部导航与开发约束；架构、契约、决策事实仍以 `docs/dev/` 下 owner 文档为准。

## 本包职责

- 实现 `@agent-nexus/protocol`，承载跨 package 共享的类型与接口契约。
- 入口在 `src/index.ts`；agent 事件、session key 等类型看同目录模块与测试。
- protocol 是 leaf package，不应引入运行时业务依赖。

## 先看哪里

- Agent runtime 契约：[`../../docs/dev/spec/agent-runtime.md`](../../docs/dev/spec/agent-runtime.md)
- Platform adapter 契约：[`../../docs/dev/spec/platform-adapter.md`](../../docs/dev/spec/platform-adapter.md)
- 归一化消息协议：[`../../docs/dev/spec/message-protocol.md`](../../docs/dev/spec/message-protocol.md)
- 配置与路由契约：[`../../docs/dev/spec/config-routing.md`](../../docs/dev/spec/config-routing.md)
- import 方向：[`../../docs/dev/architecture/dependencies.md`](../../docs/dev/architecture/dependencies.md)

## 本地命令

- `corepack pnpm --filter @agent-nexus/protocol typecheck`
- `corepack pnpm --filter @agent-nexus/protocol build`
- `corepack pnpm test -- packages/protocol`

## 修改约束

- 改任何 exported 类型、事件 union、session key 或公共接口时，先改对应 spec，再改测试和实现。
- 不引入 daemon、agent、platform 或 CLI 依赖；protocol 必须保持 leaf。
- 不把具体 backend / platform 实现细节写进通用类型，除非对应 spec 已明确收敛为跨实现契约。
