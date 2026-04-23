# Codex Review: agent-nexus Dev Docs — 2026-04-23

- **Reviewer**: OpenAI Codex (gpt-5 series) via `codex-review` skill
- **Prompt**: `.tasks/codex-review-prompt.scratch.md` (6246 bytes)
- **Target commit**: `dec4337`（第 7 个 commit 完成后）
- **触发方**: 项目发起人 review request；主 session 主导

原始输出（未裁剪）：

---

# Codex Review: agent-nexus Dev Docs

## 1. 正确性 / 内部矛盾

- **[P0]** `docs/dev/architecture/overview.md` §“最小数据流” vs `docs/dev/spec/platform-adapter.md` §“事件分发语义” vs `docs/dev/architecture/session-model.md` §“幂等”
  幂等职责冲突。`overview` 写 `platform/discord` 执行 messageId 幂等检查，`session-model` 也写 adapter 收到事件后先查去重表；但 `platform-adapter` 明确写 Adapter 不做去重，core idempotency 层做。
  建议：统一为“adapter 只归一化并投递；core.auth 之后、session 入队之前执行 `checkAndSet`”。如果确实希望 adapter 调 core 去重，也要改掉 `platform-adapter` 的“Adapter 不做去重”硬约束。当前实现者会不知道去重该放哪层。

- **[P1]** `docs/dev/architecture/session-model.md` §“生命周期 / 进程重启 / CC 子进程崩溃”
  状态机图只有 `Created/Active/Idle/Archived`，后文又引入 `Interrupted/Errored`，但没有定义它们如何恢复、归档、重试或进入 Active。`cost-and-limits.md` 又写熔断后 `Errored` 可由 `/resume` 或冷却恢复。
  建议：把 `Errored`、`Interrupted` 纳入正式状态机，补齐：`Interrupted -> Active|Archived`、`Errored -> Active|Archived`、`Archived -> Created?` 的触发条件。否则恢复路径无法实现。

- **[P1]** `docs/dev/architecture/session-model.md` §“Archived：新消息触发新 session” vs `docs/dev/spec/persistence.md` §`sessions.session_key TEXT PRIMARY KEY`
  `SessionKey = (platform, channelId, initiatorUserId)` 是稳定 key，SQLite 又把它做 primary key。归档后“新消息触发新 session”没有地方表达新实例：同 key 只能覆盖旧 session。
  建议：引入 `sessionId` / `generation` / `incarnation`。`SessionKey` 作为路由 key，`sessionId` 作为持久化主键；或者明确 Archived 同 key 复用旧 row 并重置 transcript/counters。现在的语义是矛盾的。

- **[P1]** `docs/dev/spec/agent-runtime.md` §`AgentEvent.usage` vs `docs/dev/spec/observability.md` / `cost-and-limits.md` 的 `llm_call_finished`
  agent runtime 只产出 `usage` 事件；observability/cost 却要求每个 `llm_call_finished` 必须落日志，并围绕 `llm_call_finished.costUsd` 做预算。中间缺少从 `usage` 到 `llm_call_finished` 的确定映射。
  建议：统一事件名。要么 core 将 `AgentEvent{type: usage}` 转成日志事件 `llm_call_finished`，并明确字段补全规则；要么 observability 改成 `usage_recorded`。否则测试和实现都会各写一套名字。

- **[P1]** `docs/dev/spec/agent-runtime.md` §`turn_finished.reason` vs `docs/dev/spec/cost-and-limits.md` §“Turn 与工具调用硬限”
  `agent-runtime` 枚举 `turn_finished.reason` 只有 `stop|max_tokens|user_interrupt|error`，但 `cost-and-limits` 要求触发 `turn_finished { reason: "tool_limit" }`。
  建议：把 `tool_limit`、`timeout`、`budget_exceeded` 等 core 可能制造的结束原因统一放进 `agent-runtime` 或单独定义 `CoreTurnEndReason`，不要让不同 spec 发明不同枚举。

- **[P1]** `docs/dev/spec/cost-and-limits.md` §“入站 Rate Limit（Anthropic via CC）/ maxConcurrentLlmCalls” vs ADR-0002/0004 的“CC CLI 黑盒”
  文档要求 agent-nexus 对 Anthropic 429/5xx 做指数退避、限制 in-flight LLM 调用数。但本项目不直接调用 Anthropic API，而是驱动 CC CLI。除非 CC CLI 把 429/5xx 和每次 LLM call 边界稳定暴露出来，否则这些控制点不可实现。
  建议：MVP 改成“检测 CC CLI 可见错误并限制 session/turn 级重试”，删掉或降级 `maxConcurrentLlmCalls` 与 Anthropic 级 retry；等有稳定 CC 事件再升级。

- **[P2]** `docs/dev/spec/agent-runtime.md` §`SessionConfig.totalBudgetUsd` vs ADR-0006 / `cost-and-limits.md`
  ADR-0006 已把 `$ budget` 降为 opt-in 二等机制，但 `SessionConfig` 仍有必填 `totalBudgetUsd: float`，这会把预算重新塞回 agent runtime 主路径。
  建议：改成 `budget: BudgetConfig?` 或完全由 core 控制，不传给 CC adapter。

## 2. 安全盲点

- **[P0]** `docs/dev/spec/security.md` §“身份与授权”
  allowlist 只约束 Discord `userIds/roleIds`，没有约束 `guildId/channelId/threadId/DM` 可达范围。若 bot 被邀请到非预期 guild，或 allowlisted 用户在错误 channel 里触发 bot，本机 CC 仍可能被遥控。
  建议：安全配置至少增加 `allowedGuildIds`、`allowedChannelIds`、`allowDM`、`requireMentionOrSlash`。权限判断应基于 `(guildId, channelId, userId, roleIds)`，不是只看用户。

- **[P0]** `docs/dev/spec/security.md` §“会话绑定 / shared_channel_mode”
  `shared_channel_mode` 写“其他用户消息作为 context 可见，但仍不能触发 agent”。这是典型 prompt injection 入口：攻击者不需要触发 agent，只要把恶意文本塞进上下文，下一次 allowlisted 用户触发时就生效。
  建议：MVP 直接砍掉 `shared_channel_mode`。如果未来保留，必须把非发起者内容标成 untrusted context，并默认不进入 agent prompt。

- **[P1]** `docs/dev/architecture/session-model.md` §SessionKey 与 `docs/dev/spec/platform-adapter.md` §发送映射
  `(platform, channelId, userId)` 能隔离处理队列，但不能隔离可见性。多人共享 channel 里，bot 输出默认对整个 channel 可见；这可能泄露代码、路径、错误摘要、任务意图。`ephemeral` 只适用于 interaction response，不适用于普通消息。
  建议：共享 guild channel 中默认创建 private thread/DM，或要求 slash command + ephemeral ACK + 后续 thread；至少配置 `publicChannelMode = disabled|thread|public`，默认 disabled。

- **[P1]** `docs/dev/spec/security.md` §“工具白名单 / 工作目录”
  文档声称“只能访问 `workingDir` 下的文件（由 CC 本身 allowlist 控制）”，但这是外部工具能力假设，不是 agent-nexus 自己能保证的边界。默认白名单还包含 `Read/Grep/Glob/Edit/Write`，一旦 Discord 账号被盗，远程可读写本机项目。
  建议：把“工作目录限制”改成显式前置条件：启动时读取/验证 CC allowed dirs；如果无法验证则降级为风险提示。MVP 默认工具集建议只读或要求显式确认写工具。

- **[P1]** `docs/dev/spec/message-protocol.md` §`Attachment` / `docs/dev/spec/security.md` 威胁模型
  附件安全缺失。Discord 附件 URL 可能引入超大文件、恶意内容、压缩包、prompt injection 文档、路径名欺骗、SSRF 风格的下载链路问题。
  建议：MVP 明确“不处理附件”或只允许小尺寸纯文本/图片元数据；下载必须有 size cap、MIME allowlist、存储隔离、文件名规范化、过期清理。

- **[P1]** `docs/dev/spec/security.md` §“Prompt Injection 缓解”
  目前缓解重点是工具白名单和脱敏，但没有“系统指令边界”契约：哪些 Discord 内容会进 agent prompt、如何标注 untrusted input、是否允许用户要求读取日志/transcript/secrets。
  建议：补一个 `AgentPromptEnvelope` 或输入包装规则：所有 IM 内容必须作为 untrusted user content，不拼接进 system/developer 指令；控制命令与自然语言消息分离。

- **[P2]** `docs/dev/spec/observability.md` §“禁止字段” vs `docs/dev/spec/persistence.md` §Transcript
  日志禁止用户消息正文和 CC 完整输出，但 transcript 保存 CC 原始输出。security 只说密钥不得写 transcript，没说 transcript 的本地权限、红队脱敏、用户主动导出风险。
  建议：transcript 目录权限 `0700`，文件 `0600`；明确 transcript 是高敏数据，默认不通过 Discord 读取/发送。

## 3. 可执行性缺口

- **[P0]** `docs/dev/spec/agent-runtime.md` §“CC CLI 专属说明”
  最关键的外部契约没有落定：CC CLI 的具体启动命令、JSON stream flag、输入协议、resume/session 参数、退出码、stderr/stdout 分工都还是“写入实现时锁定”。这会阻塞第一版实现。
  建议：在写代码前补 `claude-code-cli-contract.md` 或本 spec 子节，至少固定 MVP 支持的 CC CLI 版本范围、命令模板、输入输出样例、错误样例。

- **[P1]** `docs/dev/spec/platform-adapter.md`
  Discord 交互硬约束缺失：Gateway intents、Message Content Intent、slash command 注册范围、interaction 3 秒 ACK、follow-up message、rate limit bucket key、bot invite permissions。
  建议：补 Discord MVP 操作契约。否则实现者会在“普通 message 监听”与“slash command first”之间摇摆，安全和 UX 都会不同。

- **[P1]** `docs/dev/spec/security.md` / `docs/dev/spec/persistence.md`
  配置 schema 没有集中定义。文档散落提到 `config.security.allowlist`、`limits.*`、`budget.*`、`quota.*`、`AGENT_NEXUS_DATA_DIR`，但没有完整 `config.toml` 示例、默认值、必填项、校验错误。
  建议：新增 `docs/dev/spec/config.md`。MVP 实现会大量依赖配置，缺这个会导致各模块自创字段。

- **[P1]** `docs/dev/spec/agent-runtime.md` / `cost-and-limits.md`
  “如果 CC 没吐 usage 或吐得不完整怎么办”没有策略。现在文档把 usage 当测试必过项，但现实中 CLI 版本、订阅路径、错误中断都可能缺字段。
  建议：定义 `UsageCompleteness = complete|partial|missing`。缺失时仍记录 turn/tool/wall-clock；token/cost 标 unknown；`$ budget` 自动 fail-closed 或禁止启用；不要用猜测成本做硬限制。

- **[P1]** `docs/dev/spec/message-protocol.md` §“顺序”
  写“同 session 串行”，又写“乱序到达时按 sequence 串行处理”。但 Discord gateway 事件没有你自己的 session 内 sequence；snowflake 可排序但 interaction/message/reaction 混合时语义不等价。
  建议：MVP 不承诺重排序，只承诺“按 core 接收并成功入队顺序处理”；如果要按平台时间排序，需要定义乱序缓冲窗口和丢弃策略。

- **[P2]** `docs/dev/spec/persistence.md` §“迁移”
  SQLite + JSONL 对 MVP 足够；迁移机制“粗糙但可接受”。缺的是 `schema_migrations` 表结构、事务边界、失败回滚策略、降级策略。
  建议：首版只要支持 forward-only migration，所有 migration 在事务中执行，启动失败不自动修复。不要现在做复杂迁移框架。

## 4. 过度设计建议砍掉的

- **[P1]** `docs/dev/spec/agent-runtime.md` 的“未来多后端扩展”压力过早。
  MVP 只有 CC CLI，接口却要求 Codex/Gemini 未来不破坏契约，容易把黑盒 CLI 的真实约束藏起来。建议先命名为 `ClaudeCodeRuntime` 的最小接口，等第二个后端出现再抽象。

- **[P1]** `docs/dev/spec/cost-and-limits.md` 的 `maxConcurrentLlmCalls`、Anthropic 级 429/5xx retry、订阅配额跟踪配置。
  这些对 CC CLI 黑盒不可控或未实现。建议 MVP 保留 session 级并发、turn/tool/wall-clock、Discord 429、CC 子进程错误熔断；其余放 Future。

- **[P2]** `docs/dev/spec/observability.md` 的 OTel logs。
  本机桌面 + JSONL 已够。OTel 作为可选会增加字段兼容和脱敏出口。建议 MVP 从 spec 中移到 Future，避免出现第二条日志出口。

- **[P2]** `docs/dev/testing/eval.md` 对当前阶段偏早。
  这个项目的第一风险不是“回答质量回归”，而是 Discord/CC/权限/幂等/恢复契约。eval 可以保留占位，但不应进入 MVP 必过门槛。

- **[P2]** `platform-adapter.md` 的 embeds/components/select/modal 泛化。
  MVP 若采用 slash command + plain text/thread，复杂组件可后置。先把 ACK、thread、分片、rate limit 做对，比组件抽象更关键。

## 5. 你能看到但 Claude 可能看不到的风险

- **[P0]** 真正的边界不是“本机用户可信”，而是“Discord 账号远程等价本机操作”。
  文档承认 Discord 账号被盗，但应把它提升为核心威胁：被盗账号不只是发消息，而是远程读写本机代码、触发工具、消耗订阅额度。allowlist 不是强认证，只是 Discord 身份映射。建议 MVP 默认要求 DM 或私有 thread、危险工具显式启用、写操作可配置二次确认。

- **[P1]** CC CLI 是产品依赖，不是稳定库依赖。
  文档把 transcript fixture 当缓解，但如果 CLI 输出协议、权限 flag、usage 字段、交互模式变了，agent-nexus 会整体失效。建议把“兼容矩阵 + 启动自检”作为一等：启动时跑 `claude --version` 和最小 JSON probe，不通过就拒绝服务。

- **[P1]** “订阅 vs API”之外还有第三个分类视角：**可观测但不可控 vs 可控**。
  ADR-0006 的“一等=防失控/观测，二等=配额”方向基本成立，但还缺一层现实约束：
  `hard control`：本进程能强制的，如 session 并发、turn timeout、Discord send queue。
  `soft inference`：只能从 CC 输出推断的，如 token、model、cost、Anthropic 429。
  `external quota`：上游账号窗口，如订阅 5h rolling quota。
  这个分类能防止把不可控的 Anthropic retry / usage 当硬机制写进 MVP。

- **[P1]** SessionKey 在多人 channel “路由合理”，但“产品语义危险”。
  `(platform, channelId, userId)` 能防止同 channel 多人串 session，但不能防旁观、截图、引用、reply 混淆。我的判断：内部 key 可以保留；外部交互默认不应在公开 channel 持续对话，应转 thread/DM。

- **[P1]** Redactor 被放在“最后一跳”不够。
  最后一跳能防泄露到 IM/log，但防不了 CC 在工具调用中使用敏感信息、防不了 transcript 存高敏内容、防不了摘要字段提前记录。建议分两层：输入/工具边界的 policy guard + 输出/log 的 redactor。

## 6. 其他

- **[P2]** 我在评审开始时用 shell 直接读了几份 docs，随后切回 `scripts/docs-read` 重读核心文件。这个项目规则本身合理，但要注意：它约束的是协作者行为，未来 CI/hook 如果只拦 Claude `Read` 工具，不会拦 shell `sed/cat`。建议把 `scripts/pretool-read-guard` 的定位写清楚：它只能降低风险，不能作为强一致安全边界。

- **[P2]** ADR-0004 里 Go 倾向是合理的，但“CC 已带 Node runtime，所以 TS 分发零负担”这个旧论据应明确降权或删除。CC 自带/依赖的 Node 不一定是可复用 runtime，也不应假定用户环境可直接跑项目 Node 依赖。

---

## 响应（主 session 填写）

> 响应原则按 `docs/dev/process/code-review.md` §"如何响应反馈"：每条必须有明确响应，理由写清。按 Codex 建议分轮落地（P0 先行，其他方向后续）。

### 轮 1：P0（本 commit 落定）

| 编号 | 响应 | 落地 |
|---|---|---|
| 1.P0 幂等职责冲突 | 采纳 | 改 `architecture/overview.md`（adapter 只归一化投递）、`architecture/session-model.md`（adapter 不做去重）、`spec/message-protocol.md`（显式 core 流程：auth → idempotency → 限流 → 队列；解释为什么 auth 先于 idempotency） |
| 2.P0 allowlist 缺 guild/channel/DM | 采纳 | `spec/security.md` §"身份与授权/Allowlist" 改为 `(guildId, channelId, userId, roleIds)` 四元组；新增 `allowedGuildIds / allowedChannelIds / allowDM / requireMentionOrSlash`，fail-closed |
| 2.P0 shared_channel_mode 是 injection 入口 | 采纳 | `spec/security.md` 砍掉该模式；注明未来引入必须发新 ADR + untrusted 标注 |
| 3.P0 CC CLI 外部契约空白 | 采纳 | 新增 `spec/claude-code-cli-contract.md`（完整 spec：版本、命令模板、stream-json、事件映射、UsageCompleteness、中断/超时/崩溃、兼容性自检、合约测试、兼容矩阵占位）；`spec/agent-runtime.md` §CC CLI 专属说明瘦身并引用；`spec/README.md` 索引新增一类"Agent 后端专属契约" |
| 5.P0 Discord 账号盗为核心威胁 | 采纳 | `spec/security.md` §威胁模型将"账号被盗"重写为"核心威胁"段落置顶；新增 `publicChannelMode` 默认 `thread`（公开 channel 自动转私有 thread）；显式标注 allowlist 不是强认证 |

### 轮 2：方向 A（契约内部对齐，后续 commit）

- P1 状态机 `Interrupted/Errored` 没纳入图 — 待改
- P1 Archived 与 SQLite primary key 冲突（需 `sessionId/generation`）— 待改
- P1 `AgentEvent.usage` ↔ `llm_call_finished` 事件名不统一 — 待改
- P1 `turn_finished.reason` 枚举缺 `tool_limit/timeout/budget_exceeded` — 待改（本轮 `claude-code-cli-contract.md` 已引入 core 注入 reason 机制；agent-runtime.md 需同步）
- P2 `SessionConfig.totalBudgetUsd` 违反 ADR-0006 — 待改

### 轮 3：方向 B（砍黑盒做不到的 limits + ADR-0007 三分类）

- P1 `maxConcurrentLlmCalls` / Anthropic 级 429/5xx retry / 订阅配额跟踪 — 待砍或降级
- P1 新 ADR-0007：`hard control / soft inference / external quota` 三分类 — 待写

### 轮 4：方向 C（新 spec）

- P1 新 `spec/config.md`（集中 config schema） — 待写
- P1 `spec/platform-adapter.md` 扩 Discord 操作章（intents / 3s ACK / follow-up / rate limit bucket） — 待改

### 轮 5：P2 过度设计 + 其他

- P1 多 agent 后端抽象过早（先命名 `ClaudeCodeRuntime`） — 待改
- P2 OTel logs 从 MVP 移到 Future — 待改
- P2 embeds/components/select/modal 泛化后置 — 待改
- P2 eval 不进 MVP 必过门槛 — 待调整
- P1 Redactor 分两层（输入/工具边界 + 输出/log） — 待改
- P1 CC CLI 兼容矩阵 + 启动自检作为一等 — 本轮 `claude-code-cli-contract.md` §"兼容性自检"已写入
- P1 SessionKey 在公开 channel 默认转私域 — 本轮已改（`publicChannelMode`）
- P2 pretool-read-guard 定位说明 — 待改
- P2 ADR-0004 "CC 带 Node 分发零负担"论据降权 — 待改

## 拒绝 / 部分采纳清单（本轮无）

本轮 P0 全部采纳无异议。

## 本轮之外的追认

Codex 另提及 §6 其他第一条：它自己评审时曾用 shell 直接读 docs，"项目规则约束协作者但不能拦 shell sed/cat"。这是对 `scripts/pretool-read-guard` 定位的公允描述——我们的 hook 是"harness 级 PreToolUse 拦截"，不是"文件系统级强一致边界"。后续轮会补充 `AGENTS.md` / hook 注释里的定位说明。
