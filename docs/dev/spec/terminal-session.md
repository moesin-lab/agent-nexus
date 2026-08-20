---
title: Spec：Supplemental Terminal Session
type: spec
status: active
summary: 补充终端会话的所有权、生命周期、输入、快照、人工 attach 与失败边界；终端观察不得提升为 agent 业务状态
tags: [spec, terminal, pty, tmux, tui]
related:
  - dev/adr/0023-supplemental-terminal-session-host
  - dev/adr/0022-codex-app-server-primary-tui-supplemental
  - dev/spec/agent-runtime
  - dev/spec/security/tool-boundary
  - dev/architecture/session-model
contracts:
  - TerminalSessionHost
  - TerminalSessionHandle
  - TerminalObservation
---

# Spec：Supplemental Terminal Session

本 spec 只定义补充终端的进程与字节流 seam。它不定义 agent turn、消息提升、Codex app-server transport 或飞书交互；这些分别由 agent runtime、backend 与平台 spec 所有。

## 不变量

- `TerminalSessionHandle` 由 host 生成，caller 不得指定底层 pane、socket 或进程名。
- 每次调用同时校验 opaque `sessionId` 与 `ownerToken`；仅知道 session id 不授予控制权。
- 不可信的 executable、args 与 env 不进入 shell command。tmux adapter 可以让 tmux shell 启动项目生成的固定 launcher；launcher 从私有一次性记录读取参数，再以 argv array 启动真正 child。`cwd` 必须是已解析绝对目录。
- generic host 的 child environment 只允许 `PATH`、`HOME`、`LANG`、`LC_ALL`、`TERM`、`COLORTERM`、`NO_COLOR` 与 `CODEX_HOME`；必须拒绝所有其它 env，包括 `AGENT_NEXUS_CODEX_REMOTE_TOKEN`、平台密钥、daemon routing id 与用户 agent 扩展配置。Codex 专用 viewer adapter 通过固定 private launcher 从受校验的 `0600` token file 读取单用途 token，并只注入对应 Codex viewer child；generic host、tmux global environment、snapshot、attach descriptor 与日志均不得获得 token value。
- snapshot 是可截断、可滞后的弱观察，不能生成 `turn_finished`、approval、usage 或强 `AgentSessionState`。
- 同一会话的 mutation 串行；不同会话可并行。
- host restart 后只有实现明确返回为 `Recoverable` 的会话允许 recover；未知 owner、命名冲突或部分状态必须 fail closed。

## 类型

```text
TerminalSessionState = Starting | Running | Exited | Stopped | Lost

TerminalSessionStart = {
  executable: absolute path | allowlisted command name
  args: string[]
  cwd: absolute directory
  env: map<string, string>
  cols: integer 20..500
  rows: integer 5..300
  ownerToken: opaque random string, minimum 128 bits
}

TerminalSessionHandle = {
  sessionId: opaque string
  ownerToken: opaque random string
  incarnationId: opaque random string
  state: TerminalSessionState
}

TerminalWrite =
  | { mode: Raw, data: bytes }
  | { mode: BracketedPaste, text: string }
  | { mode: Keys, keys: TerminalKey[] }

TerminalObservation = {
  sessionId: opaque string
  incarnationId: opaque string
  text: string
  truncated: boolean
  observedAt: timestamp
  evidence: WeakTerminalSnapshot
}

TerminalAttachDescriptor = {
  transport: LocalProcess
  executable: absolute path | allowlisted command name
  args: string[]
  expiresAt: timestamp | null
}
```

`TerminalKey` 首版只允许 `Enter`、`Escape`、`Tab`、`Backspace`、`Up`、`Down`、`Left`、`Right`、`Home`、`End`、`PageUp`、`PageDown`、`CtrlC`、`CtrlD`。任意字符串或 shell fragment 不是合法 key。

## 接口

```text
TerminalSessionHost.start(config: TerminalSessionStart, lifecycle?: { onAllocated(handle) })
  -> TerminalSessionHandle

TerminalSessionHost.inspect(sessionId, ownerToken, incarnationId)
  -> TerminalSessionHandle

TerminalSessionHost.write(sessionId, ownerToken, incarnationId, input: TerminalWrite)
  -> { acceptedBytes, incarnationId }

TerminalSessionHost.resize(sessionId, ownerToken, incarnationId, cols, rows)
  -> { incarnationId }

TerminalSessionHost.snapshot(sessionId, ownerToken, incarnationId, maxChars)
  -> TerminalObservation

TerminalSessionHost.attach(sessionId, ownerToken, incarnationId)
  -> TerminalAttachDescriptor | null

TerminalSessionHost.stop(sessionId, ownerToken, incarnationId, mode: Graceful | Force)
  -> { state: Stopped | Exited, alreadyTerminal: boolean }

TerminalSessionHost.recover(sessionId, ownerToken)
  -> TerminalSessionHandle

TerminalSessionHost.reconcileAllocatedStart(sessionId, ownerToken)
  -> { state: Stopped | Exited, alreadyTerminal: boolean }
```

## 顺序与并发

- `start` 在任何 backing process/session 副作用前由 host 生成 handle，并可选同步调用 `onAllocated(handle)`；该 hook 只用于 owner adapter 原子持久化 host-generated identity，caller 仍不能指定 session/pane/socket 名。hook 抛错必须在产生副作用前终止 start。
- `start` 成功只表示 backing session 已创建且获得唯一 ownership marker，不表示应用已 ready。如果 start 失败且 host 不能证明 backing child/session 已清理，必须抛出携带已分配 handle 的 `TerminalAmbiguousStart`，并保留该 handle 的 `stop(Force)` 能力；不得降格为 dependency unavailable 或丢弃 identity。
- 同一 `(sessionId, incarnationId)` 的 `write` 与 `resize` 按 host 接收顺序执行。成功返回表示底层 transport 接受，不表示应用消费或 turn 创建。
- `stop` 与其它 mutation 竞争时取得同会话锁；取得锁后的 pending mutation 返回 `TerminalStateConflict`。
- `recover` 只能在新 host incarnation 调用。它必须从底层实时状态和 ownership marker 双重确认身份，不信任单独 registry 记录。
- `reconcileAllocatedStart` 是 cleanup-only seam，只用于 `onAllocated` 已持久化、但 crash 发生在完整 ownership marker 发布前的 lost start。它不得返回 live handle，也不得接管已有完整 marker 的 session；只能通过 launcher 持有的派生 force token + nonce ack 证明 owner 并确认 child PGID/target absent。错误 owner、marker 冲突、probe 不可观测或 cleanup 无法确认全部 fail closed。
- recover 通过带唯一 token 的私有原子 recovery lock 检查 owner PID 与进程启动身份；live owner 存在时拒绝接管，identity 暂时不可观测时也 fail closed，只有确认 PID 已属于不同进程时才回收 stale lease，release 只删除仍属于本次 token 的 lock。成功后生成并写入新的 `incarnationId`，每次 live operation 都复核底层 owner/incarnation marker；旧 handle 的 mutation 全部返回 `StaleIncarnation`。
- `snapshot` 可与 mutation 并发，但必须标注采样时对应的 incarnation；caller 不得假设它包含刚写入的内容。

## 幂等性

- `start` 非幂等；caller retry 前必须查询原请求是否已经产生 handle，不允许按显示名猜测。
- `write` 非幂等，host 不自动重发超时输入；结果不明确时返回 `AmbiguousWrite`。
- `resize` 对相同 dimensions 幂等。
- `stop(Graceful)` 发送 interrupt 后必须等待真实退出；超时返回 `TerminalStateConflict`，caller 仍可调用 `stop(Force)`。Force 将带 nonce 的私有 control request 写入同目录临时文件，经 flush/close 后 atomic rename 发布；仍持有 `ChildProcess` 对象的 launcher 校验完整 request 后终止自己创建的独立 child process group，并回写绑定同一 nonce 的 ack。host 收到匹配 ack 且 tmux target 消失后才返回成功，不得从恢复出的裸 PID 直接发送信号。只有真实退出或 force 成功才进入幂等终态，重复调用返回 `alreadyTerminal=true`。
- `recover` 对当前 host incarnation 幂等；重复调用返回同一 live handle，不生成第二个 viewer。

## 错误分类

| 错误 | 条件 | caller 行为 |
|---|---|---|
| `TerminalConfigInvalid` | argv、cwd、env、尺寸或 key 不合法 | 永不重试，修正配置 |
| `TerminalUnauthorized` | owner token 不匹配或 marker 不可信 | fail closed 并记安全日志 |
| `TerminalNotFound` | backing session 与可信 registry 均不存在 | 可清理本地引用 |
| `TerminalStateConflict` | 当前状态不接受操作 | 不自动重放非幂等操作 |
| `StaleIncarnation` | handle 指向已被 recover/replace 的 incarnation | 重新 inspect 后由 caller 决定 |
| `AmbiguousWrite` | transport 可能接受输入但未能确认 | 不自动重发，向操作者暴露不确定性 |
| `TerminalAmbiguousStart` | backing session/child 可能已创建但 cleanup 未确认；错误携带 host-generated handle | owner 持久化 handle 并在 stop/reconciliation 调用 `stop(Force)`，不自动重试 start |
| `TerminalDependencyUnavailable` | PTY/tmux executable 不存在或 probe 失败 | 禁用 supplemental 能力，主 agent 不降级 |
| `TerminalProtocolDrift` | snapshot/transport 出现未支持模式 | 停止自动操作，保留弱观察 |
| `TerminalInternalFailure` | 其它实现故障 | 停止当前会话，不影响其它 SessionKey |

所有错误消息在进入日志和平台前必须经过既有脱敏；不得包含完整 env、owner token、连接 secret 或未截断终端内容。

## tmux adapter 采用门禁

首个 tmux adapter 必须以真实 tmux 验证：

- daemon host 进程退出后 backing session 仍存活；新 host 能按 ownership marker recover。
- 每个 terminal session 使用独立 tmux server/socket，避免一个 attach descriptor 直接寻址其它 SessionKey target。安全模型仍信任同 UID 的本机进程：它们可以枚举 `/tmp` 并访问该 UID 的全部 socket；owner token 只隔离 host API 的误路由，不是 OS admission。若要对同 UID hostile process 隔离，必须另加不同 UID/sandbox 或 authenticated proxy，当前 adapter 不提供该承诺。
- 相同显示名、伪造 registry、错误 owner token、不同 socket/server 的 session 均不能被接管。
- bracketed paste 不经过 shell quoting；控制字符与普通文本路径分离。
- stop 只杀目标 session；不得清理共享 tmux server 或非本项目 session。
- tmux server global environment 中的平台密钥与 routing 字段不会进入新 pane。

`tmux-manager@0.1.3` 的 README 不构成上述证据；若实际 API 无法满足门禁，adapter 直接调用固定 argv 的 tmux CLI，不扩展本 contract。

## Codex remote viewer 安全门禁

Codex remote viewer 只能连接同一 backend incarnation 的 authenticated loopback WebSocket：

- app-server listener 必须是操作系统分配的 `127.0.0.1` 随机端口；禁止 `0.0.0.0`、非 loopback address 与固定共享端口。
- 每个 incarnation 生成独立的至少 256-bit capability token。token 文件位于 conversation-private home 的 runtime 子目录，mode `0600`；启动失败、stop 与 crash reconciliation 都必须删除。
- controller 与 `codex --remote ... --remote-auth-token-env AGENT_NEXUS_CODEX_REMOTE_TOKEN resume <threadId>` viewer 使用同一 token；token 不得出现在 argv、process title、terminal snapshot、attach descriptor、registry、错误或平台消息。
- viewer handle 绑定 `(homeId, appServerIncarnation, threadId)`。app-server 重启后必须 force-stop 旧 viewer 并以新 token/endpoint 重建；禁止仅按 thread id 或 tmux session 名重连。
- 缺失、错误与上一 incarnation token 的 WebSocket handshake 必须被拒绝。controller 在 listener ready 前不得发送 JSON-RPC，viewer 在 thread commit 前不得启动。
- capability token 在协议层授予完整 app-server client 能力，平台身份 allowlist 不能授权 WebSocket client；但首个 stable adapter 只支持 passive observation，不暴露 `write` 或可写 `attach`。人工输入/接管不属于当前 release contract。
- 已确认无残留的 viewer unavailable/start failure或 viewer 自然退出只禁用 supplemental viewer，不得把 structured backend 降级为 TUI parsing，也不得改变已经接收的 turn 终态。foreign input 属安全/ownership violation并按下文结束 session；无法确认退出属 stop cleanup failure并使 barrier reject，二者都不能改写已经确定的 turn terminal。
- viewer adapter 的启动参数固定为 `codex --remote <loopback-endpoint> --remote-auth-token-env AGENT_NEXUS_CODEX_REMOTE_TOKEN resume <threadId>`；generic `TerminalSessionStart` 不接受任意 remote argv 或 token env。adapter 的 launcher path、token-file path 与 metadata 必须位于同一 private runtime dir，并在读取前校验 owner、regular-file、non-symlink 与 mode。
- viewer 只在 thread commit/resume audit 与 live lease 成功后启动。正常 stop、app-server crash 与 next-start reconciliation 都先按完整三元组 force-stop viewer，再删除本 incarnation token/runtime dir；`TerminalNotFound` 只在 tmux target 已确认不存在，且 durable child identity 也证明没有 live/unverifiable process group 时视为幂等成功。viewer 自然退出或已确认无残留的 start failure只记录 warning，不影响 structured runtime；无法确认 viewer 退出时仍必须删除 token 文件并继续 structured host cleanup，但保留不含 capability token 的 private recovery metadata/launcher 供 next-start 重试，整个 `stopSession()` barrier reject，且不得发 `session_stopped(user_stop)` 假报完整 cleanup。
- passive viewer 出现 foreign `turn/started` 表示发生不受支持的人工输入；controller 不采纳该 turn、不绑定平台 trace、不提升其 item/terminal，必须撤销当前 viewer incarnation并结束 app-server session。interactive takeover 只有在独立 spec 定义 foreign-turn admission、Busy 串行化、平台输入行为与审计 trace 后才能启用。

terminal host 的 owner token 与 Codex capability token 是不同安全边界，禁止复用或相互派生。WebSocket Origin 不能替代 bearer admission；首版不提供浏览器 client，因此不接受浏览器 cookie 或 query-string token。

## Attribution

本 contract 根据项目需求独立编写，并参考 botmux pinned hybrid 的行为边界及 `pty-manager@1.12.1`、`tmux-manager@0.1.3` 的公开接口说明。若实现复制 substantial upstream source，必须在源文件与发行物保留相应 MIT notice 和 commit；仅依赖 npm package 时进入第三方许可证清单。
