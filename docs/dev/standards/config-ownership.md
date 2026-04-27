---
status: active
---

# Config Ownership Standard

每个可插拔的 platform / agent 包**必须自包含其 config 解析逻辑**——包括字段定义、类型、默认值（运行时无关部分）、校验。CLI 退化为路由层，只负责文件读取、路径计算和错误包装。

> 精神来源：ADR-0008 §"代码与设计维度"；同一 SSOT 原则在代码层的落地。  
> 首次显式陈述于 Issue #49。

## 规则

### 1. owner 包导出 config parser

每个可插拔包（`packages/platform/<name>/`、`packages/agent/<name>/`）必须在 `src/config.ts` 中定义并导出：

```ts
// 必选导出
export interface XxxConfig { ... }
export class XxxConfigError extends Error { ... }
export function parseXxxConfig(raw: unknown, ctx: { ... }): XxxConfig { ... }
```

并在 `src/index.ts` 中重新导出：

```ts
export { parseXxxConfig, type XxxConfig, XxxConfigError } from './config.js';
```

### 2. CLI 只做路由

`packages/cli/src/config.ts` 的职责：

- 读取 `~/.agent-nexus/config.json`（文件 I/O、JSON 解析、顶层结构校验）
- 计算环境相关路径（如 `defaultStatePath`）并作为参数传入 owner parser
- 调用各 owner 包的 parser，统一 catch owner 错误后包成 `ConfigError`（保持 CLI 是 `ConfigError` 的唯一 owner）
- 不直接持有任何 owner 包的字段名

**合规**检测：`packages/cli/src/config.ts` 全文不应出现 owner 包的具体字段名（如 `botUserId`、`workingDir`、`allowedTools` 等）。

### 3. 默认值归属

- **运行时无关默认值**（如 `DEFAULT_BIN = 'claude'`、`DEFAULT_ALLOWED_TOOLS`）：属于 owner 包，定义并导出在 `src/config.ts`
- **环境相关路径默认值**（如 `~/.agent-nexus/state/discord.json`）：属于 CLI，由 CLI 计算后作为 `ctx` 参数传入 owner parser

### 4. 错误归属

owner 包只 throw 自己的错误子类（如 `DiscordConfigError`）；CLI 统一 catch 并包成 `ConfigError`。禁止 owner 包 import CLI 的 `ConfigError`（会形成反向依赖）。

### 5. 测试归属

字段级校验测试（字段缺失、类型错误、默认值）放在 owner 包的 `src/config.test.ts`；CLI 的 `config.test.ts` 只测文件级场景（缺文件、非法 JSON）和集成路由（验证错误经过包装后含正确字段名）。

## 接入新 platform / agent 的清单

1. 新建 `packages/platform/<name>/src/config.ts`，导出 `XxxConfig`、`XxxConfigError`、`parseXxxConfig`
2. 在 `packages/platform/<name>/src/index.ts` 重新导出
3. 在 `packages/cli/src/config.ts` 的 `AgentNexusConfig` 中加入新字段，`loadConfig()` 调用 `parseXxxConfig`，catch `XxxConfigError` 包成 `ConfigError`
4. 新建 `packages/platform/<name>/src/config.test.ts` 覆盖字段校验
5. 更新 `packages/cli/src/config.test.ts` 仅加集成 smoke test（非字段级）

## 反模式（禁止）

- CLI 直接校验 owner 包字段（字段名硬编码在 CLI）
- owner 包 import CLI 的 `ConfigError`
- 字段校验测试只有 `cli/config.test.ts`，owner 包无测试
- owner 包依赖 `~/.agent-nexus/` 目录布局（这是 CLI 层知识）
