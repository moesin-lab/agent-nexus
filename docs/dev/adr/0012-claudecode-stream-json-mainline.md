---
title: ADR-0012 claudecode 切到 stream-json 主路径——协议合约 / interrupt / timeout / 工具隔离强制点
type: adr
status: active
summary: claudecode runtime 切 stream-json 持续子进程；锁定 protocol union 一次性对齐（含独立 tool_result）、interrupt 暂保持 SIGINT + 投递契约两层状态机、平台能力门槛 + PR-C 最小集成契约、legacy fallback 保留、工具隔离强制点（CLI flag 非边界 / 进程内执行前拦截 + OS 纵深）六项架构决策
tags: [adr, decision, agent-runtime, claude-code, subprocess, message-protocol, tool-boundary, security]
related:
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/adr/0011-turn-layering
  - dev/spec/agent-runtime
  - dev/spec/agent-backends/claude-code-cli
  - dev/spec/message-protocol
  - dev/spec/platform-adapter
  - dev/spec/security/tool-boundary
adr_status: Accepted
adr_number: "0012"
decision_date: 2026-04-28
supersedes: null
superseded_by: null
---

# ADR-0012：claudecode 切到 stream-json 主路径——协议合约 / interrupt / timeout / 工具隔离强制点

- **状态**：Accepted
- **日期**：2026-05-23
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0002（CC CLI 作为 agent 后端）、ADR-0011（turn 分层）

## 状态变更日志

- 2026-04-28：Proposed
- 2026-05-21：第四 / 五 / 六轮 GAN review 修订（详见 §异议 & 回应）
- 2026-05-22：补决策点 5（工具隔离强制点）——stream-json 主路径实测暴露 `--allowed-tools` / `--permission-mode` 不强制工具边界，纳入本 ADR（详见 §异议 & 回应 第七轮）
- 2026-05-22：§interrupt 投递契约 §进程 cleanup 层 措辞收紧（非反转）——kill 路径从 POSIX `kill(-pid)` process group 抽象为平台等价子进程树终止语义，限定仅约束主动 kill 路径不反转 graceful interrupt 不变量（cline tree-kill 跨平台实现对照触发，详见 §异议 & 回应 第八轮）
- 2026-05-23：工具隔离前置验证补充非 bypass 复测——早期 `permissionMode:"bypassPermissions"` 读数确认为本机 user settings 污染，不作为 `default` 固有语义依据；决策点 5.1 仍由 `--allowed-tools` 不强制与 observer 无法事后拦截支撑（详见 §异议 & 回应 第九轮）
- 2026-05-23：复查 cc-connect 后补测隐藏 `--permission-prompt-tool stdio`——`can_use_tool` control 主路径坐实，决策点 5 主强制点从 PreToolUse hook 修正为 stdio permission control（hook 保留为 fallback / 纵深）
- 2026-05-23：修正 spec/ADR 启动形态——agent-nexus 主路径为**不带 `--print`、由 stdout/stdin pipe 触发 headless 的长驻 stream-json structured IO 子进程**；`--print` 只保留为一次性 probe / legacy fallback
- 2026-05-23：对齐 `/workspace/claudecode-src` 入口扫描——stdin 输入形态以 `user` / `control_response` / 少量 `control_request` 为 MVP，stdout 权限请求为 `control_request{subtype:"can_use_tool"}`，没有独立 `permission_request` SDK 事件
- 2026-05-23：Accepted（epic 全部 PR 合入并 P8 验证通过后，maintainer 复核签字，见本 PR）

## Context

`docs/dev/spec/agent-backends/claude-code-cli.md` §Headless structured session 现在把**不带 `--print`、由 stdout/stdin pipe 触发 headless 的长驻 stream-json structured IO 子进程**标为 MVP 主路径：同一 Claude Code 进程通过 stdin 接收多 turn JSON，通过 stdout 持续输出 stream-json 事件。实现侧当前仍是 `--print` 单次调用——每次 `sendInput` spawn → 跑完 → 退出。这个 spec/impl gap 是 #45（IM 看不到工具调用）/ #28（partial output 丢失）/ #54（interrupt 只能整子进程）/ #30 / #55-B（Discord 长回复无流式 edit）的共同上游。把它们当独立 issue 修，大概率在 stream-json 切换时被全部重写。

本 ADR 立 epic 协议层 + 实现层共识，**只锁不可逆的架构决策**——协议契约、interrupt 主路径、流式 timeout 分层、平台能力门槛、interrupt 投递契约、legacy fallback 保留、工具隔离强制点。具体 UX / UI 文案、协议字段表、阈值数值、平台实现细节由 spec 修订 + 后续 issue 演进。

观察到的关键事实：

1. spec 已锁完整 AgentEvent union（含 `text_delta` / `thinking` / `tool_call_*` / `tool_result` 概念位）+ 顺序保证
2. spec 已锁 interrupt 主路径（SIGINT 主，stdin control 备）
3. message-protocol §流式语义 模式 B 留 ADR 位
4. Discord adapter 当前 capability 全为 false
5. **外部对照实证**：
   - `chenhg5/cc-connect`（Go IM-bridge，长驻 stream-json 子进程）实证 process group kill 必要（不 kill group → MCP 孙进程 100% CPU 孤儿）+ Discord edit + 周期 typing 节奏 viable
   - `banteg/takopi`（Python Telegram bridge）实证 CC `tool_result.content` 在生产环境至少存在 5 种变体（str / list / dict / None / 其他 + `is_error`）；并以 `-p --resume` 一次性模式作为持续子进程的对照存在
   - 两个项目均未实现三层 watchdog 仍能运行
6. **工具隔离实测修正**（2026-05-22 CC 2.1.148；2026-05-23 CC 2.1.149 复测修正）：`--allowed-tools` 白名单 / `Bash(git *)` 子模式 / `--permission-mode default` 均**不能单独作为工具安全边界**——白名单只给 `Read` 时，模型用未列入的 `Bash` 仍可能执行成功，`permission_denials` 为空。早期 `init` 实报 `permissionMode:"bypassPermissions"` 后续确认为本机 user settings `defaultMode:"bypassPermissions"` 污染样本；隔离新目录 project settings 显式 `defaultMode:"default"` 时，`init.permissionMode` 实报 `default`，但 `--allowed-tools Read` / project `allow:["Read"]` 仍不阻止无副作用 Bash 命令。`security/tool-boundary.md` §白名单外拒绝 合约（"CC 调未在白名单的工具 → 不转发工具调用请求"）的 observer 实现前提因此被证伪：stream-json 架构下 agent-nexus 看到 `tool_use` 时工具已执行完，无法事后拦截。复查 `chenhg5/cc-connect` 后发现它启动 Claude Code 时传隐藏 `--permission-prompt-tool stdio`；补测同版本确认：加该 flag 后，`--print stream-json` 与**不带 `--print`、stdout/stdin pipe 触发 headless 的长驻 stream-json** 两种形态均在 Bash/Edit 写文件前产出 `control_request{subtype:"can_use_tool"}`。agent-nexus 回 `control_response deny` 后副作用未发生且 result 汇总 `permission_denials`；回 `allow + updatedInput` 后副作用发生。另测 local `--sdk-url` 直接拒绝非 Anthropic approved endpoint，不能作为 agent-nexus 本地 transport。源码复核确认 `PermissionRequest` 是本机 hook，不是 stdout SDK 的 `permission_request` 事件；PreToolUse hook 仍已验证可执行前 deny，但定位从主强制点修正为 fallback / defense-in-depth。

## Options

五个真架构决策点。具体阈值 / payload 字段表 / 平台细节由 spec 修订；本 ADR 不展开。

### 决策点 1：AgentEvent union 形态

- **Option 1A**：protocol 一次性对齐 spec 完整 union（含 `tool_result`）；runtime 选择性 emit
- **Option 1B**：按 MVP 分批暴露 union

### 决策点 1 子问题：CC `user.tool_result` 怎么落 protocol

- **Option 1-tr-A**：合入 `tool_call_finished.payload.resultSummary`
  - ⚠️ 已知反证：takopi/claude.py 实证 5 种 content 变体，1-tr-A "CC 单条假设" 已被外部证伪
- **Option 1-tr-B**：新增独立 `tool_result` 事件，多变体由 protocol 显式承载

### 决策点 2：interrupt 主路径

- **Option 2A**：保持 SIGINT 主路径；stdin `control_request/interrupt` 作为 capability flag 控制的备路径；反转走独立 ADR
- **Option 2B**：直接反转为 stdin control 主路径

### 决策点 3：Discord 平台能力门槛

- **Option 3A**：本 ADR 锁平台**能力门槛 + 最小集成契约**；具体 UI 策略 / 阈值下沉 spec + issue
- **Option 3B**：本 ADR 同时锁定具体 UI 策略（已被第三轮 argue 否决）

### 决策点 4：流式 timeout 分层

- **Option 4A**：三层 watchdog（firstEvent / streamIdle / perTurnWallclock）+ 三类不同恢复策略；不杀子进程
- **Option 4B**：保持单一 wallclock；失败模式由观测层区分
- **Option 4C**：idle-only

### 决策点 5：工具隔离强制点

单靠 `--allowed-tools` / `--permission-mode` 实测不强制 agent-nexus 工具边界（关键事实 6），tool-boundary §白名单外拒绝 合约的 observer 实现前提被证伪、看到 `tool_use` 后无法事后拦截。工具隔离的真正强制点何在：

- **Option 5A**：只靠 OS 级隔离（容器 / 沙箱 / 只读挂载），CLI flag 纯配置意图——硬边界但粒度粗（按进程能力非工具语义），与 ADR-0003 local-desktop 部署张力大
- **Option 5B**：只靠 PreToolUse hook（实测可执行前 deny）——工具级粒度、不需容器，但单层无纵深、hook 配置被篡改即失效
- **Option 5C**：只靠 stream-json control protocol `can_use_tool`（协议原生执行前权限请求，最契合 §白名单外拒绝 语义）——2.1.149 补测已坐实触发条件为隐藏 `--permission-prompt-tool stdio`，但该 flag 需 compatibility probe 防版本漂移
- **Option 5D**：进程内执行前强制点（control 或 hook，坐实其一）+ OS 级 defense-in-depth 纵深——不把赌注押在任一未坐实机制上，代价是三层实现复杂度

## Decision

五个决策点综合选：

- **决策点 1**：选 **Option 1A**——protocol 一次性对齐 spec 完整 union（含独立 `tool_result` 事件位）；runtime 本期 PR 实际 emit `text_delta` / `tool_call_started` / `tool_call_finished` / `tool_result` 四类
- **决策点 1 子问题**：选 **Option 1-tr-B**——基于 takopi 外部实证（CC tool_result 存在 5 种变体）反转 1-tr-A。**协议契约要求**：
  - `tool_result` event 必须能**结构化承载** CC 输出的多类 content 形态（至少 string / list-of-blocks / object / empty / unknown 五类），不允许统一压扁为 single string；同一 toolUseId 多条 result 需有 sequence 区分
  - `tool_call_finished` event 必须携带 terminal status / error summary，覆盖 0 条 result 的错误终态（CC 在某些场景下可能取消 / 超时未回 result 直接 finished）。该字段独立于 `tool_result.isError`——前者是 tool 块终态，后者是单条 result 错误
  - 具体 payload 字段表 + 字段类型 + unknown 兜底机制（如原始 JSON 截断 + 脱敏）→ `docs/dev/spec/agent-runtime.md` 修订
- **决策点 2**：选 **Option 2A**——暂保持 SIGINT；runtime 双轨设施位 + capability flag `supportsStdinInterrupt`；反转走独立 ADR（前提：证据收集合并门槛见 §需要后续跟进）
- **决策点 3**：选 **Option 3A**——Discord adapter `supportsEdit: true` + `supportsTypingIndicator: true` + 实现 `edit()` / `setTyping()` / `clearTyping()`；具体 UI 策略下放后续 issue；本 ADR 同时锁定 **PR-C 最小集成契约**（见下）
- **决策点 4**：选 **Option 4A**——三层 watchdog；timeoutLayer 区分语义**必须进 protocol**（payload 字段或 TurnEndReason 枚举，二选一，不允许 daemon 内部状态）；阈值与具体实现机制选哪个 → spec/cost-and-limits.md + PR-A
- **决策点 5**：选 **Option 5D**——锁三条工具隔离不变量：
  - (5.1) 在本 ADR 目标运行形态（不带 `--print`、由 stdout/stdin pipe 触发 headless 的长驻 stream-json 子进程）下，**不得**把 `--allowed-tools` / `--permission-mode` 当作安全边界——实测单靠这些 flag 不强制 agent-nexus 工具隔离（关键事实 6）；即便未来 CC 版本修复这些 flag 的行为，也只能作为附加约束，不能替代 5.2 / 5.3
  - (5.2) 工具隔离**必须有一个已验证 fail-closed 的 CC 进程内执行前强制点**：主路径选 stream-json control protocol `can_use_tool`，agent-nexus 启动 CC 时传 `--permission-prompt-tool stdio`，作为 control 对端据 `toolWhitelist` allow/deny；启动 probe 必须验证 deny 副作用未发生、allow 可放行、缺失 / 加载失败 / 规则解析失败一律 **fail closed**（禁止启动或禁用全部工具）。**PreToolUse hook** 保留为 fallback / defense-in-depth：control probe 不通过但仍要提供工具隔离时，才可切 hook 主强制点；hook 配置也必须位于被隔离对象（模型）**不可写的边界外**。control probe 与 hook probe 均不通过时，**禁止落地**该工具隔离实现，不允许对外宣称满足工具隔离承诺
  - (5.3) **必须叠加 OS 级 defense-in-depth**，最低语义：限制工作目录写入范围 + 敏感路径不可读 + 网络能力有明确策略（容器 / 沙箱 / 只读挂载 / 网络隔离等任一可行手段达成）；若目标平台无法提供任何 OS 级限制，**必须显式声明"不满足工具隔离强安全承诺"**、不得宣称满足 5.3——因为进程内强制点随 CC 被攻破或配置被篡改而失效
  - 该强制点**保留** tool-boundary §白名单外拒绝 的安全语义，**废弃**其"agent-nexus 事后不转发"的（observer 架构下无法落地的）实现路径，改由 stdio permission control 执行前强制点实现；hook 仅作 fallback / defense-in-depth。5.1 / 5.2 / 5.3 都成立

### PR-C 最小集成契约（决策点 3 配套）

daemon engine 检测平台 capability 后必须实现最小调用路径，不允许 capability=true 但无人调用：

- `supportsEdit=true` → 缓冲 `text_delta` + 按节流窗口调 `edit()` 更新当前回复 + `turn_finished` 触发 final edit
- `supportsTypingIndicator=true` → turn 开始 `setTyping()` + 周期刷新（需兼容 Discord typing 自动失效阈值） + turn 结束/interrupt/错误 `clearTyping()`
- 检测 `tool_call_*` / `tool_result` 事件 → 必须至少调用一次 platform send/edit 让用户看到工具发生了（最小可见性）

具体节流毫秒数 / 刷新周期 → spec/cost-and-limits.md（不在本 ADR）。

### interrupt 投递契约（决策点 2 + 决策点 4 的兼容层）

无论 interrupt 触发源（用户主动 / 三层 timeout 任一），无论第一步发送语义（SIGINT 或 stdin control，由决策点 2 capability flag 决定），兜底链拆为**两层独立状态机**：

**第 1 层：事件投递层（synthetic turn_finished）**

- interrupt / timeout 命中后，runtime 在很短确认窗口内（毫秒级，具体值 → spec）向 daemon 投递 synthetic `turn_finished{reason, source: "runtime-synthesized"}`；不等待 CC 子进程产出
- `source: "runtime-synthesized"` 标记**仅限于** runtime synthesized terminal turn_finished 投递给 daemon；不复用于其它 runtime 生成事件
- **入口屏障两层分离**（避免 daemon 接受 sendInput 与 runtime 实际写 CC stdin 混淆）：
  - daemon 入口：在 synthetic turn_finished **投递之前**阻塞同 session 的下一 sendInput；投递完成即解锁（可接受 / 排队下一请求）
  - runtime 投递屏障：daemon 解锁后调用 `sendInput`，runtime 实际写入同一常驻 CC stdin 之前，**必须**等 stdin sync ack / CC turn boundary / process exit + replacement subprocess ready 任一成立；否则在 runtime 层排队（建议有界队列），队列满或 cleanup 进入 hard-kill 阶段 → session Errored
- **late event 处理规则**：synthetic 投递之后 CC 子进程仍可能产出该 turn 的 late events（text_delta / tool_call_* / tool_result / CC 自己的 turn_finished）；runtime 必须**丢弃并 debug log**，**不**转发 daemon——避免污染 daemon 状态

**第 2 层：进程 cleanup 层（子进程树 lifecycle）**

第 1 层投递后并行启动 cleanup state machine：

1. **子进程树终止语义**（平台等价，实现细节归 spec/PR-B）：runtime **主动进入 kill 路径**（cleanup 升级到 soft-kill / hard-kill 阶段）时，终止必须覆盖**整个 CC 子进程树**——CC 主进程 + 由其启动、本应随之清理的 MCP 子孙进程；只杀主进程不覆盖子进程树会留孤儿（cc-connect 实证 MCP 孙进程残留 100% CPU）。**此语义仅约束主动 kill 路径**：正常 graceful interrupt 成功路径不要求杀 CC 主进程或其仍应存活的子进程（见 (2.1) 升级判据），自然 process exit 亦不受本条约束。平台终止域的具体机制（POSIX process group / Windows process-tree / job object / tree-kill 封装）与其覆盖边界差异 → spec
2. **三段升级**（阈值与时长 → spec）：
   - **(2.1) 升级判据**：在 `gracefulInterruptMs` 内 runtime 既未观察到 **(i)** turn cleanup ack（stdin 回到 sync 状态 / CC 主动产生 turn 边界事件 / 收到 CC 自己的 turn_finished）也未观察到 **(ii)** process exit，才升级。**不**以 process exit 单一为判据——常驻子进程的正常 interrupt 成功路径就是"turn 中止 + 进程存活 + stdin sync"
   - **(2.2)** 升级到 soft-kill 阶段（POSIX 映射 SIGTERM）→ 等 `sigtermGraceMs`
   - **(2.3)** 仍未达成 (i)/(ii) 任一 → hard-kill 阶段（POSIX 映射 SIGKILL）
3. **session 终态**：cleanup 进入 hard-kill 阶段 → session Errored；正常达成 turn cleanup ack 或 process exit 自然路径 → session 维持 active（多 turn 续话能力保留）

**两层互不阻塞**：第 1 层立即完成 → daemon UI 即时反馈；第 2 层后台跑 → 子进程清理与下一 turn 解耦。

## Consequences

### 正向

- protocol 一次性对齐 spec（含独立 `tool_result`），下游 exhaustive switch 一次配齐，未来增 emit 不触发 breaking
- runtime 切持续子进程，IM 可见工具调用（消解 #45）；token 级 emit 让 partial output 不丢（消解 #28）
- interrupt 投递契约**两层分离**：事件投递立即完成 → daemon/UI 即时反馈；进程 cleanup 并行不阻塞下一 turn；cleanup 升级判据建模 turn-level ack 而非 process-exit，常驻子进程的正常 interrupt 成功路径不会被误判
- 三层 watchdog + 投递契约两层结构区分"队列拥堵 / 流中卡死 / runaway"恢复策略；session 级子进程仅在 hard-kill 阶段或 session idle 被杀
- Discord 平台能力门槛 + PR-C 最小集成契约锁定，#45 / #30 在 PR-A+B+C+D 合入后落地，不依赖 UX issue 收敛节奏
- `tool_result` 独立事件 + 协议层保证承载五类 content 变体能力（具体字段 → spec），CC 多形态输出场景下不丢信息；`tool_call_finished` 必须携带 terminal status 覆盖 0-result error case
- spec §顺序保证锁模型 A（`tool_result*` 在 `tool_call_finished` 前 → finished 即结果流终态）
- legacy `--print --resume` fallback 保留代码路径，在持续子进程在 Windows / sandbox / 容器死锁等场景失败时有 escape hatch
- 工具隔离落到**真正能在执行前拦截**的机制（stdio control + OS 纵深，hook fallback），不再依赖实测已失效的 CLI flag；tool-boundary §白名单外拒绝 的安全语义获得可落地实现路径，不再悬空；control protocol 正是 stream-json 双向通道的一部分，与本 ADR 主路径同源

### 负向

- protocol 上会有"暂无 runtime 来源"的事件类型（`thinking` / `tool_call_progress`），需要 spec 标"声明位 vs 实际产出"
- interrupt 决策留尾巴——需要后续证据收集与可能的反转 ADR
- 三层 timeout + 两段 cleanup = 5 个相关阈值，运维负担明显，阈值耦合关系由 spec 写清
- 已知 cc-connect / takopi 都没做三层 watchdog 仍能运行——若 PR-B 落地数据显示三类失败模式实际可合并，spec 调整不需要新 ADR
- runtime `_normalize_tool_result` 五变体处理 + `tool_result` payload 五类承载 + late event 丢弃 + cleanup 升级判据多源判定，runtime 实现复杂度上升
- legacy fallback 保留意味着维护两套 spawn 代码路径至证据收集复审完成
- 工具隔离强制点依赖隐藏 `--permission-prompt-tool stdio`，help 不展示，版本漂移风险必须由 CompatibilityProbe 承担；PreToolUse hook fallback 增加实现分支；OS 级 defense-in-depth 与 ADR-0003（local-desktop 部署）有张力——用户本机隔离手段受限，可能只能要求"信任工作目录 + 只读挂载"等弱化形态

### 需要后续跟进的事

- **PR-A（协议层）**：union 补齐到 spec 全集（含 `tool_result`）；扩 `AgentCapabilitySet.supportsStdinInterrupt`；选定 timeoutLayer 实现机制（payload 字段 或 TurnEndReason 枚举，不允许 daemon 内部状态）；`tool_call_finished` 加 terminal status 字段。具体类型 / 字段 / 测试细节 → PR 描述 + spec
- **PR-B（claudecode runtime）**：切持续子进程；子进程树终止（平台等价终止域）；stream-json stdin/stdout；emit 四类事件；`_normalize_tool_result` 覆盖五变体；实现 §interrupt 投递契约 两层状态机（事件投递层立即合成 + late event 丢弃 + cleanup 多源升级判据）；interrupt SIGINT + stdin control 双轨；保留 `--print --resume` legacy 代码路径
- **PR-C（daemon engine）**：按 §PR-C 最小集成契约 实现节流 edit + typing 周期刷新 + 工具事件最小可见性路由；处理 synthetic turn_finished `source` 字段；synthetic 投递前阻塞下一 sendInput，投递后解锁
- **PR-D（Discord adapter）**：翻 capability + 实现 primitive；具体 UI 策略按 UX issue 演进
- **spec 修订**（详见各 spec 文件 SSOT）：
  - agent-runtime.md：union 加 `tool_result` 事件 + payload schema 字段表 + `tool_call_finished` terminal status 字段 + §顺序保证补"每 toolUseId 0+条 tool_result，必须在 tool_call_finished 前"
  - agent-backends/claude-code-cli.md：§中断 / §超时 改写为本 ADR §interrupt 投递契约两层结构 + capability flag；子进程树终止平台细节与覆盖边界
  - message-protocol.md：§流式语义 模式 B 标记本 ADR 评审通过
  - platform-adapter.md：加 `setTyping` / `clearTyping` + `supportsTypingIndicator` capability
  - cost-and-limits.md：三层 watchdog + cleanup 两段阈值 + 投递层确认窗口 + 节流 edit / typing 周期等数值 + 阈值耦合关系
  - security/redaction.md：与 `tool_result` unknown 兜底字段的脱敏联动
  - security/tool-boundary.md：§白名单外拒绝 合约 + §核心威胁关联 按决策点 5 重写（强制点从 CLI flag 改为 stdio permission control 主强制点 + hook fallback + OS 纵深）；`--allowed-tools` 改述为配置意图声明
  - agent-backends/claude-code-cli.md：已记 `--allowed-tools` / `--permission-mode` 不强制的实测事实（§权限边界 ⚠️），补 `--permission-prompt-tool stdio` / `can_use_tool` control 执行前强制机制的契约
- **issue 处置**：#45 在 PR-A/B/C 合入后关；#56 epic 在 PR-A/B/C/D 全部合入后关；#28 / #54（部分）/ #30 / #55-B 在对应 PR 合入后由 reviewer 评估关闭
- **证据收集合并门槛（决策点 2 反转的前提）**：PR-B 合并前必须 (a) 提交可重跑 fixture 测三类数据（stdin control 延迟 / SIGINT 多层传播事实 / 平台等价子进程树终止域覆盖事实） (b) 创建 tracking issue 含 owner / 验收 schema / 复审日期 4 周 (c) 挂 `adr-review` label。复审到期 → maintainer 在 issue 上记录决策结论 → 若反转决策点 2，maintainer 发独立 ADR PR。**门槛未达 PR-B 不允许合并**
- **legacy fallback 保留门槛**：PR-B 保留 `--print --resume` legacy 代码路径至证据收集复审完成；**默认不启用**但实现层必须保留可配置切换入口（环境变量 / 配置文件 / runtime flag）；删除 fallback 须独立 ADR/修订 PR
- **工具隔离实现前置验证门槛（决策点 5.2）**：实现工具隔离的 PR 落地前必须在目标 CC 版本上以 `--permission-prompt-tool stdio` 跑 deny / allow 双向 probe，坐实 `control_request{subtype:"can_use_tool"}` 触发、deny 副作用未发生、allow 可放行；不可行 → 切 PreToolUse hook fallback 并跑 hook deny probe（副作用未发生、`tool_result.is_error=true`、`permission_denials` 非空，且 probe 目录不得含 CC 原生 deny 污染）。control 与 hook fallback 均不可用时禁止落地工具隔离实现。两者都必须满足 5.2 的 fail-closed / 配置不可篡改要求。OS 级 defense-in-depth 技术选型（容器 vs seccomp vs 只读挂载）结合 ADR-0003 部署形态另定（可独立 ADR 或 tool-boundary 修订）
- **流程门槛**：本 ADR 合入 main 进入 Proposed 状态后，任何对 Decision 段的修订必须独立 ADR 修订 PR 经 review 后合并，遵守 `docs/dev/standards/adr.md §评审约束`

## Out of scope

**架构层**：跨 backend 抽象、MCP 接入、跨 turn thinking 持久化、capability flag 翻起的具体时机、daemon 视角的 UX SLA、三层 watchdog / 两段 cleanup 默认阈值与耦合关系、投递层确认窗口数值、节流 edit / typing 周期数值

**UX / UI 层**（issue #58–#66 演进）：工具调用呈现形态、typing 节奏最终阈值、错误呈现、mid-stream 收尾、切片时序锚定、interrupt UX 入口、长回复体积控制、脱敏边界、多用户 channel 并发、turn 收尾摘要、超时重试可见性、rate 累计预算

## Amendments

> Accepted 之后对决策内容 / 范围 / 命名的非反转修订。决策反转走 supersede 流程。

（暂无）

## 异议 & 回应（来自 argue self-check + GAN review）

起草过程跑了三轮 codex-review argue self-check；用户在第三轮覆盖 ADR 体量边界。2026-05-21 跑第四 / 第五 / 第六轮 GAN review（adversarial-review + 外部对照 cc-connect / takopi）。只留 verdict。

**第一 / 二 / 三轮 argue**（同原版）

**第四轮 GAN R1（含外部证据，2026-05-21）**：
- 异议 8（interrupt delivery 缺 process group / 5s 边界）→ 采纳，新增 §投递契约 process group + 三段兜底（细节见正文）
- 异议 9（timeoutLayer 三选一隐藏降级）→ 采纳，删 daemon 内部状态
- 异议 10（Proposed 改 Decision 例外）→ 采纳，删
- 异议 11（1-tr-A → 1-tr-B 隐式 supersede）→ 升级——外部 takopi 实证反转到 1-tr-B
- 异议 12（capability=true 但无人调）→ 采纳，加 PR-C 最小集成契约
- 异议 13（证据收集弱 owner）→ 采纳，改为 PR-B 合并门槛

**第五轮 GAN R2（2026-05-21）**：
- 异议 14（synthetic turn_finished 投递与 cleanup 升级互锁）→ 采纳，拆事件投递层 + 进程 cleanup 层两层状态机
- 异议 15（tool_result 缺 payload schema）→ 采纳，ADR 锁"协议层结构化承载五类 content"；具体字段表下移 spec（详见第六轮）
- 异议 16（tool_call_finished vs tool_result happens-before）→ 采纳，模型 A：tool_result* 在 tool_call_finished 前
- 异议 17（takopi `-p --resume` 反证未转 legacy 保留策略）→ 采纳，加 legacy fallback 保留门槛

**第六轮 GAN R3（2026-05-21）**：
- 异议 18（cleanup 升级判据 = process group 退出 错）→ 采纳，升级判据改为"turn cleanup ack 或 process exit 任一未达成才升级"；加 late event 丢弃规则；澄清 daemon sendInput 阻塞窗口锚定在事件投递层（非 cleanup 层）
- 异议 19（ADR 又膨胀超 250 行 / 锁了 spec-level 细节）→ 采纳，大幅瘦身——payload 字段表 / 阈值数值 / 平台实现细节 / 文件级 PR checklist 全部下移 spec；ADR 仅保留架构不变量
- 异议 20（0 条 tool_result 错误终态无表达）→ 采纳，`tool_call_finished` 必须携带 terminal status / error summary 覆盖 0-result error case，独立于 `tool_result.isError`

**第七轮（决策点 5 工具隔离强制点纳入，2026-05-22）**：

- 起因：PR #88 对 CC 2.1.148 全量实测发现 `--allowed-tools` / `--permission-mode` 不强制工具边界（关键事实 6），tool-boundary §白名单外拒绝 合约的 observer 实现前提被证伪。初稿曾拟开独立 ADR-0014 承载；经权衡——工具隔离失效是本 ADR 切 stream-json 观察/控制路径的**直接后果**、内聚性强于"独立维度"，且本 ADR 仍 Proposed 未合入、在可改窗口——合并为本 ADR 决策点 5，弃用 ADR-0014
- 收敛口径：决策点 5 仅锁三条架构不变量（CLI flag 非边界 / 进程内执行前强制点 / OS 纵深），机制对比与 control vs hook 谁为主下沉为实现前置验证项 + spec，遵守异议 19 "ADR 仅保留架构不变量"的瘦身原则
- 第七轮 GAN（2 轮收敛）verdict：R1 提 7 条（5 important + 2 nit），developer accept 6 / reject 1（I6 标题收敛 nit，体例既定，reviewer R2 复核后 withdrawn）；R2 全部 resolved/withdrawn、无新主 issue，verdict 接近最优。采纳要点——决策点 5 不变量不再排序未坐实的 control（偏好降为验证时优先候选）、5.2 补 fail-closed + 配置不可篡改边界、5.3 给 OS 纵深最低语义 + 无法满足须显式声明、关键事实 6 拆分「推断」与「确定事实」、5.1 限定到目标运行形态、"取代合约" 改为 "保留语义废弃 observer 实现路径"

**第八轮（cleanup 措辞收紧，2026-05-22）**：

- 起因：P1 外部对照 `cline/cline`（`src/utils/process-termination.ts` 用 `tree-kill` 做跨平台 process-tree 终止）提供子进程树终止的**跨平台实现对照**；结合 cc-connect 的 MCP 孙进程残留实证，说明「只杀主进程不足以清理子孙进程」非 POSIX-only 诉求。§进程 cleanup 层 原 `kill(-pid, sig)` process group 写法把不变量钉死在 POSIX、Windows 无等价
- 收敛口径：Decision 措辞收紧（语义不变、非反转）——kill 路径抽象为平台等价子进程树终止语义、显式限定仅约束主动 kill 路径不反转 graceful interrupt 不变量、三段升级改 soft-kill / hard-kill 阶段语义；具体平台命令下沉 spec。GAN-on-draft 3 轮收敛（R1 1 blocker + 4 important：阻止 process group/taskkill/tree-kill 被写成严格等价、阻止把自然 process exit 读进 kill 路径、阻止信号名当跨平台通用动作、防 Decision 实现细节回胀；R2 修 Rationale 残留命令 framing；R3 接近最优）

**第九轮（工具隔离前置验证非 bypass 复测，2026-05-23）**：

- 起因：早期 CC 2.1.148/2.1.149 样本未排除本机 user settings `defaultMode:"bypassPermissions"`，把 `init.permissionMode=="bypassPermissions"` 误写成 `default` 固有语义；同版本 2.1.149 后续改用隔离目录重跑。新建隔离目录，project settings 显式 `defaultMode:"default"`，以 `--setting-sources project --permission-mode default` 复测，`init.permissionMode` 实报 `default`
- 收敛口径：修正关键事实 6 与 spec 对账版本——不再用“default 退化 bypassPermissions”支撑决策点 5.1；5.1 仍由非 bypass 复测下 `--allowed-tools Read` 不阻止 Bash 执行、observer 无法事后拦截、未启用 stdio permission prompt 时裸 CLI 不触发 `can_use_tool` / 独立 stdout `permission_request` 支撑。该轮曾临时把 PreToolUse hook 定为主强制点，后续第十轮被 `--permission-prompt-tool stdio` 证据修正

**第十轮（cc-connect 权限请求路径复查，2026-05-23）**：

- 起因：用户指出 cc-connect 可能处理了类似 `permission_request` 的路径。复查 `chenhg5/cc-connect` 后发现其 Claude Code backend 启动参数固定包含隐藏 `--permission-prompt-tool stdio`，并在 `control_request{subtype:"can_use_tool"}` 到达时转成内部 `permission_request` 事件，用户回复 allow/deny 后写回 `control_response`
- 实测：用 CC 2.1.149、隔离新目录、project settings `defaultMode:"default"` 重跑。`--print stream-json + --permission-prompt-tool stdio` 与长驻 stream-json + 同 flag 均在 Bash/Edit 写文件前产出 `can_use_tool`；回 deny 后 sentinel 文件不存在且 result 有 `permission_denials`；回 allow + `updatedInput` 后文件成功创建
- 收敛口径：修正第九轮结论的遗漏条件。`can_use_tool` 并非不可用，而是需要显式 `--permission-prompt-tool stdio`。决策点 5.2 主强制点改为 stdio permission control，PreToolUse hook 降为 fallback / defense-in-depth；由于该 flag 不在 help 中，CompatibilityProbe 必须验证 deny / allow 双向语义并 fail closed

**第十一轮（Claude Code 源码入口扫描，2026-05-23）**：

- 起因：用户要求主要扫入口的输入形式，以及 agent-nexus 需要处理的可能输出。对 `/workspace/claudecode-src` 只读复核 `main.tsx` / `cli/print.ts` / `cli/structuredIO.ts`。
- 收敛口径：不传 `--print` 仍可进入 headless 主路径，但前提是 stdout 为 pipe（`!process.stdout.isTTY`）；TTY 裸跑会进交互 REPL。stdin structured IO 源码接受 `user`、`control_response`、`control_request`、`assistant`、`system`、`keep_alive`、`update_environment_variables` 等，MVP 只发送 `user` / `control_response` / 少量会话控制。stdout 必须处理业务事件与权限 `control_request(can_use_tool)`，同时容忍 `isReplay` user ack、`control_response`、`control_cancel_request`、`keep_alive`、`session_state_changed`、`task_*`、`post_turn_summary`、`prompt_suggestion`、`streamlined_*` 等非业务事件。`PermissionRequest` 是本机 hook；源码未显示独立 stdout SDK `permission_request` 事件。

外部证据来源：`chenhg5/cc-connect`（process group kill 必要性 + Discord edit/typing 节奏 viable；`--permission-prompt-tool stdio` + `can_use_tool` / `control_response` 权限路径）+ `banteg/takopi`（tool_result 5 种 content 变体 + `-p --resume` 反证）+ PR #88 CC 2.1.148 实测（`--allowed-tools` 不强制 / PreToolUse hook 能 deny / control protocol 握手裸 CLI 可用）+ CC 2.1.149 非 bypass 新目录矩阵复测（`init.permissionMode=="default"` 下 `--allowed-tools Read` / project `allow:["Read"]` 仍不拦 Bash；project `deny`、Edit 写权限待批准、`dontAsk`、`PermissionRequest` hook 均不触发裸 CLI `can_use_tool` / 独立 stdout `permission_request`；local `--sdk-url` 直接拒绝非 Anthropic approved endpoint）+ CC 2.1.149 stdio permission prompt 补测（`--permission-prompt-tool stdio` 下 `can_use_tool` deny / allow 均有效）+ `/workspace/claudecode-src` 源码入口扫描（headless 触发条件、StructuredIO 输入、stdout 控制 / 状态事件）+ `cline/cline`（`tree-kill` 跨平台子进程树终止实现对照 → 第八轮 cleanup 措辞收紧）

## 参考

- 相关 issue：#56（epic 来源）、#45 / #28 / #54 / #30 / #55、UX 待办 #54 / #58-#66
- 相关 spec / ADR：见 §需要后续跟进的事
- 当前实现：`packages/protocol/src/agent.ts:34-98` / `packages/agent/claudecode/src/index.ts:120-333` / `packages/platform/discord/src/index.ts:193-206`
- **外部对照项目**：cc-connect（https://github.com/chenhg5/cc-connect）/ takopi（https://github.com/banteg/takopi）
