# packages/platform/lark

本文件叠加仓库根目录 `AGENTS.md`。这里只写 Lark platform package 的局部导航与开发约束；架构、契约、决策事实仍以 `docs/dev/` 下 owner 文档为准。

## 本包职责

- 实现 `@agent-nexus/platform-lark`，把中国版飞书事件和发送能力适配到 `PlatformAdapter`。
- 入口在 `src/index.ts`；配置 owner parser 在 `src/config.ts`。
- 本包只服务飞书 platform，不承载 daemon、agent 或 CLI 拼装逻辑。

## 先看哪里

- 决策：[`../../../docs/dev/adr/0019-lark-platform-via-official-node-sdk.md`](../../../docs/dev/adr/0019-lark-platform-via-official-node-sdk.md)
- Platform adapter 契约：[`../../../docs/dev/spec/platform-adapter.md`](../../../docs/dev/spec/platform-adapter.md)
- 归一化消息协议：[`../../../docs/dev/spec/message-protocol.md`](../../../docs/dev/spec/message-protocol.md)
- 配置与路由契约：[`../../../docs/dev/spec/config-routing.md`](../../../docs/dev/spec/config-routing.md)
- 身份与 allowlist：[`../../../docs/dev/spec/security/auth.md`](../../../docs/dev/spec/security/auth.md)
- import 方向：[`../../../docs/dev/architecture/dependencies.md`](../../../docs/dev/architecture/dependencies.md)

## 本地命令

- `corepack pnpm --filter @agent-nexus/platform-lark typecheck`
- `corepack pnpm --filter @agent-nexus/platform-lark build`
- `corepack pnpm test -- packages/platform/lark`

## 修改约束

- 改飞书事件映射、发送能力、配置字段或用户可见交互语义时，先改对应 spec，再改测试和实现。
- SDK 类型只能留在本 package 内部，不能暴露给 daemon 或 protocol。
- 固定使用中国版飞书 `Domain.Feishu`；不得引入可配置 domain、`lark-cli`、SDK Channel 模块或国际版 Lark。
- 不 import 其他 platform 或 agent package；共享抽象只能来自 `@agent-nexus/daemon` 和 `@agent-nexus/protocol`。
