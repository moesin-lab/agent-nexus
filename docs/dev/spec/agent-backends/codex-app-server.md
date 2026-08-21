---
title: Spec：Codex App Server Backend Contract
type: spec
status: active
summary: Codex app-server 的 session-private stdio 生命周期、JSON-RPC 子集、thread/turn 状态机、事件映射、双向请求与失败边界
tags: [spec, agent-runtime, codex, app-server, json-rpc]
related:
  - dev/adr/0022-codex-app-server-primary-tui-supplemental
  - dev/adr/0014-agent-backend-codex-cli
  - dev/spec/agent-runtime
  - dev/spec/config-routing
  - dev/spec/security/tool-boundary
  - dev/spec/infra/observability
  - dev/architecture/session-model
contracts:
  - CodexAppServerRuntime
  - CodexAppServerTransport
  - CodexAppServerCompatibilityProbe
---

# Spec：Codex App Server Backend Contract

本文定义 `codex-app-server` backend 对 `codex app-server --listen stdio://` 的适配契约。现有 `codex` backend 继续由 [`codex-cli.md`](codex-cli.md) 定义；二者使用独立 backend id、配置 owner、session 与失败语义，不互相静默 fallback。

## 已验证能力与门禁

首个且当前唯一兼容版本是 Codex CLI `0.146.0`。2026-07-31 的 macOS arm64 实机 probe 已验证：

- initialize / initialized；
- `thread/start` 返回 thread id；
- 同一 thread 连续两个 `turn/start`；
- `thread/status/changed` 的 `active → idle`；
- `agentMessage` final item 与 `turn/completed(status="completed")`；
- `turn/interrupt` 后 `turn/completed(status="interrupted")`。

下列内容不能从上述证据外推：

| surface | 0.146 默认 schema | 当前结论 |
|---|---:|---|
| thread / turn / item / status / interrupt | 有 | 首版主路径；仍需 package contract tests |
| token usage | 有，实机流中出现 | 未纳入现有 probe 断言；映射测试通过前不发 `usage` |
| approval / request-user-input / MCP elicitation | 有 | 必须实现双向 fail-closed 响应；首版不自动批准 |
| background terminal / process stdin / resize / terminate | 仅 `--experimental` 或版本相关 | 不属于首版承诺；真实 probe + 独立 spec amendment 后启用 |
| authenticated remote TUI / loopback WebSocket | 0.146.0 CLI surface，stable RPC schema 不变 | 默认禁用；启用时另过 viewer-specific runtime/release gate，并按 ADR-0023 与 terminal-session spec 的 per-incarnation capability-token 门禁 |
| Unix socket / remote-control / daemon | 命令存在 | 本 backend 禁用；不以 remote viewer 名义启用 |

CompatibilityProbe 未通过时，不创建 session，不回落到 screen parser，也不把同一 `AgentSession` 切换到 `codex` exec backend。

## Capability

首版声明：

| 字段 | 值 | 语义 |
|---|---:|---|
| `supportsThinking` | `false` | reasoning item 映射未形成稳定 contract 前不提升 |
| `supportsStreaming` | `false` | 首版只提升完整 final；delta 仅作为已知 notification 校验 ownership 后忽略 |
| `supportsToolCallEvents` | `false` | 首版不把 tool item 提升为 `AgentEvent`；完整强顺序映射另行补 contract 后再启用 |
| `supportsInterrupt` | `true` | 使用 `turn/interrupt(threadId, turnId)` |
| `supportsStdinInterrupt` | `false` | 不通过 PTY stdin 模拟 Ctrl-C；experimental process stdin 不在首版 |

`supportsStreaming` 只能在 delta/final 去重与顺序 contract tests 通过后翻为 `true`；此前实现必须返回 `false` 并只发 `text_final`。不能只因上游 schema 存在就声明 capability。

## 进程与 transport

### 所有权

- 每个 live `AgentSession` 恰好持有一个 session-private app-server child 与一个 app-server thread；不同 SessionKey 不共享 child、conversation-private `CODEX_HOME`、request id 空间、pending ServerRequest 或事件队列。
- 默认 managed invocation 以 argv array 启动：`<bin> app-server --listen stdio://`。只有显式启用 supplemental viewer 时，允许切换为 `<bin> app-server --listen ws://127.0.0.1:<ephemeral> --ws-auth capability-token --ws-token-file <private-runtime-file>`；仍禁止 shell、detached daemon、非 loopback TCP、Unix socket、`app-server daemon`、proxy 和 remote-control。
- child stdin/stdout 是匿名 pipe，stderr 只进入有界脱敏诊断缓冲；Codex/tool child 不得获得飞书、Discord、数据库或 daemon credential env。
- daemon pipe EOF、stop、启动回滚或 crash recovery 必须结束整个 app-server process group。stdio 与 WebSocket transport 的 production spawn 都必须经过同 PGID supervisor：supervisor 是唯一直接持有 daemon 匿名 stdin/control pipe 的进程；stdio supervisor 把 JSONL 转发到 Codex，WebSocket supervisor 不把 control pipe 交给 Codex。daemon hard crash 产生 EOF 时 supervisor 立即 SIGKILL 自身整个 PGID。正常 stop 仍由 host 执行 TERM → KILL → PGID absent 确认。正常 stop/shutdown 只清理进程与 transient pipe，不删除 conversation-private `CODEX_HOME`；否则 thread id 无法跨 child resume。

### transport framing

stdio transport 使用一行一个 UTF-8 JSON object；WebSocket transport 每个 text message 恰好承载一个 UTF-8 JSON object，不带 JSONL 尾换行，拒绝 binary、空 message、一个 message 内多个 object 与跨 message 拼帧。两种 transport 都必须：

- 用 fatal UTF-8 decoder；拒绝空行、非法 JSON、非 object、截断 EOF 和超过 `8 MiB` 的单帧；
- 写 pipe 尊重 backpressure；完整 frame 接受前不认为 request 已 dispatch；
- request id 在 child lifetime 内单调递增且不复用；每个 request 只有一个 terminal response；unknown、duplicate、late response 是 protocol error；
- 每个 outbound request 有 deadline；timeout 后从 pending map 删除。是否可安全重试由 method 语义决定，不能统一重放；
- stderr、error message 与日志不得包含 auth、用户 prompt、完整 frame、tool output 或 screen 内容。

app-server wire 可省略 `jsonrpc:"2.0"`；agent-nexus 统一发送该字段，接收端兼容有/无该字段，但其它 envelope 字段必须按 snapshot schema 校验。

## schema 与版本策略

- package 当前只接受精确版本 `0.146.0`；扩大范围必须先增加对应完整 snapshot、结构 diff 与真实 probe，不能使用无上界范围。
- 仓库在 `packages/agent/codex-app-server/testdata/schema/<version>/` 保存由最低受支持 binary 的 `codex app-server generate-json-schema --out <dir>` 生成的完整 stable JSON schema snapshot、文件 hash manifest、生成命令、上游版本和许可证归属；stable generation 必须省略 `--experimental`，不得使用 0.146.0 不接受的 `--experimental=false`。runtime 可从 snapshot 生成裁剪后的 allowlist validator，但禁止只提交手写 method 名列表或“看起来相似”的宽松类型替代版本门禁。
- CI 对最低/最高受支持版本重新生成 schema，并检查 allowlisted request/response/notification/ServerRequest 的结构 diff。新增 optional notification 不自动扩大 runtime 权限。
- schema diff 只允许通过同一变更中的 compatibility range、snapshot、validator、spec、安全 review 与真实 probe 一并更新；generated output 不一致、缺文件或 manifest hash 不匹配时发布失败。
- runtime initialize 后校验 app-server 返回的 `userAgent` 以前缀 `agent-nexus/0.146.0` 承载精确 server 版本证据，并校验 `codexHome` 与当前受支持 Unix 平台；版本未知、平台不匹配、schema-derived allowlist 不匹配或 required method 缺失时 fail closed。
- 首版 `initialize.params.capabilities.experimentalApi=false`。任何 experimental method/field 必须先更新本 spec、schema snapshot、security review 与实机 probe。
- viewer-specific runtime probe 除上述 base gate 外，还必须在创建 listener 前确认同一个 `0.146.0` binary 同时暴露 `app-server --ws-auth capability-token`、`--ws-token-file`、`codex --remote` 与 `--remote-auth-token-env`。发布认证另要求该精确 binary 通过无/错/旧 token 拒绝、controller+TUI 双 client 广播与 passive-viewer E2E。viewer gate 失败只回退默认 stdio，不启用 `experimentalApi`，不扩大 stable RPC method/schema allowlist。

## 握手与 method allowlist

业务 request 前严格执行：

```text
client -> initialize {
  clientInfo:{name:"agent-nexus", title:"agent-nexus", version},
  capabilities:{experimentalApi:false, requestAttestation:false, optOutNotificationMethods:[...]}
}
server -> initialize result {userAgent,codexHome,platformFamily,platformOs}
client -> initialized notification
```

首版 client 主动调用 allowlist：

| method | 用途 | 重试语义 |
|---|---|---|
| `initialize` | connection handshake | 不重试；失败结束 child |
| `thread/start` | 新 session 创建 durable thread；固定 `ephemeral=false`、canonical cwd、owner sandbox、`approvalPolicy="never"`、空 config override | dispatch 后无 ack 属 ambiguous，不自动重发 |
| `thread/resume` | 先由 private registry 以 thread id 定位原 conversation home，再恢复已持久化 idle conversation；固定与 start 相同的 cwd/sandbox/approval/config | dispatch 后无 ack 属 ambiguous，不自动 start 新 thread |
| `thread/read` | 状态/元数据核验 | 可在同 connection 有界重试 |
| `turn/start` | 提交一个 user turn | dispatch 后无 ack 属 ambiguous，禁止自动重发 |
| `turn/interrupt` | 中断当前 turn | request 可重试一次，但最终以 `turn/completed` 为准 |
| `thread/unsubscribe` | stop 前解除订阅 | best effort；不替代 process cleanup |

首版不主动调用 filesystem、login、account mutation、plugin install、remote-control、daemon、process 或 background-terminal API。即使它们出现在 schema，也不能由模型、飞书命令或通用 passthrough 绕过 allowlist。

## Session 与 turn 状态机

```text
Spawning -> initialize -> thread/start|resume -> Idle
Idle -> turn/start ack -> Busy -> turn/completed(completed) -> Idle
                            |  -> turn/completed(interrupted) -> Idle
                            |  -> turn/completed(failed) -> Idle|Errored
任意状态 -> child/pipe fatal -> Errored -> Stopped
Idle|Busy -> stop -> Stopping -> Stopped
```

- `startSession()` 同步返回带 runtime-private opaque token 的 `AgentSession{state:"Spawning"}`；clone、backend/key mutation 或其它 runtime 的 session 必须拒绝。
- `resumeFromAgentSessionId` 表示 app-server thread id。只允许在没有 live child/turn 的新 local session 上调用 `thread/resume`；id 格式与返回 thread id 必须一致。
- `session_started` 只在 initialize 与 thread start/resume 成功后发一次，`agentSessionId=thread.id`。
- 同一 session 只允许一个 active turn。普通 user input 使用既有 per-session queue；runtime 仍要串行，不能依赖 app-server 拒绝并发 turn。
- `turn/start` response 提供 turn id；后续 item/status/terminal notification 必须同时匹配当前 thread id 与 turn id。首个 stable supplemental viewer 是 observation-only：adapter 不暴露 write 或可写 attach，TUI 不允许发起 turn。controller Idle 时收到 foreign `turn/started`，或 Busy 时收到不同 turn id，均视为 unsupported viewer input / ownership error，先撤销 viewer incarnation并结束 session；不得把 foreign output 绑定到平台 trace，不得为它创建 error/text/item/turn `AgentEvent`，也不得与下一条平台输入并发。cleanup 确认后的 `session_stopped(error)` 仍是 session 生命周期收敛事件。
- 每 turn 有 terminal latch。stop、interrupt、timeout、child exit 和 `turn/completed` 竞争时，`turn_finished` 恰好一次。
- `thread/status/changed` 是查询状态的权威输入；daemon `/status` 读取 runtime 当前状态，不通过新 request 猜测。`active` 映射 Busy，`idle` 映射 Idle；未知状态 fail closed。

## 输入与输出映射

### 输入

- 首版只接受非空 `user_message.text`；允许普通多行文本需要的 HT（`U+0009`）、LF（`U+000A`）和 CR（`U+000D`），拒绝 C0/C1 范围 `U+0000–U+0008`、`U+000B–U+000C`、`U+000E–U+001F`、`U+007F–U+009F`，并在写 pipe 前拒绝超过 `maxInputBytes` 的 UTF-8 文本。
- 输入映射为 `turn/start.input=[{type:"text",text,text_elements:[]}]`；用户内容不进入 argv、shell 或日志。
- 每条输入携带稳定 `clientUserMessageId` 时只用于关联，不把它当上游 idempotency guarantee。frame 已 dispatch 但 response 丢失时进入 ambiguous，禁止自动重发。

### 输出

首版只从匹配当前 thread/turn 的 allowlisted notification 提升：

| app-server | AgentEvent |
|---|---|
| `thread/started` + start response | `session_started`（仅一次） |
| `thread/status/changed(active|idle)` | runtime state；可选低频 `status` |
| `item/agentMessage/delta` | 首版校验 ownership 后忽略，不产生 `AgentEvent` |
| final `item/completed(agentMessage)` | `text_final`，每 turn 恰好一次且非空 |
| tool item lifecycle | 首版不提升；有界脱敏 diagnostic 后忽略，`supportsToolCallEvents=false` |
| `thread/tokenUsage/updated` | `usage`（仅在 mapping contract tests 通过后） |
| `turn/completed(completed)` | `turn_finished(stop)` |
| `turn/completed(interrupted)` | `turn_finished(user_interrupt)` |
| `turn/completed(failed)` | `error` → `turn_finished(error)` |

`thread/resume` 可能在 response 前重放同一 thread 上一轮的 `thread/tokenUsage/updated`。该 frame 只允许在有界 initialization notification buffer 回放阶段出现：必须匹配 resumed thread，且 `turnId` 必须属于同一 response 的 `thread.turns[].id`，随后忽略，不产生 `AgentEvent`；进入 live 阶段后仍必须匹配当前 active turn。未知历史 turn 与其它历史 turn/item notification 不因 resume 而放宽 ownership。

未来启用 streaming 前必须先补 delta/final 去重与顺序 contract tests；启用后 `text_final` 仍承载完整 final text，daemon 的 outbound 聚合不得重复展示。首版只发 final。unknown item type 记录有界 diagnostic 并忽略；unknown terminal status、ownership id 或 ServerRequest 不得忽略。

## ServerRequest 与安全默认

app-server 会向 client 发带 `id + method + params` 的 ServerRequest。它不是 notification，必须恰好响应一次，否则 turn 会永久等待。0.146 stable schema 的完整处理表如下；JSON-RPC error 指带原 request id 的合法 error response，不是丢弃请求：

| method | 归属校验 | exact response | terminal effect |
|---|---|---|---|
| `item/commandExecution/requestApproval` | threadId+turnId+itemId 必须匹配 | `{decision:"decline"}` | 等待上游 turn terminal；超时走 interrupt |
| `item/fileChange/requestApproval` | threadId+turnId+itemId 必须匹配 | `{decision:"decline"}` | 同上 |
| legacy `execCommandApproval` | `conversationId` 必须匹配当前 thread，`callId` 必须匹配当前 turn 已观察到的 item | `{decision:{denied:{rejection:"agent-nexus approval broker disabled"}}}` | 同上 |
| legacy `applyPatchApproval` | `conversationId` 必须匹配当前 thread，`callId` 必须匹配当前 turn 已观察到的 item | `{decision:{denied:{rejection:"agent-nexus approval broker disabled"}}}` | 同上 |
| `mcpServer/elicitation/request` | required `serverName+threadId` 必须存在且 thread 匹配；optional + nullable `turnId` 为字符串时必须匹配当前 turn；`form.requestedSchema` 至少为 `{type:"object",properties:{...}}`，`openai/form` 必须存在 `requestedSchema`，`url` 必须含非空 `elicitationId+url` | `{action:"cancel",content:null,_meta:null}` | 回包后结束 child；不能把 foreign request 归到平台 turn |
| `item/permissions/requestApproval` | threadId+turnId+itemId 必须匹配 | JSON-RPC error `-32001`（schema 没有 deny variant） | 立即 interrupt；未终止则升级结束 child |
| `item/tool/requestUserInput` | threadId+turnId+itemId 必须匹配 | JSON-RPC error `-32001`（首版无安全 cancel payload） | 立即 interrupt；未终止则升级结束 child |
| `item/tool/call` | threadId+turnId 必须匹配 | JSON-RPC error `-32601` | 立即 interrupt；未终止则升级结束 child |
| `account/chatgptAuthTokens/refresh` | connection-scoped；不得含 thread/turn 假关联 | JSON-RPC error `-32002` | 认证失效：Busy 时 `error` + `turn_finished(error)`，再结束 child并 `session_stopped(error)`；下次启动只按受控 rotation 规则 reseed，不回传 source token |
| `attestation/generate` | connection-scoped；initialize 已声明 `requestAttestation=false` | JSON-RPC error `-32601` | protocol/compatibility error，结束 child |
| unknown request | 能关联时必须匹配当前 ownership | JSON-RPC error `-32601` | interrupt；不能关联或不能确认安全终态则结束 child |

首版固定 `approvalPolicy="never"`。runtime method 集必须由 committed snapshot 派生：notification 不在 0.146 stable allowlist 时立即结束 session；ServerRequest 不在 allowlist、params 缺少表内安全关键字段、thread/turn/item ownership 不匹配时按 protocol error 结束。首版只允许固定 deny/cancel/error 响应，不用宽松类型推导任何 grant；对应响应结构由 snapshot contract test 固定。request deadline、daemon disconnect、身份不匹配、duplicate/late response 默认走上表拒绝或结束 session，绝不批准。permissions 与 request-user-input 的错误响应是否能稳定触发安全终态仍需真实 probe；probe 未通过时 CompatibilityProbe 必须拒绝发布该 Codex 版本。

完整飞书 approve/deny/answer UI 需要新增 protocol event/input contract、身份与 pending-request persistence；在该 contract 合入前不得把 `approvalPolicy` 改为交互模式。实现该 broker 后，本节通过 spec amendment 扩展，不以通用文本消息猜测表单答案。

## Interrupt、timeout、stop 与 crash

- `interrupt()` 只在 Busy 时调用一次 `turn/interrupt(threadId,turnId)`，等待匹配的 `turn/completed(interrupted)`；Idle 时是幂等 no-op。`interruptGraceMs` 内没有 terminal 时结束 process group并由 runtime 合成 `turn_finished(user_interrupt)`。
- wall-clock deadline 到达时先原子 CAS terminal latch；CAS 成功即发唯一 `turn_finished(wallclock_timeout)`，再发 `turn/interrupt` 做后台收尾。grace 内匹配 `turn/completed` 只确认 cleanup，不再提升第二个 terminal；grace 到期则结束 process group，发 `error(timeout/process)`、cleanup、`session_stopped(wallclock_timeout)`。若自然 terminal 在 deadline callback CAS 前已经赢 latch，timeout callback 无动作。
- `stopSession()` 返回可等待且幂等的 Promise；首次调用立即关闭 liveness，Busy 时先请求 interrupt，grace 到期则结束 process group并合成 `turn_finished(user_interrupt)`。supplemental viewer 是 backend-owned child，属于同一 stop barrier：先 force-stop viewer，再结束 app-server、reject RPC pending、关闭 pipe/socket，最后撤销 capability token；只有两类 child 都确认退出后才删除整个 incarnation runtime dir、发 `session_stopped(user_stop)` 并 resolve。viewer 已自然退出视为幂等成功；若 viewer 退出无法确认，仍必须删除 token 文件并结束 app-server，但保留不含 capability token 的 recovery metadata/launcher 供 next-start reconciliation，stop Promise reject，不能发 `session_stopped(user_stop)` 假报完整 cleanup。并发 stop 共享同一个完成结果，daemon 不得在 settle 前启动替代 session。
- child/pipe unexpected exit：所有 pending request reject；Busy turn 先 `error(process|host_protocol)` 与 `turn_finished(error)`，随后 cleanup 与 `session_stopped(error)`。Idle session 也必须进入 Stopped，不能保留幽灵 session。
- daemon restart 后只允许在同一 durable home 用持久化 thread id 恢复 idle conversation。in-flight turn、pending ServerRequest 和 experimental background process 默认不可恢复；恢复审计无法证明安全终态时，标记上一 session error，不自动重放输入。

terminal latch 的 winner 是 runtime 第一次接受的匹配 `turn/completed`、deadline callback 成功的原子 CAS，或其它 grace 到期/child exit 后首次 runtime-synthesized terminal；winner 原子关闭 latch。随后到达的 response、notification、timeout callback 或 child exit只记 bounded late diagnostic，不得再发 terminal：

| 触发 | grace 内上游 terminal | grace 到期/child exit | 最终 turn | session |
|---|---|---|---|---|
| user interrupt | 使用上游 completed/interrupted；其它状态按实际映射并记 protocol warning | kill group | `user_interrupt` 恰好一次 | 保持 Idle；强杀则 Stopped(error) |
| wallclock timeout | deadline callback CAS 赢后立即发 timeout terminal；随后上游 terminal仅确认 cleanup | grace 到期 kill group | `wallclock_timeout` 恰好一次 | grace 内确认后 Idle；强杀后 `session_stopped(wallclock_timeout)` |
| user stop | 若 terminal 先到按实际 reason；随后仍 stop child | kill group | 无 terminal时合成 `user_interrupt` | `session_stopped(user_stop)` |
| natural completed | completed notification 赢 | child 先退出则 `error` | 按 completed status | Idle 或 Stopped(error) |
| unexpected child exit | 已有 terminal则不重发 | exit 赢 | 无 terminal时合成 `error` | `session_stopped(error)` |

## 隔离与配置继承

安全 owner 是 [`../security/tool-boundary.md`](../security/tool-boundary.md)。本 backend 强制：

- conversation-private durable `CODEX_HOME`，只包含受校验的 auth snapshot、Codex 自身生成的 thread/rollout state 与 agent-nexus 生成的最小 config；
- 默认不继承用户 config、rules、MCP、hooks、skills、plugins、features、model 或其它 Codex state；
- child env 使用 allowlist，显式移除 OpenAI override、飞书/Discord/数据库/daemon secrets；
- `cwd` 使用 canonical `SessionConfig.workingDir`；sandbox/addDirs 只来自 `codexAppServer` owner config；approval 首版固定 never；
- app-server 返回的 `codexHome` 必须等于注入路径，否则立即终止；normal stop/shutdown 保留该目录，只有显式启用的 backend-owned retention GC 才能删除 committed conversation；
- 不写回源 auth/config，不把 session thread、request id 或控制 pipe 暴露为平台可猜测 handle。

隔离只限制静默配置继承，不声称能抵御同 uid 恶意进程；OS sandbox 与部署隔离仍是纵深边界。

runtime 还接收 CLI 组装层注入、平台消息不可配置的可信依赖：

```text
CodexAppServerRuntimeDependencies {
  sourceCodexHome: canonical absolute path
  persistenceRoot: canonical absolute path
}
```

`sourceCodexHome` 由 CLI 在启动时从 operator 的有效 Codex home 解析，只用于首次创建 conversation home或认证 rotation 时读取 `auth.json`；agent package 不读取 `HOME`，配置文件与飞书消息也不能覆盖该路径。`persistenceRoot` 固定在 agent-nexus home 下，由 CLI 创建并注入。

fresh conversation 在写任何 secret 前生成不可预测 128-bit `homeId`，创建 `<persistenceRoot>/homes/<homeId>`，并先原子写入 `{homeId,status:"creating",threadId:null,createdAt,owner}` provisional registry record。只有 `thread/start` response 返回 thread id、home metadata 落盘、registry 原子提交为 `{status:"committed",threadId,lastUsedAt}` 后，runtime 才发 `session_started` 并向 daemon 暴露 opaque thread id。

start error、ambiguous response、child exit或进程在 commit 前崩溃时，provisional record 对外没有 agentSessionId，不能 resume。runtime 启动 registry 时先持有 exclusive registry lock并 reconciliation：所有没有 live owner lease 的 `creating` record 连同 home 安全删除；删除失败则整个 factory fail closed。即使 Codex 已在该 home 写入 thread，未 commit 的 thread 也视为未创建成功，不尝试猜测或恢复。commit 必须用 temp+fsync+atomic rename；home metadata 与 registry 任一提交失败都结束 child并留下可由 reconciliation 识别的 creating record。

resume 只能按 daemon 回传的 opaque thread id 查询 committed registry，校验 home metadata 中的 backend id、agent name 与 thread id 后启动 child。thread id 重复、registry/home 缺失或 metadata 不一致 fail closed。SessionKey 只作为创建/rebind 审计字段，不决定 home identity；因此同一 SessionKey 的多个 `/new` generation 各有独立 home，conversation rebind 到新 SessionKey 仍定位原 home。

现有 `AgentRuntime` 没有 daemon archive/delete callback，首版不得声称跟随 RoutingSession archive 即时清理。conversation GC 完全由本 backend owner：`conversationRetentionMs=null` 时不删除 committed home；显式配置正整数后，factory start 与固定低频 timer 只处理 `lastUsedAt < now-retention`、没有 live owner lease 的 committed record。GC 先原子将 record 标记为不可 resume/不可 acquire-live 的 `deleting` tombstone，再安全删除对应的单个 home，最后原子移除 tombstone；任一删除或持久化失败都 fail closed 并保留可重试 tombstone。registry 启动 reconciliation 在校验 committed home 前先重试所有 `creating` 与 `deleting` record，不扫描或删除 registry 未索引的其它目录。`lastUsedAt` 在成功 start/resume/turn terminal 时更新。该策略可能让超过 retention 的 daemon 历史 ref不可恢复，属于 operator 显式选择，必须有 warn；GC 不需要也不得反向调用 daemon。

审计中的 SessionKey 使用字段顺序固定的 JSON tuple UTF-8 编码：`[platformName,platform,channelId,initiatorUserId]`；thread 已折叠进 `channelId`，不得另造字段。禁止复用现有冒号拼接序列化作为 identity/hash 输入。编码与 round-trip/collision fixture 属 registry contract test。

## 配置

配置 owner 为 `agents[].codexAppServer`：

```text
CodexAppServerConfig {
  bin: string
  workingDir: absolute path
  sandbox: "read-only" | "workspace-write" | "danger-full-access"
  addDirs: absolute path[]
  maxInputBytes: 1..1048576
  requestTimeoutMs: 1..300000
  interruptGraceMs: 1..60000
  terminateGraceMs: 1..60000
  conversationRetentionMs: null | 60000..2147483647
  supplementalViewer: {
    enabled: boolean
  }
}
```

`conversationRetentionMs` 默认 `null`（不自动删除 committed conversation）；非 null 必须产生可能使历史 ref 失效的 warn。其它默认值为：`bin="codex"`、`sandbox="read-only"`、`addDirs=[]`、`maxInputBytes=262144`、`requestTimeoutMs=30000`、`interruptGraceMs=5000`、`terminateGraceMs=5000`、`supplementalViewer.enabled=false`。`approvalPolicy`、experimental API、listen address、remote auth、viewer endpoint/token/token file/tmux 参数、user config inheritance 与 dangerous bypass 不可由用户配置。`danger-full-access` 必须产生日志与平台首条安全警告。

`supplementalViewer.enabled` 是 restart-only 的 operator intent。缺省或 `false` 必须继续选择匿名 stdio host，且不得创建 token、WebSocket listener 或 viewer。`true` 时 factory 仅在 Codex 专用 viewer adapter 可用且当前 binary 通过 viewer-specific compatibility gate 时选择 authenticated loopback WebSocket；任一 gate 在 listener 创建前失败都记录 `codex_supplemental_viewer_unavailable` 并回退 stdio。listener 建立后，已确认没有残留 process/socket 的 viewer start failure或 viewer 自然退出只记 maintenance warning，structured controller 继续作为唯一业务事实源，不发 `AgentEvent.error`，不改变已接收的 turn terminal。ambiguous start 必须返回并跟踪可能 live 的 handle，不能伪装成“无 viewer”；session stop 时 viewer cleanup 失败按 stop barrier 规则 reject，仍删除 token 文件并清理 structured host，但保留不含 capability token 的 private recovery metadata 直到 next-start reconciliation 确认 viewer 已退出。

agent-nexus 生成并维护 conversation-private `config.toml`，固定 `check_for_update_on_startup=false`。该值不可由 operator 配置；passive viewer 无人可确认版本更新 modal，允许该 modal 会令后续 incarnation 的 observer 永久停在启动界面。升级前已创建的 managed config 在 resume 时以 private temp file + fsync + atomic rename 收敛到当前内容。

专用 `CodexRemoteViewerAdapter` 只接受由 backend 产生的 `(homeId, appServerIncarnationId, threadId)` binding 与不含明文 token 的 admission descriptor。adapter 构造固定 remote TUI launcher；generic `TerminalSessionHost.start()` 只看到 `process.execPath`、受控 launcher、private token-file path 与普通 allowlisted env，不得接收 `AGENT_NEXUS_CODEX_REMOTE_TOKEN`。launcher 校验同一 private runtime dir 中 owner/mode 为 `0600` 的 token file 后，只向对应 Codex viewer child 注入单用途 token。viewer 只能在 fresh registry commit 或 resume audit 与 live lease 完成后启动；stop/crash/reconciliation 必须先 force-stop 对应 incarnation viewer，再销毁 token/runtime dir。旧 endpoint、token、pane 或仅凭 thread id 的 handle 不可复用。首个 stable adapter 不向 CLI、平台或操作者返回 generic write 与可写 attach surface；interactive takeover 需要另行扩展 foreign-turn admission、trace/audit 与串行化 contract。

## 测试与 release gate

最低证据：

1. schema fixture：0.146 完整 stable schema snapshot 与 hash manifest 可复现，allowlist 全部解析；unknown/duplicate/late/oversized/truncated frame fail closed。
2. fake app-server 集成：双轮同 thread、两个 SessionKey 隔离、concurrent input queue、delta 已知但不提升、final 单次提升、tool item 不提升、usage 在未启用时不提升、terminal latch。
3. ServerRequest：0.146 表中每个 method 恰好得到对应 exact result/error；unknown、timeout、disconnect 均 fail closed，副作用未发生。
4. lifecycle：start failure、turn timeout、interrupt、stop、child crash、daemon shutdown 后无 child/process-group/pending request 残留；pre-commit crash 由 reconciliation 清 creating home，committed home 保留且 owner 不串线，只有显式 backend retention GC 才删除。
5. real Codex：initialize、两轮、status、final、interrupt；隔离 `CODEX_HOME` 中 user MCP/skills/plugins 未加载。
6. restart/rebind：idle thread id 可由 registry 在新 child/新 SessionKey `thread/resume`；同一 SessionKey 多 generation 不共用 home；in-flight turn 不被自动重放。
7. Node 22 与 24、macOS arm64/x64、Linux x64；未覆盖平台 fail closed。
8. packed CLI：原始 schema testdata 不进入公开包；发布前先证明 snapshot hash 与 snapshot-derived runtime contract 已进入 bundle，再从安装后的 CLI release-verification 入口启动 app-server、完成一轮并等待清理，不能只跑源码测试或首次配置脚手架。
9. authenticated viewer：真实 tmux `codex --remote` 与 structured controller 同时连接；controller final 出现在 terminal snapshot，旧 token 对新 incarnation 返回 401；真实 viewer 输入 foreign turn 时不产生平台 `error/text/item/turn`，只在 cleanup 完成后产生 `session_stopped(system/error)`。
10. hard crash：独立 daemon worker 完成一轮后 SIGKILL；匿名 pipe supervisor 必须清除旧 app-server PGID，next-start reconciliation 必须清除旧 viewer PGID/token/stale lease，随后同一 thread 在新 incarnation resume 并完成一轮。

experimental process/background terminal 不得用上述首版 gate 冒充完成。passive remote TUI viewer 只有在 ADR-0023、terminal-session spec 的 admission、incarnation、secret hygiene、双 client 广播和真实 E2E 门禁全部通过后才算完成；stdio 主路径测试不能替代这些证据。可写 attach / 人工接管不属于该 gate。

## Attribution

设计参考 `deepcoldy/botmux` 的 MIT hybrid app-server/TUI 分层；没有从其实现复制源代码。若后续复制 substantial code，必须在对应文件与发行物保留 botmux copyright/MIT notice，并记录上游 commit。app-server schema snapshot 来自 OpenAI Codex，必须保留生成来源、版本及上游许可证要求。
