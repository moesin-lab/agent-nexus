---
title: Discord E2E 测试方案
type: testing
status: active
summary: Discord 端到端测试的 fake platform 边界、runner、transcript、seed case 与真实 Discord smoke 分层
tags: [testing, discord, strategy, fixtures, pipeline]
related:
  - dev/testing/strategy
  - dev/testing/fixtures
  - dev/spec/message-flow
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
  - dev/spec/security/auth
  - dev/spec/infra/idempotency
  - dev/spec/security/redaction
---

# Discord E2E 测试方案

本文件定义 Discord 端到端测试用什么证据证明行为正确。接口字段、消息流顺序、权限、幂等、脱敏的契约分别由相关 spec 拥有；本文只规定测试 harness、runner、fixture、transcript 与 seed case 的证据模型。

## 目标行为

Discord E2E 要证明一条用户输入能穿过完整运行链路，并在 Discord 侧产生可断言的出站结果：

```text
Fake Discord input
  -> PlatformAdapter handler
  -> daemon routing / auth / idempotency / session / output handling
  -> real AgentRuntime
  -> Fake Discord outbound capture
```

默认 E2E 不连接真实 Discord gateway，不读取真实 Discord token，不依赖真实 guild 或频道状态。真实 Discord 只作为单独的 smoke 证据。

## 分层

| 层 | 目的 | Discord 边界 | Agent 边界 | 是否作为最终 E2E 证据 |
|---|---|---|---|---|
| Harness qualification | 验证 fake Discord、同步等待、transcript、断言工具自身可靠 | fake `PlatformAdapter` | scripted agent 或 transcript replay | 否 |
| Discord E2E | 验证完整 daemon + agent + platform boundary 链路 | fake `PlatformAdapter` | 真实 `AgentRuntime` 子进程 | 是 |
| Real Discord smoke | 验证真实 token、gateway、slash command、REST 基线 | 真实 Discord adapter | 可用最小 agent | 否，诊断用 |

Harness qualification 只能证明测试工具自身可用，不能替代 Discord E2E。Discord E2E 的 agent 边界必须使用真实 runtime；若本机缺少认证或 CLI，case 只能标记为环境前提缺失，不能记为通过。

## Fake Discord 边界

Fake Discord 实现 `PlatformAdapter`，不 mock `discord.js Client`，也不走真实网络。它的职责是模拟平台边界，而不是复刻 Discord SDK。接口契约以 [`../spec/platform-adapter.md`](../spec/platform-adapter.md) 为准；下表只列 fake 实现必须覆盖的测试子集。

Fake adapter 必备能力：

| 能力 | 证据 |
|---|---|
| `start(handler)` | 保存 daemon 提供的 handler；未 start 前拒绝注入 |
| `inject(event)` | 将测试构造的 `NormalizedEvent` 投递给 handler |
| `send(sessionKey, message)` | 记录出站文本、traceId、sessionKey，返回确定性的 `MessageRef` |
| `edit(messageRef, message)` | 记录 edit，保持 `MessageRef.messageIds` 语义 |
| `setTyping` / `clearTyping` | 记录 typing 生命周期 |
| capability | 每个 case 可配置 `supportsEdit`、`supportsTypingIndicator`、`maxTextLength` 等 |

Fake adapter 不负责：

- 解析真实 gateway payload。
- 验证 `discord.js` 登录、重连、REST rate limit。
- 注册 slash command。
- 证明真实 Discord REST request 的字段。

这些由 `@agent-nexus/platform-discord` 的合约测试和可选 smoke 证明。

## 输入事件

E2E case 注入的是 `NormalizedEvent`，不是 raw gateway JSON。Discord raw payload 到 `NormalizedEvent` 的映射由 platform adapter 合约测试负责。字段契约以 [`../spec/message-protocol.md`](../spec/message-protocol.md) 为准。

事件工厂使用固定测试 ID：

| 字段 | 示例 |
|---|---|
| `platform` | `discord` |
| `channelId` | `C-e2e-main` |
| `initiatorUserId` | `U-e2e-owner` |
| `guildId` | `G-e2e` |
| `messageId` / `eventId` | 每 case 稳定生成 |
| `traceId` | 每次运行可唯一，但必须写入 transcript |

测试事件不得包含真实 username、真实频道名、真实 token、真实附件 URL。raw payload 只允许放最小空对象或脱敏后的 fixture 引用。

`platformName` 不由测试事件预填。E2E 应断言 daemon routing 后的完整 `SessionKey` 含配置实例名，例如 `discord-main`，从而覆盖 routing 注入路径。

## Runner

目标 runner 命令：

```bash
corepack pnpm test:e2e:discord -- --case happy-path
corepack pnpm test:e2e:discord -- --tag seed
corepack pnpm test:e2e:discord -- --tag harness
corepack pnpm test:e2e:discord -- --all
```

runner 行为：

- 单命令、无交互。
- 默认创建 tmpdir workingDir、tmpdir state、tmpdir transcript 输出目录。
- 默认不读取 `~/.agent-nexus/config.json` 或 Discord secret。
- 默认使用 fake Discord platform。
- 当前 harness qualification 使用 scripted agent；真实 agent backend 选择属于后续 Discord E2E real-agent runner。
- real-agent runner 环境前提缺失时，输出结构化 skip，不把 skip 算作 pass；当前 scripted harness qualification 不需要外部前提。
- harness 等待失败时错误信息包含 `caseId`、`traceIds`、最后事件类型和 transcript JSON 路径，并保留 artifact 目录。
- 通过时默认清理临时目录；设置 keep artifacts 时写出 `passed` transcript 并保留目录。

环境变量状态：

| 变量 | 用途 | 状态 |
|---|---|---|
| `AGENT_NEXUS_E2E_KEEP_ARTIFACTS` | `1` 时保留 harness transcript | 已实现 |
| `AGENT_NEXUS_E2E_AGENT` | `codex` 或 `claudecode` | real-agent runner 待实现 |
| `AGENT_NEXUS_E2E_CASE_TIMEOUT_MS` | 单 case 超时 | real-agent runner 待实现 |
| `AGENT_NEXUS_E2E_WORKDIR` | 指定工作目录；默认 tmpdir | real-agent runner 待实现 |
| `AGENT_NEXUS_E2E_ALLOW_SKIP` | 环境前提缺失时允许退出 0 | real-agent runner 待实现 |

runner 不负责启动真实 Discord。真实 Discord smoke 使用独立命令，避免误触真实频道。

## Transcript

每个 case 产生一份 JSON transcript。transcript 是失败复盘证据，不是测试 fixture；默认不提交到仓库。

最小结构：

```json
{
  "caseId": "happy-path",
  "runId": "1781629200000-...",
  "startedAt": "2026-06-16T15:00:00.000Z",
  "finishedAt": "2026-06-16T15:00:05.000Z",
  "status": "passed",
  "environment": {
    "agentBackend": "codex",
    "node": "v22.x",
    "platform": "fake-discord"
  },
  "events": [],
  "assertions": [],
  "artifactPath": "/tmp/agent-nexus-discord-e2e-.../transcripts/happy-path-....json"
}
```

事件项按发生顺序追加：

| `kind` | 内容 |
|---|---|
| `inbound` | 注入的 `eventId`、`messageId`、`traceId`、session key、text 摘要 |
| `agent_event` | `AgentEvent.type`、sequence、traceId、payload 摘要 |
| `outbound_send` | session key、message ids、text 摘要或脱敏文本 |
| `outbound_edit` | message ref、text 摘要或脱敏文本 |
| `typing` | set / clear 与 session key |
| `log` | 与断言相关的结构化日志事件 |
| `assertion` | 断言名、结果、失败细节 |

transcript 禁止写入：

- Discord token 或 secret ref 内容。
- raw Discord payload 全量。
- agent 子进程 stdout 全量。
- 未脱敏的绝对路径、API key、邮箱、手机号。

当 redactor 不可用时，runner 必须退化为摘要和 hash，不得把原文写进 transcript。

## 同步模型

E2E 禁止用固定 sleep 等待业务结果。harness 提供显式等待：

| helper | 等待条件 |
|---|---|
| `waitForOutbound(predicate, timeoutMs)` | 某条 send/edit 满足断言 |
| `waitForAgentEvent(predicate, timeoutMs)` | recorder 看到某个 AgentEvent |
| `waitForTurnFinished(traceId, timeoutMs)` | 同 traceId 的 turn terminal 到达 |
| `waitForNoAgentCall(windowMs)` | 授权拒绝等负路径短窗口内未触发 agent |

等待失败时，runner 写出当前 transcript，并在 thrown error 中报告 case id、trace id 列表、最后一条事件类型和 artifact 绝对路径。

## Seed Case

第一批 seed case 是最终验收的最小集合。每个 case 必须独立 tmpdir、独立 fake platform、独立 transcript。

| Case | 目的 | 关键断言 |
|---|---|---|
| `happy-path` | 合法 Discord 消息触发真实 agent 并回送 Discord | route 命中；auth 通过；agent 收到输入；至少一条 outbound；traceId 串联 |
| `auth-denied` | 非 allowlist 用户不触发 agent | `auth_denied`；无 agent session；无 agent outbound；无幂等记录 |
| `idempotency-replay` | Discord at-least-once 重放只处理一次 | 同 `(sessionKey, messageId)` 第二次不触发 agent；记录命中日志 |
| `long-output-slicing` | 长回复切片归属清晰后，证明默认 E2E 不产生 fake-only 通过 | 不由 fake adapter 复刻 Discord `buildSlices`；最终断言随 platform-adapter owner 对切片归属的修正确定 |
| `redaction` | agent 输出敏感模式时发到 Discord 前已脱敏 | outbound 不含原始 secret / 绝对路径；transcript 也不含原文 |

当前实现状态与缺口：

- `idempotency-replay` 需要按 spec 的 `(sessionKey, messageId)` 语义实现；当前已有可注入的内存 `IdempotencyStore`，但尚未覆盖 SQLite 持久化、TTL、GC 与 failed 重试窗口。
- `redaction` 当前覆盖 daemon 到 IM outbound 的基础文本脱敏；日志 sink、agent 子进程 transcript 等全出口脱敏仍需后续按 redaction spec 补齐。
- `long-output-slicing` 当前 seed 通过 fake platform 的 `maxTextLength` 能力模拟证明 harness 能捕获多条 outbound；真实 Discord 仍由 adapter 的 `buildSlices` 维护切片与 `MessageRef.messageIds`，段落 / 代码块边界、续页标记的最终归属仍需后续收敛。
- 若 session/idempotency 存储仍是内存实现，E2E 可以用 tmpdir state，但不能声称已覆盖 SQLite 持久化。

## 真实 Agent 选择

第一实现优先 Codex backend：

- `codex exec --json` 已有 runtime 和 verify 脚本。
- 默认 `read-only` sandbox、`--ask-for-approval never`、忽略 user config/rules。
- case 可用 sentinel prompt 降低自然语言不确定性。

Claude Code backend 保留为同一 runner 的可选 backend：

- 覆盖 stream-json 长驻进程路径。
- 成本和输出 runtime 信息更多，默认 transcript 必须只保留摘要。

case 断言不能依赖完整 LLM 文本逐字一致。需要确定输出时，prompt 使用短 sentinel；仍需把模型偏差归类为 `model_behavior`，不同于 contract failure。

## Fixture 与 Artifact

版本控制内 fixture：

- Discord raw gateway fixture 继续放 `testdata/discord/events/`，供 adapter 合约测试使用。
- agent transcript fixture 继续放 owner backend 的 testdata；现有 Claude Code transcript 归 [`fixtures.md`](fixtures.md) 定义的 `testdata/cc-cli/transcripts/`，新增 Codex transcript 不在本文重新命名。
- E2E seed case 配置可以放 `tests/e2e/discord/cases/`，只写脱敏输入和断言，不写运行产物。

运行产物：

- 默认写入 tmpdir。
- harness 等待失败时输出 artifact 绝对路径，并保留对应 tmpdir。
- `AGENT_NEXUS_E2E_KEEP_ARTIFACTS=1` 或 harness `keepArtifacts: true` 时，通过 case 也写出 `passed` transcript 并保留 tmpdir。
- 需要人工复盘的 transcript 可复制到 goal workspace 或 PR 附件，不直接提交。

## 真实 Discord Smoke

真实 Discord smoke 只验证部署面：

- token 可登录。
- bot user id 自检通过或正确 warn。
- test guild slash command 可注册。
- 指定测试频道能收到一条最小回复。

smoke 必须显式 opt-in：

```bash
corepack pnpm smoke:discord -- --guild <testGuildId> --channel <channelId>
```

缺少 token、guild、channel 时直接跳过或失败为环境前提，不回退到默认配置。smoke 不进入 PR 必跑路径，不作为 seed case 通过证据。

## CI 证据

CI 分三类：

| 命令 | 触发 | 失败含义 |
|---|---|---|
| harness qualification | PR 必跑 | 测试工具或 daemon contract 破坏 |
| Discord E2E real-agent | 核心路径 PR / main / 手动 | 完整链路破坏或环境前提缺失 |
| real Discord smoke | 手动 / 夜间私有环境 | 部署凭据或 Discord 侧行为异常 |

CI 触发与门禁编排仍以 [`../process/tdd.md`](../process/tdd.md) 为准；本文只定义每类证据证明什么。

## 不测什么

默认 Discord E2E 不证明：

- 真实 gateway reconnect 是否成功 resume。
- Discord global slash command 传播延迟。
- 真实 REST rate limit 行为。
- 第三方 SDK 内部行为。
- LLM 对开放式问题的质量。

这些分别由 platform 合约测试、真实 Discord smoke、eval 或后续专项测试覆盖。
