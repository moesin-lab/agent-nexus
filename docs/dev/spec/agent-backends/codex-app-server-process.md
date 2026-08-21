---
title: Spec：Codex App Server Process Session
type: spec
status: active
summary: Codex app-server 长运行进程的稳定 start、status、output、stdin、terminate、隔离与跨 turn 生命周期契约
tags: [spec, agent-runtime, codex, app-server, json-rpc]
related:
  - dev/adr/0022-codex-app-server-primary-tui-supplemental
  - dev/spec/agent-backends/codex-app-server
  - dev/spec/agent-runtime
  - dev/spec/security/tool-boundary
  - dev/architecture/session-model
contracts:
  - CodexAppServerProcessRuntime
  - CodexProcessController
  - CodexProcessHandle
---

# Spec：Codex App Server Process Session

本文定义 `codex-app-server` backend 在同一 live app-server connection 内持有长运行进程的契约。conversation thread 是可持久化的模型上下文；process handle 是 connection-private live capability。二者必须分离建模。

底层只使用 Codex CLI `0.146.0` stable schema 中的 `command/exec`、`command/exec/write`、`command/exec/terminate` 与 `command/exec/outputDelta`。不启用 experimental `process/*`、background terminal 或 dynamic tool surface。

## 接口

`CodexAppServerRuntime` 在通用 `AgentRuntime` 之外提供 backend-private process seam；本轮不改变通用 `AgentRuntime`，也不定义平台 slash command 或自然语言 dynamic tool 映射。

```text
CodexAppServerProcessRuntime {
  startProcess(session, input) -> ProcessStatus
  processStatus(session, handle) -> ProcessStatus
  readProcessOutput(session, input) -> ProcessOutputPage
  writeProcessStdin(session, input) -> ProcessWriteResult
  terminateProcess(session, handle) -> ProcessTerminateResult
}

ProcessStartInput {
  argv: string[]
}

ProcessStatus {
  handle: opaque string
  state: "starting" | "running" | "terminating" | "exited" | "failed" | "lost"
  nextCursor: uint
  oldestCursor: uint
  stdinOpen: boolean
  exitCode?: int32
  failureCode?: string
}

ProcessOutputReadInput {
  handle: opaque string
  cursor: uint
}

ProcessOutputChunk {
  stream: "stdout" | "stderr"
  startCursor: uint
  endCursor: uint
  dataBase64: string
}

ProcessOutputPage {
  status: ProcessStatus
  requestedCursor: uint
  oldestCursor: uint
  nextCursor: uint
  truncatedBefore: boolean
  chunks: ProcessOutputChunk[]
}

ProcessStdinInput {
  handle: opaque string
  dataBase64?: string
  closeStdin?: boolean
}
```

所有方法先验证 runtime-private `AgentSession` object identity。cloned/foreign session 与未知/foreign handle 统一返回 `process_not_found`，不得泄露某 handle 是否属于另一 SessionKey。

## 上游映射

### start

每次 start 生成两个互不相等的随机值：返回 caller 的 opaque handle，以及只发给当前 app-server connection 的 upstream `processId`。两者不得包含 PID、thread id、SessionKey、request id 或可枚举序号。

`command/exec` 固定发送：

| 字段 | 值 |
|---|---|
| `command` | 已验证的非空 argv vector |
| `processId` | connection-private random id |
| `cwd` | canonical `SessionConfig.workingDir` |
| `streamStdin` | `true` |
| `streamStdoutStderr` | `true` |
| `disableTimeout` | `true` |
| `disableOutputCap` | `true`；资源上限由本地 owner 强制 |
| `sandboxPolicy` | 从 backend `sandbox` 与 `addDirs` 唯一派生 |

caller 不得覆盖 cwd、env、timeout、output cap、sandbox、permission profile、TTY 或 PTY size。命令使用 argv，不经过 shell。

`command/exec` final response 延迟到进程退出，因此该 request 不使用普通 `requestTimeoutMs`；transport close 仍必须立即 reject。其它 control request 继续使用普通 deadline。

app-server 没有独立 started response。client 写入 `command/exec` 后必须紧接：

```text
command/exec/write {
  processId,
  deltaBase64: ""
}
```

精确 `0.146.0` probe 已证明：完全省略 `deltaBase64` 与 `closeStdin` 会返回 `-32602`，显式零字节 `deltaBase64` 会返回 `{}`，可作为 process 已在该 connection 注册的无副作用 admission barrier。只有 barrier 成功后状态才是 `running`。quick exit 先于 barrier 时直接进入真实终态，不伪造 running。

### status

上游没有 status RPC。status 是当前 process owner 根据 admission barrier、control CAS 与 `command/exec` final response 合成的本地强状态。

状态只能单调迁移：

```text
starting -> running -> terminating -> exited
    |          |             |
    +----------+-------------+-> failed
                               -> lost
```

- `exited`：收到并验证 final response，包含真实 `exitCode`。
- `failed`：start/control/protocol 失败，但 owner 仍能证明 host 生命周期已收敛。
- `lost`：connection/host 消失，无法从 upstream 恢复该 handle；host cleanup barrier 仍必须确认 process group 不存在。

turn 完成、中断或开始下一 turn 不改变 process state，也不把 thread controller 保持在 Busy。

### output

`command/exec/outputDelta` 按 connection 与 internal `processId` 路由。未知 `processId`、非法 base64、非法 stream、重复 cap terminal 或 terminal 后 delta 是 ownership/protocol error，结束整个 session。

每个 process 使用按原始 byte 计数的有界 ring：

- stdout/stderr 按 notification 到达顺序共享单调 cursor；
- ring 上限固定 `1 MiB`；淘汰最老 bytes 后推进 `oldestCursor`；
- 单次 read 最多返回 `64 KiB`；
- cursor 落在已淘汰区时返回 `truncatedBefore=true`，不得静默假装完整；
- 存储与接口只处理 bytes/base64，不跨 chunk 猜测 UTF-8；
- 单个 process lifetime ingress 上限固定 `64 MiB`，到达后请求 terminate；无法确认 terminal 时升级 host cleanup。

上游以 `disableOutputCap=true` 保证 owner 能持续看到新输出；本地 ring、read cap 与 lifetime ingress cap 是唯一资源边界。final response 必须在全部 output delta 之后到达；streaming 模式的 final `stdout/stderr` 必须为空。

### stdin

`writeProcessStdin` 严格验证 base64。单次 decoded data 上限 `64 KiB`，单 handle pending stdin 上限 `256 KiB`。

每个 handle 有独立 write tail：先占 pending byte quota，再调用 `command/exec/write`，settle 后释放。`closeStdin=true` 入队时立即关闭 admission；后续非空 write 拒绝。重复 close 是幂等成功。

write response 只证明 app-server 接受了 bytes，不证明目标程序已消费。`terminating/exited/failed/lost` 均拒绝新 write。

### terminate

第一次 terminate CAS 到 `terminating` 并发送一次 `command/exec/terminate`；并发或重复调用共享同一个 Promise。已终态返回 `alreadyTerminal=true`。

terminate `{}` 只表示 control 已接受。方法必须继续等待原 `command/exec` final response；`terminateGraceMs` 内没有 terminal 时触发整个 app-server host cleanup。只有 host process group absent 得到确认后，cleanup 才算完成。

自然退出与 terminate 竞争时以 final response 为事实，不根据请求先后虚构特定 exit code。

## 数量与保留

- 每个 live session 最多 `4` 个非终态 process；超过返回 `process_limit_reached`。
- 每个 session 最多保留 `16` 个 terminal record；超过后按 terminal 时间淘汰最老记录。
- terminal record 保留 ring 中剩余 output，直到被淘汰或 session stop。
- handle 从不复用；淘汰后统一表现为 `process_not_found`。

这些上限是 `0.146.0` contract 常量，不接受 operator 或 model 覆盖。修改上限必须同时更新本 spec、资源边界测试与 packed/real gate。

## 隔离

- 每个 `AgentSession` 使用独立 process controller、app-server connection、request id 空间、process map 与 conversation-private `CODEX_HOME`。
- authorization root 是 runtime-private session identity；thread id 只描述 conversation lineage，不能授权 process 操作。
- output notification 只有 connection-scoped process id，必须在接收它的 controller 内解析；不得在全局 map 跨 connection 查找。
- 即使两个 SessionKey 内部生成相同 upstream process id，仍不能互查、互写或互杀。
- caller 不能传 env。tool child 只继承 app-server 受控环境；daemon、平台、数据库 credential 不得进入 child。
- sandbox 唯一映射：`read-only -> readOnly(networkAccess=false)`；`workspace-write -> workspaceWrite(writableRoots=[workingDir,...addDirs], networkAccess=false)`；`danger-full-access -> dangerFullAccess`。

`danger-full-access` 仍等价于让远程操作者在本机执行任意命令；process API 不提供额外文件隔离。PGID cleanup 防止普通 descendant orphan，不承诺阻止恶意 child 主动 `setsid` 逃逸；后者需要 cgroup、job object 或独立 UID sandbox。

## turn、stop 与 restart

- process 生命周期属于 live app-server connection，不属于单个 turn。
- completed/interrupted/failed turn 不清理独立 process；下一 turn 可以继续 status/output/stdin/terminate。
- `stopSession`、`/new`、routing binding switch、normal daemon shutdown：关闭新 process admission，best-effort 并行 terminate 全部 live process，再结束 viewer 与 app-server PGID；PGID absent 是最终 barrier。
- app-server crash、pipe EOF 或 protocol fatal：全部非终态 record 进入 `lost`，随后走同一 host cleanup。
- daemon hard crash：supervisor 从 control pipe EOF 结束整个 PGID；旧 handle 不持久化。
- daemon restart 后可按 conversation registry 恢复 idle thread，但 process map 必为空；旧 handle 返回 `process_not_found`。

`ConversationRegistry` 不保存 process handle、output、stdin state 或 OS PID。conversation resume 与 process resume 不得使用同一个字段或成功条件。

## 并发与错误

| 场景 | 结果 |
|---|---|
| 同 handle 并发 stdin | 按调用顺序串行 |
| stdin 与 terminate 竞争 | terminate CAS 后拒绝尚未 admission 的 write；已 dispatch write 可先完成 |
| natural exit 与 terminate 竞争 | final response 唯一定义 exit terminal |
| output 与 final response 竞争 | 先收全部 output，再发布 terminal |
| unknown/foreign handle | `process_not_found`，不泄露归属 |
| unknown process notification | session-fatal ownership error |
| control RPC timeout | 对该 operation 失败；无法证明 cleanup 时升级 host stop |
| long exec pending 遇 transport close | request reject，record `lost`，host cleanup barrier 收敛 |

所有公开错误只返回稳定 code，不包含 argv、stdin、output、完整 RPC frame、auth 或绝对 home path。

## Compatibility 与验证

startup gate 继续要求 exact `codex-cli 0.146.0` 与 stable schema hash。第一次 process start 的零字节 write barrier是 in-band capability probe；失败时不创建可用 handle，session fail closed。

最低证据：

1. schema contract 固定三个 request、一个 notification、params/response 与 `experimentalApi=false`。
2. transport 覆盖 no-deadline pending、close rejection，以及普通 request 的 timeout/late fatal 不回归。
3. process controller 覆盖 start barrier、quick exit、cursor/ring/gap、binary output、stdin quota/close、terminate race、output cap 与 unknown notification。
4. runtime 覆盖 cloned session、不同 SessionKey、turn 前后同 handle、stop 与 fatal cleanup。
5. exact `0.146.0` real E2E 覆盖 start、completed turn、turn 后新增 output、stdin 回显、terminate、真实 PID absent。
6. hard-crash E2E 覆盖 daemon SIGKILL 后 app-server PGID 与 process PID absent；新 child 可 resume thread，但不能恢复旧 handle。
7. packed CLI gate 从安装产物重复完整主路径；源码测试不能替代。
8. Node 22/24、macOS arm64/x64 与 Linux x64；未覆盖平台 fail closed。

## 反模式

- 用 thread id、turn id、PID 或 upstream process id 作为公开 handle。
- 把 `command/exec` frame 写入 pipe 当成 start 成功。
- 给 deferred final response套普通 30 秒 RPC timeout。
- 只转发 live output，不保留 cursor ring，却宣称可跨 turn read。
- 把 terminate `{}` 当成 process 已退出。
- 把 conversation `thread/resume` 宣称为 process recovery。
- 开启 unsandboxed experimental `process/spawn` 或把任意 app-server method 暴露为 passthrough。
- 只验证 normal exit，不验证 SessionKey 隔离、host crash、daemon hard crash与 no-orphan barrier。
