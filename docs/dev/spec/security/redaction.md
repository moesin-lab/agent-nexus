---
title: Spec：Redaction（脱敏层）
type: spec
status: active
summary: 出口脱敏的必过滤项、配置开关、实现要点；与 secrets.md 共同构成防泄露体系
tags: [spec, security, redaction]
related:
  - dev/spec/security/README
  - dev/spec/security/secrets
  - dev/spec/infra/observability
  - dev/spec/infra/trajectory-observability
  - dev/standards/logging
contracts:
  - Redactor
---

# Spec：Redaction（脱敏层）

定义所有出口数据的最后一道**文本过滤**，防止敏感信息通过日志、IM 消息、transcript 泄露。与 [`secrets.md`](secrets.md)（源头控制）、[`auth.md`](auth.md)（访问控制）正交：即使密钥被误放入业务数据，redactor 仍能在最后一跳拦截。

对应模块：`daemon.redact`。

## 必过滤项

| 模式 | 替换为 |
|---|---|
| 绝对路径（`/Users/*/...`、`/home/*/...`、`C:\\Users\\*`） | `~/...`（保留相对部分） |
| 已知密钥前缀（`sk-ant-...`、`MTk...`（Discord token 特征）等） | `<redacted:secret>` |
| 含敏感字样的 env：形如 `*_KEY=...`、`*_TOKEN=...`、`*_SECRET=...` | `*_KEY=<redacted>` |
| 邮箱 | `<redacted:email>`（可配置） |
| 手机号 | `<redacted:phone>`（可配置） |
| 姓名全称 | `<redacted:name>`（可配置） |
| IPv4/IPv6 地址 | `<redacted:ip>`（可配置） |
| 用户消息正文（IM 入站原文） | 摘要或 hash；完整正文走 transcript 落盘，不进 log / outbound |
| Agent 子进程完整输出原文（CC CLI stdout） | 摘要或 hash；完整输出走专门的 transcript 落盘 |
| `tool_result` event 的 content（**所有类型**：text / blocks / object / unknown） | 任一类型进任何出口前都按本表逐项过滤；`ToolResultContent.unknown.raw`（原始 JSON 回显）是其中**高风险点**（承载未识别的原始工具输出），非唯一覆盖项 |
| Provider-call observation 的 request / response headers（如 `authorization`、`cookie`、`x-api-key`、`api-key`） | 敏感 header 值替换为 `<redacted:secret>`；未知 header 仍按通用密钥 pattern 扫描 |
| Provider-call observation 的 request / response body 与 raw stream frame | 先按本表全文扫描脱敏，再执行 size limit；redactor 失败时丢弃 payload，只保留 metadata-only observation |

本表是**全出口必过滤项的权威源**——日志、IM outbound、transcript 等任何出口均按此过滤。日志写法约束见 [`../../standards/logging.md`](../../standards/logging.md)（写法）；observability 的字段契约见 [`../infra/observability.md`](../infra/observability.md)（字段表）。

## 配置

- `config.security.redaction.<key> = true|false` 控制各项开关
- 默认全开
- 新增 pattern 需改本 spec + 发 PR，不允许运行时自定义

## 实现要点

- **在最后一跳过滤**：日志 sink 的 formatter 里、adapter.send 的 OutboundMessage 包装里
- 性能影响可接受（字符串扫描；用预编译正则）
- Redactor 必须是**纯函数**：输入 → 输出，不持 state、不副作用
- Redactor 失败（panic / 异常）→ 降级为丢弃该输出并记错误，而不是把原文泄露出去
- `tool_result` content（所有类型）在 runtime emit → daemon 转发 IM / 落 transcript / 进日志的**任一出口前**必须过 redactor；`unknown.raw` 因承载未识别的原始工具输出，是脱敏高风险点，不得绕过
- **脱敏先于截断**：`unknown.raw` 的 4KB 截断（[`agent-runtime.md`](../agent-runtime.md) 协议约束）必须在脱敏**之后**执行——否则截断点可能切在密钥中间（如 `sk-ant-…` 被切成 `sk-ant-a`），残片不触发前缀正则、绕过脱敏进入出口
- `unknown.raw` 是字符串，redactor 按既有文本过滤方式**直接对序列化后的 JSON 字符串做正则扫描**（不 JSON decode 后逐字段扫）；与本层"纯文本过滤"定位一致
- Provider-call observation 的 header、body、raw stream frame 在写入 `<home>/trajectory/provider-calls/`、日志或导出前都必须过 redactor；失败时 payload 不落盘，按 [`trajectory-observability.md`](../infra/trajectory-observability.md#provider-call-observation) 写 metadata-only / dropped 状态

## 两层视角（future）

Codex review 指出单层 redactor 防不了"CC 在工具调用中使用敏感信息"。本 spec MVP 只做**输出层**脱敏；**输入/工具边界的 policy guard** 作为 future 项，等实现阶段数据积累后再设计（可能独立 `spec/input-policy.md`）。

MVP 的假设：
- 密钥由 [`secrets.md`](secrets.md) 控制源头
- 工具边界由 [`tool-boundary.md`](tool-boundary.md) 控制能做什么
- Redactor 只兜底"万一前两层漏了"

## 合约测试（red-team）

- **密钥前缀**：10+ 种典型敏感 pattern（`sk-ant-...` / Discord token / AWS key 等）注入到 OutboundMessage / log record → 输出里无原文
- **绝对路径**：构造 `/Users/alice/project/file.ts` → 输出含 `~/project/file.ts`
- **env 格式**：`ANTHROPIC_API_KEY=sk-ant-abc` → 替换为 `ANTHROPIC_API_KEY=<redacted>`
- **错误栈注入**：构造含密钥的错误栈 → log formatter 后无原文
- **性能基线**：1 KB 文本过滤 < 1ms（CI benchmark）
- **tool_result unknown 脱敏**：构造含密钥的 `ToolResultContent.unknown.raw`（如工具输出里嵌 `sk-ant-...`）→ 经 redactor 后出口无原文

## 反模式

- 脱敏只在部分出口做（必须全出口）
- Redactor 抛异常传递到业务路径（必须吞异常 + 降级）
- 把 raw payload（Discord 事件原文）再 redact 后落日志（增加错误面；应该直接不打）
- 正则允许运行时编辑（防止绕过）

## Out of spec

- Input-layer policy guard（见"两层视角"的 future）
- 对 LLM prompt 内容的脱敏（属于输入层）
- 用户主动导出 transcript 时的再脱敏（产品层）
