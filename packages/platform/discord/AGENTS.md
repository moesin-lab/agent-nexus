# packages/platform/discord

本文件叠加仓库根目录 `AGENTS.md`。这里只写 Discord platform package 的局部导航与开发约束；架构、契约、决策事实仍以 `docs/dev/` 下 owner 文档为准。

## 本包职责

- 实现 `@agent-nexus/platform-discord`，把 Discord 事件和发送能力适配到 `PlatformAdapter`。
- 入口在 `src/index.ts`；命令、回复模式、状态和配置看同目录模块与测试。
- 本包只服务 Discord platform，不承载 daemon、agent 或 CLI 拼装逻辑。

## 先看哪里

- Platform adapter 契约：[`../../../docs/dev/spec/platform-adapter.md`](../../../docs/dev/spec/platform-adapter.md)
- 归一化消息协议：[`../../../docs/dev/spec/message-protocol.md`](../../../docs/dev/spec/message-protocol.md)
- 配置与路由契约：[`../../../docs/dev/spec/config-routing.md`](../../../docs/dev/spec/config-routing.md)
- 身份与 allowlist：[`../../../docs/dev/spec/security/auth.md`](../../../docs/dev/spec/security/auth.md)
- import 方向：[`../../../docs/dev/architecture/dependencies.md`](../../../docs/dev/architecture/dependencies.md)

## 本地命令

- `corepack pnpm --filter @agent-nexus/platform-discord typecheck`
- `corepack pnpm --filter @agent-nexus/platform-discord build`
- `corepack pnpm test -- packages/platform/discord`

## 修改约束

- 改 Discord 事件映射、发送能力、配置字段或用户可见交互语义时，先改对应 spec，再改测试和实现。
- 不在本文件复述 Discord 字段映射表；需要说明时 link 到 owner 文档。
- 不 import 其他 platform 或 agent package；共享抽象只能来自 `@agent-nexus/daemon` 和 `@agent-nexus/protocol`。
