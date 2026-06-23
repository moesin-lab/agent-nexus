---
title: Spec：Trajectory Observability（轨迹读模型）
type: spec
status: active
summary: daemon-owned trajectory read model、外部 session 导入、native resume 绑定与 opt-in provider-call observation 契约
tags: [spec, observability, session, persistence, tracing, security]
related:
  - dev/adr/0018-trajectory-observability-read-model
  - dev/architecture/session-model
  - dev/spec/agent-runtime
  - dev/spec/infra/persistence
  - dev/spec/infra/observability
  - dev/spec/security/redaction
contracts:
  - TrajectoryReadModel
  - ExternalSessionSourceAdapter
  - ExternalSessionImport
  - ProviderCallObservation
  - TrajectoryObservabilityConfig
---

# Spec：Trajectory Observability（轨迹读模型）

本 spec 定义 daemon-owned trajectory read model。它把 RoutingSession、AgentEvent transcript、usage/log anchor、外部 transcript segment 与可选 provider-call observation 串成可查询的审计视图。

## 非目标

- 不定义前端 viewer 或 CLI UX。
- 不定义 provider proxy 的具体实现方式。
- 不把外部 transcript 回放进模型上下文。
- 不改变 `AgentRuntime` 对 native resume ref 的 owner 边界。
- 不替代 logs、transcripts、usage_events 各自的 owner spec。

## 术语

| 名称 | Owner | 含义 |
|---|---|---|
| `TrajectoryReadModel` | daemon | 面向查询的轨迹视图，聚合 session、event、usage、log、import 与 provider observation anchor |
| `TrajectorySegment` | daemon | read model 的最小展示单元，可来自 Nexus event、外部导入或 provider observation |
| `ExternalSessionCandidate` | source adapter | 发现到的外部原生 session，尚未被 Nexus 管理 |
| `ImportedTranscriptSegment` | source adapter | 从外部 transcript 解析出的脱敏片段，写入 Nexus 后成为 `TrajectorySegment` |
| `ProviderCallObservation` | daemon observability | opt-in 捕获的 provider/request-level metadata 与受限 payload |
| `nativeSessionRef` | agent package | agent 原生会话引用，对 daemon opaque；写入 `sessions.agent_conversation_ref` 后用于 resume |

## 硬边界

- 外部 transcript 内容不得写入 `AgentInput`、system prompt、tool result 或 backend replay buffer。
- Daemon 不解析 `nativeSessionRef` 的语义；只保存、传递和审计。
- Source adapter 可以理解外部 schema，但不得把外部 record 直接暴露为 Nexus 内部事件类型。
- Provider capture 默认关闭，任何未知 backend/auth/mode 都必须 fail-closed。
- Provider observation 的 header、body、raw stream 在落盘前必须经过 redaction 和 size limit。
- 导入失败、capture 失败、resume 不可用都是可观测状态，不得静默降级为普通 transcript。

## 配置

`TrajectoryObservabilityConfig` 嵌入 `DaemonRuntimeConfig`，字段归 daemon owner 校验。

```text
TrajectoryObservabilityConfig {
    enabled: boolean = true
    externalImport: ExternalImportConfig?
    providerCapture: ProviderCaptureConfig?
    retention: TrajectoryRetentionConfig?
}

ExternalImportConfig {
    enabled: boolean = false
    sources: ExternalImportSourceConfig[] = []
    metadataOnlyDiscovery: boolean = true
    importContent: boolean = false
    maxFileBytes: integer = 10485760
    maxRecordsPerSession: integer = 20000
    maxAgeDays: integer? = null
}

ExternalImportSourceConfig {
    adapter: "codex-cli-jsonl" | "codex-app-jsonl" | "claude-code-jsonl"
    root: path
    projectPathAllowlist: path[] = []
}

ProviderCaptureConfig {
    enabled: boolean = false
    mode: "reverse-proxy" | "forward-proxy" | "transcript-only" = "transcript-only"
    bindHost: string = "127.0.0.1"
    port: integer? = null
    storeRawStreams: boolean = false
    maxRequestBytes: integer = 1048576
    maxResponseBytes: integer = 4194304
    retentionDays: integer = 30
}

TrajectoryRetentionConfig {
    importedSegmentsDays: integer? = 90
    providerObservationsDays: integer? = 30
}
```

字段规则：

| 字段 | 规则 |
|---|---|
| `enabled` | `false` 时不写 trajectory read model 增量数据；现有 session/transcript/log 行为不变 |
| `externalImport.enabled` | `false` 时不扫描外部根目录 |
| `externalImport.metadataOnlyDiscovery` | `true` 时 discovery 只读取外部 session metadata 和 record 计数，不导入正文 |
| `externalImport.importContent` | `false` 时只登记 candidate 与 native ref eligibility；不得写 transcript segment 正文 |
| `externalImport.sources[].root` | 必须是显式路径；不允许自动扫描整个 home |
| `externalImport.sources[].projectPathAllowlist` | 非空时只接受 project path 命中的 session；路径比较使用规范化绝对路径 |
| `providerCapture.enabled` | 默认 `false`；开启也必须通过 support matrix 判定 |
| `providerCapture.bindHost` | 默认只能绑定 loopback；非 loopback 需要后续安全 spec 扩展 |
| `providerCapture.storeRawStreams` | 默认 `false`；`true` 时只保存 redacted + size-limited stream frame |
| `retention.*Days` | `null` 表示保留到用户显式清理；不得绕过 redaction |

## 外部来源适配器

Source adapter 把外部 session store 的 schema 漂移隔离在 daemon 边界外侧。

```text
interface ExternalSessionSourceAdapter {
    id() -> string
    discover(input: DiscoverExternalSessionsInput) -> ExternalSessionCandidate[]
    import(candidate: ExternalSessionCandidate, policy: ExternalImportPolicy) -> ImportedTranscriptSegment[]
    resumeEligibility(candidate: ExternalSessionCandidate) -> ResumeEligibility
}
```

```text
DiscoverExternalSessionsInput {
    root: path
    projectPathAllowlist: path[]
    metadataOnly: boolean
    maxFileBytes: integer
    maxRecordsPerSession: integer
    maxAgeDays: integer?
}

ExternalSessionCandidate {
    sourceAdapter: string
    sourceSessionId: string
    sourcePath: path
    nativeSessionRef: string?
    projectPath: path?
    createdAt: string?
    updatedAt: string?
    recordCount: integer?
    firstUserMessageSummary: string?
    schemaVersion: string?
    confidence: Confidence
    unsupportedReasons: string[]
}

ResumeEligibility {
    canResume: boolean
    nativeSessionRef: string?
    confidence: Confidence
    reasons: string[]
}

Confidence = "high" | "medium" | "low" | "unknown"
```

`Confidence` 用于排序或 `minConfidence` 过滤时按 `high > medium > low > unknown` 处理。`minConfidence` 任意非空时都排除 `unknown`，避免把未知可信度误当低可信度通过过滤。

Adapter 要求：

- Discovery 只能返回 metadata 和摘要；daemon 在接收 candidate 并写 Store 前必须统一执行 redaction，不能信任 adapter 已经脱敏。Adapter 可以提前脱敏，但不得把未脱敏摘要写入 Store。
- `nativeSessionRef` 只表示 agent package 可能 resume，不表示 transcript 已导入。
- `unsupportedReasons` 必须稳定可测试，例如 `missing-native-session-ref`、`schema-unknown`、`outside-project-allowlist`。
- 单个 candidate 读取超过 `maxFileBytes` 或 `maxRecordsPerSession` 时返回 unsupported，不做部分正文导入。
- Adapter 不得写 Store；它只返回结构化结果，由 daemon 写入。

## 导入状态

```text
ExternalSessionImport {
    importId: string
    sourceAdapter: string
    sourceSessionId: string
    sourcePathHash: string
    nativeSessionRef: string?
    linkedSessionId: string?
    state: ImportState
    confidence: Confidence
    metadataJson: string
    error: ImportError?
    discoveredAt: string
    importedAt: string?
    linkedAt: string?
}

ImportState =
    "discovered" |
    "registered" |
    "imported" |
    "linked" |
    "rejected" |
    "failed" |
    "retired"

ImportError {
    code: string
    message: string
    retryable: boolean
}
```

状态转换：

| From | To | 触发 |
|---|---|---|
| none | `discovered` | source adapter 找到 candidate |
| `discovered` | `registered` | daemon 接受 candidate metadata，但未导入正文 |
| `registered` | `imported` | policy 允许 `importContent` 且 segment 写入成功 |
| `registered` / `imported` | `linked` | 用户把 candidate resume 到 Nexus RoutingSession |
| `discovered` / `registered` | `rejected` | policy 拒绝或用户忽略 |
| any non-terminal | `failed` | 读取、解析、redaction 或写入失败 |
| any terminal | `retired` | retention / 用户清理 |

`linked` 不要求先 `imported`：native resume 只依赖 `nativeSessionRef` 与 agent package 支持，不依赖 transcript 正文导入。

## Trajectory Segment

```text
TrajectorySegment {
    segmentId: string
    sessionId: string?
    importId: string?
    providerObservationId: string?
    source: SegmentSource
    kind: SegmentKind
    traceId: string?
    turnSequence: integer?
    sequence: integer
    ts: string
    summary: string
    contentRef: string?
    usageEventId: string?
    logAnchor: LogAnchor?
    confidence: Confidence
    redactionState: "redacted" | "metadata-only" | "dropped"
    metadataJson: string
}

SegmentSource =
    "nexus-agent-event" |
    "external-import" |
    "provider-call"

SegmentKind =
    "user-message" |
    "agent-message" |
    "reasoning" |
    "tool-call" |
    "tool-result" |
    "usage" |
    "provider-request" |
    "provider-response" |
    "state-change" |
    "unknown"

LogAnchor {
    logFile: path?
    byteOffset: integer?
    event: string?
}
```

规则：

- `summary` 必须可安全展示，永远经过 redaction。
- `contentRef` 指向 Nexus 管理的 transcript/provider storage，不指向外部原始文件。
- `sessionId` 只有存在持久 `sessions` 行时填写；未链接外部导入或尚无持久 session 行时，segment 必须以 `importId` 或 `providerObservationId` 为 anchor，不得伪造临时 session id。
- `sequence` 在同一 `sessionId` 内单调递增；外部 import 未链接前可只在 `importId` 内排序。
- `redactionState = "dropped"` 时不得有 `contentRef`。
- `unknown` 是显式状态，用于 schema 漂移，不能把原始 JSON 裸塞进 `summary`。

## Native Resume 绑定

```text
ExternalResumeBinding {
    sessionId: string
    importId: string
    sourceAdapter: string
    sourceSessionId: string
    nativeSessionRef: string
    confidence: Confidence
    linkedAt: string
}
```

`ExternalResumeBinding` 是 `external_session_imports` 与 `sessions.agent_conversation_ref` 的逻辑投影，不新增独立存储表。持久化字段见 [`persistence.md`](persistence.md#external_session_imports) 与 [`persistence.md` §sessions](persistence.md#sessions)。

绑定规则：

- 用户选择外部 candidate resume 时，daemon 创建或更新当前 RoutingSession，并立即把 `nativeSessionRef` 写入 `sessions.agent_conversation_ref`。
- 下一次启动 agent 时，daemon 把该 ref 作为 `SessionConfig.resumeFromAgentSessionId` 传给对应 runtime。
- Runtime 返回新的 conversation ref 时，按 persistence 的 `agent_conversation_ref` 更新语义覆盖。
- 如果当前 RoutingSession 的 agent backend 与 candidate source 不兼容，必须拒绝绑定。
- 如果 candidate 没有 `nativeSessionRef` 或 `ResumeEligibility.canResume = false`，只能导入/登记，不能 resume。
- 绑定不要求导入正文；导入正文也不允许替代 native resume。

## Provider-call Observation

Provider capture 是 trajectory 的可选来源，不是默认路径。

```text
ProviderCallObservation {
    observationId: string
    sessionId: string?
    traceId: string?
    backend: "claudecode" | "codex" | string
    captureMode: "reverse-proxy" | "forward-proxy" | "transcript-only"
    requestStartedAt: string
    responseFinishedAt: string?
    providerHost: string?
    model: string?
    requestSummary: string
    responseSummary: string?
    requestBodyRef: string?
    responseBodyRef: string?
    streamFramesRef: string?
    requestBytes: integer
    responseBytes: integer?
    redactionState: "redacted" | "metadata-only" | "dropped"
    alignment: ProviderTurnAlignment
    errorCode: string?
    metadataJson: string
}

ProviderTurnAlignment {
    confidence: Confidence
    turnSequence: integer?
    agentEventSequence: integer?
    reasons: string[]
}
```

Capture 规则：

- 不支持的 backend/auth/mode 不启动 capture，并记录 `provider_capture_failed` 或 discovery unsupported reason。
- header 与 body 落盘前必须过 redaction；redaction 失败时 observation 只能 metadata-only 或 dropped。
- `requestBodyRef`、`responseBodyRef`、`streamFramesRef` 只允许指向 `<home>/trajectory/provider-calls/` 下的 Nexus 管理文件。
- `storeRawStreams = false` 时不得保存 raw SSE/WebSocket frames，只允许保存摘要和计数。
- `alignment.confidence` 低于 `medium` 时，UI 或报告不得把 observation 展示为确定属于某个 turn。

支持矩阵：

| backend/auth/source | `reverse-proxy` | `forward-proxy` | `transcript-only` | 默认 |
|---|---|---|---|---|
| Claude Code API/base-url compatible | allowed | allowed | allowed | off |
| Claude Code native Bedrock SigV4 | unsupported | allowed | allowed | off |
| Codex CLI API key | allowed | allowed | allowed | off |
| Codex CLI OAuth | allowed | allowed | allowed | off |
| Codex App/Desktop local transcript | unsupported | unsupported | allowed | off |
| unknown | unsupported | unsupported | unsupported | off |

## 查询契约

```text
TrajectoryQuery {
    sessionId: string?
    importId: string?
    source: SegmentSource?
    kinds: SegmentKind[]
    since: string?
    until: string?
    minConfidence: Confidence?
    includeContent: boolean = false
    limit: integer = 100
    cursor: string?
}

TrajectoryPage {
    segments: TrajectorySegment[]
    nextCursor: string?
}
```

查询规则：

- `includeContent = false` 时只返回摘要、anchor 与 metadata。
- `includeContent = true` 仍必须返回 redacted 内容；不得读取外部原始 transcript。
- `limit` 必须有上限，默认 100，最大 1000。
- 按 `ts ASC, sequence ASC` 稳定排序。
- 查询不到内容与 redaction dropped 必须可区分。

## 错误码

稳定错误码：

| code | 含义 |
|---|---|
| `trajectory-disabled` | read model 被配置关闭 |
| `external-import-disabled` | 外部导入未启用 |
| `external-source-unsupported` | adapter 不支持该来源或 schema |
| `external-source-too-large` | 文件或 record 数超过 policy |
| `external-source-outside-allowlist` | project path 不在 allowlist |
| `native-resume-unavailable` | 无可用 native ref |
| `native-resume-backend-mismatch` | candidate 与当前 agent backend 不兼容 |
| `provider-capture-disabled` | provider capture 未启用 |
| `provider-capture-unsupported` | backend/auth/mode 不支持 |
| `provider-capture-redaction-failed` | redaction 失败，payload 已丢弃 |

日志事件字段见 [`observability.md`](observability.md)，出口过滤见 [`../security/redaction.md`](../security/redaction.md)。

## 合约测试

- `externalImport.enabled=false` 时不扫描 root。
- discovery metadata-only 不读取或返回正文。
- 超过 `maxFileBytes` 的 candidate 被标记 unsupported。
- project path 不在 allowlist 时 fail-closed。
- `importContent=false` 时不写 `TrajectorySegment.contentRef`。
- `linked` 可以从 `registered` 直接进入，不要求先 `imported`。
- `nativeSessionRef` 写入 `agent_conversation_ref`，下一次 spawn 传入 `resumeFromAgentSessionId`。
- backend mismatch 拒绝 resume，不清除已有 RoutingSession ref。
- provider capture 默认关闭。
- redaction 失败时 provider payload 不落盘。
- `includeContent=true` 不读取外部原始 transcript。
- unknown schema 产生 `unknown` segment 或 unsupported reason，不抛裸异常。

## 反模式

- 把外部 transcript 拼进 prompt 作为“恢复”。
- 把 source adapter 的原始 JSON 直接存进 `TrajectorySegment.summary`。
- 默认开启 provider proxy。
- 用日志文件路径代替 `ExternalSessionImport` 状态机。
- 让 UI 直接读 `~/.codex` 或 `~/.claude` 原始目录。
- 把 provider raw stream 永久保存且不经 redaction。
