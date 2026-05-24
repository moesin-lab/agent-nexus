---
title: Spec：Slash Command Registry
type: spec
status: active
summary: Slash command 的三类 owner、descriptor、命名策略、注册计划、reverse map 与激活语义
tags: [spec, dispatch, platform-adapter, agent-runtime, message-protocol]
related:
  - dev/adr/0016-slash-command-registry
  - dev/spec/message-protocol
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
  - dev/spec/config-routing
  - dev/spec/security/auth
contracts:
  - CommandDescriptor
  - CommandNamePolicy
  - CommandRegistrationPlan
  - ActiveCommandMap
---

# Spec：Slash Command Registry

本 spec 定义 platform / daemon / agent slash command 的声明、命名、注册计划、别名与 dispatch 契约。目标是让不同 owner 可以声明命令，同时由 daemon 统一验证、规划和通过显式 reverse map 分发。

## 归属

`CommandDescriptor` 是 platform-neutral 契约，住在 `@agent-nexus/protocol`。daemon 拥有 descriptor 收集、name policy 校验、registration plan 构建、active reverse map 和 dispatch 语义。

事实归属：

| 事实 | Owner |
|---|---|
| descriptor 字段形状、command option 基础类型 | `@agent-nexus/protocol` + 本 spec |
| command owner taxonomy、name policy、alias、registration plan、reverse map、激活语义 | `@agent-nexus/daemon` + 本 spec |
| agent command descriptor 内容 | 对应 `@agent-nexus/agent-<name>` package |
| platform command descriptor 内容、native payload 映射 | 对应 `@agent-nexus/platform-<name>` package |
| daemon command descriptor 内容 | `@agent-nexus/daemon` |
| 启用哪些 platform / agent instance 与 binding | `config-routing.md` + CLI 组装 |

CLI 只收集已启用 package 暴露的 descriptor 并把它们交给 daemon planner；CLI 不解释 command name policy、不生成 alias、不解析 platform native payload。

## Owner Taxonomy

命令 owner 只有三类：

| Owner type | Canonical id 形态 | 归属判据 |
|---|---|---|
| `agent` | `agent:<agentOwner>:<localName>` | agent backend 行为；具体 agent package 声明 |
| `platform` | `platform:<platformType>:<localName>` | 语义依赖某个平台 type 的概念、交互模型或平台私有状态 |
| `daemon` | `daemon:<localName>` | agent-nexus 核心控制面；没有某个具体 platform 时仍有意义 |

分类时先问：该命令的语义在没有某个具体 platform type 时是否仍成立。成立则是 `daemon` command；不成立则是 `platform` command。agent backend 行为始终是 `agent` command。代码当前位置不能作为分类依据，只能用于验证 owner 是否与语义判定一致。

`platform:discord:reply-mode` owns 现有 `/reply-mode` 行为，因为它依赖 Discord trigger mode、slash interaction 与 Discord platform state。

## CommandDescriptor

Descriptor 不包含最终平台 command name；平台可见名由 daemon 按 `CommandNamePolicy` 生成。Descriptor 也不得包含 Discord SDK 类型、平台 payload 或 routing table 条件。

```text
CommandDescriptor {
    canonicalId: CommandCanonicalId
    owner: CommandOwner
    localName: string
    summary: string
    options: CommandOption[]
    handlerKey: string
    applicability: CommandApplicability
    legacyNames: LegacyCommandName[]
}

CommandOwner =
    { type: "agent", agentOwner: string }
  | { type: "platform", platformType: string }
  | { type: "daemon" }

CommandOption {
    name: string
    type: "string" | "integer" | "number" | "boolean"
    required: bool
    description: string
    choices: CommandChoice[]
}

CommandChoice {
    name: string
    value: string | integer | number
}

LegacyCommandName {
    name: string
    reason: "historical-compatibility"
}
```

字段语义：

| 字段 | 语义 |
|---|---|
| `canonicalId` | 稳定 ID；只用于唯一性、日志、reverse map 目标，不用于字符串拆分 dispatch |
| `owner` | 显式 owner；daemon 用它判断 stable name 前缀与 dispatch handler 边界 |
| `localName` | owner 内的命令名，例 `new` / `reply-mode` / `status` |
| `summary` | 平台 command description 的平台中立描述；平台映射时可截断或拒绝过长值 |
| `options` | 平台中立参数 schema；platform adapter 映射到 native option |
| `handlerKey` | owner 内 handler 查找 key；不得由平台 command name 推导 |
| `applicability` | 哪些 platform registration scope 可以暴露该命令 |
| `legacyNames` | 已发布裸名兼容 alias；不得用于新增短名偏好 |

校验规则：

- `canonicalId` 在所有已启用 descriptors 中全局唯一。
- `canonicalId` 必须与 `owner` / `localName` 表示同一事实；不一致 fail-closed。
- `canonicalId` 分量不得包含 `:`；`agentOwner`、`platformType`、`localName` 必须是非空小写 kebab-case。
- `localName`、option name、choice value 必须能映射到目标 platform 的命名限制；不能映射时该 scope 的 plan 构建失败。
- `summary` 必须非空；平台 description 限制由 platform adapter 在 native payload 映射阶段校验。
- `handlerKey` 只在对应 owner 内有意义，并且在同一 owner 内必须唯一；daemon 不跨 owner 解释 handler key。

## Applicability

```text
CommandApplicability {
    platformTypes: string[]?           // 缺省语义见下表
    requiredCapabilities: CommandRequiredCapability[]
}

CommandRequiredCapability =
    "slash-command-registration"
  | "ephemeral-response"
```

默认适用规则：

| Owner type | 默认 applicability |
|---|---|
| `agent` | 由 bindings 决定；只在绑定到该 agent owner 的 platform registration scope 暴露 |
| `platform` | 只适用于 `owner.platformType` |
| `daemon` | 必须显式声明 `platformTypes` 或 `requiredCapabilities`，否则 descriptor 非法 |

`requiredCapabilities` 是 daemon planner 与 platform adapter 之间的能力约束，不是 UI feature flag。

| Capability | 判定 |
|---|---|
| `slash-command-registration` | platform adapter 暴露 command registration port，且 `CapabilitySet.supportsSlashCommands == true` |
| `ephemeral-response` | `CapabilitySet.supportsEphemeral == true` |

当前首批 slash command 至少要求 `slash-command-registration`；需要 ephemeral reply 的 command 还必须声明 `ephemeral-response`。

## CommandNamePolicy

```text
CommandNamePolicy {
    productReservedPrefixes: string[]          // ["nexus-"]
    platformReservedPrefixes: string[]         // ["discord-"]
    historicalReservedBareNames: string[]      // ["reply-mode"]
}
```

`activeAgentReservedPrefixes` 不写入 policy，由当前启用的 agent owner 派生：

```text
activeAgentReservedPrefixes = enabledAgentOwners.map(owner => `${owner}-`)
```

规则：

- daemon/registry canonical 层加载一份 `CommandNamePolicy`。
- platform registration plan 构建时使用同一份 policy + 派生 agent prefixes 做平台名生成与冲突检测。
- agent owner 派生出的 stable prefix 不得落入 product/platform reserved prefix，否则 fail-closed。
- 新增或移除 legacy bare alias 时，必须同步更新 `historicalReservedBareNames`；移除 legacy alias 后默认继续保留 historical reserved bare name。
- 新 command 不得申请 bare name；bare name 只来自 single-agent alias 或 legacy compatibility alias。

## Stable Names

stable name 始终注册，且由 owner type 决定：

| Canonical id | Stable platform name |
|---|---|
| `agent:codex:new` | `codex-new` |
| `agent:claudecode:new` | `claudecode-new` |
| `platform:discord:reply-mode` | `discord-reply-mode` |
| `daemon:status` | `nexus-status` |

生成规则：

```text
stableName(descriptor):
    agent    -> `${owner.agentOwner}-${descriptor.localName}`
    platform -> `${owner.platformType}-${descriptor.localName}`
    daemon   -> `nexus-${descriptor.localName}`
```

stable names 必须在目标 platform registration scope 内唯一。两个 canonical ids 指向同一个 stable name 时，registration plan 构建失败。

## Bare Alias

single-agent alias 只对 `agent` command 自动生成。alias name 等于 `localName`。

alias 前置条件：

- 该 registration scope 内，相关 `localName` 只对应一个 distinct agent owner。
- alias 不等于任何 stable name。
- alias 不匹配 `productReservedPrefixes`、`platformReservedPrefixes` 或 `activeAgentReservedPrefixes`。
- alias 不在 `historicalReservedBareNames`。
- alias 与同 scope 内其它 alias 或 legacy name 不冲突。

scope 从 single-agent 变为 multi-agent 时，只移除 bare alias；stable name 保持不变。移除 alias 不影响 active stable command dispatch。

## Legacy Names

legacy name 是已经发布过、需要兼容迁移窗口的裸名。legacy name 必须显式写在 descriptor 的 `legacyNames`，同时列入 `CommandNamePolicy.historicalReservedBareNames`。

当前 legacy name：

| Legacy name | Canonical id | Stable replacement |
|---|---|---|
| `reply-mode` | `platform:discord:reply-mode` | `discord-reply-mode` |

迁移语义：

- `/discord-reply-mode` 是 stable name。
- `/reply-mode` 在迁移窗口内作为 legacy alias 保留。
- 移除 `/reply-mode` 是破坏性变更；移除后 `reply-mode` 仍保留在 historical reserved bare names，agent alias 不得复用。

## Registration Scope

`RegistrationScope` 是 daemon 与 platform adapter 之间的注册目标，不是 routing binding。

```text
RegistrationScope {
    platformName: string
    platformType: string
    nativeScope: NativeCommandScope
}

NativeCommandScope =
    { kind: "global" }
  | { kind: "guild", guildId: string }
```

当前 Discord scope 规则：

| `platforms[].testGuildId` | Registration scope |
|---|---|
| 缺省 / 空 | `{ kind: "global" }` |
| 非空 | `{ kind: "guild", guildId: testGuildId }` |

Guild scope 用于开发或单 guild 测试；global scope 用于生产。Global command 的客户端可见性和传播不适合快速本地迭代；需要快速验证时使用 guild scope。

## Registration Plan

daemon 按 registration scope 构建 plan。

```text
CommandRegistrationPlan {
    scope: RegistrationScope
    commands: PlannedCommand[]
    reverseMap: CommandReverseMap
    generation: string
}

PlannedCommand {
    commandName: string
    canonicalId: CommandCanonicalId
    aliasKind: "stable" | "single-agent-alias" | "legacy"
    descriptor: CommandDescriptor
}

CommandReverseMap {
    entries: map<string, CommandRoute>
}

CommandRoute {
    canonicalId: CommandCanonicalId
    aliasKind: "stable" | "single-agent-alias" | "legacy"
    owner: CommandOwner
    handlerKey: string
}

ActiveCommandMap {
    scope: RegistrationScope
    reverseMap: CommandReverseMap
    generation: string
    activatedAt: timestamp
}
```

`CommandRegistrationPlan.commands` 是该 scope 内 agent-nexus registry 管理的期望全集，不是增量 upsert 列表。不在集合内的旧 command 必须被 platform adapter 从远端 scope 删除。

`generation` 是 per-scope next plan 的唯一 token。daemon 每次构建 next plan 都必须分配新 generation；同一 scope 同时最多一个 in-flight apply。迟到的旧 generation result 必须丢弃，不能激活 active map。

构建顺序：

1. 收集 daemon descriptors、enabled platform descriptors、enabled agent descriptors。
2. 按 `RegistrationScope.platformType` 和 `CommandApplicability` 过滤 descriptor。
3. 对 agent descriptors，再按该 platform instance 的 bindings 计算适用的 agent owners。
4. 为所有适用 descriptors 生成 stable name。
5. 为符合条件的 agent descriptors 生成 single-agent alias。
6. 加入 descriptor 声明的 legacy names。
7. 校验所有 command names 在该 scope 内唯一。
8. 构建 `reverseMap`，key 是完整 platform-visible command name，不对 name 做 `-` split。

计划构建失败必须 fail-closed：不得注册部分 command，不得更新 active map。

## Remote Registration Activation

platform adapter 负责把 `PlannedCommand` 映射为 native payload 并以替换语义提交到远端平台。daemon 只在远端注册成功后激活对应 scope 的 reverse map。

```text
CommandRegistrationPort {
    applyCommandPlan(plan: CommandRegistrationPlan) -> CommandRegistrationResult
}

CommandRegistrationResult =
    { status: "applied", generation: string }
  | { status: "failed", error: CommandRegistrationError }
```

激活流程：

1. daemon 构建 next plan 和 next reverse map。
2. daemon 调用 platform registration port。
3. 只有 `status == "applied"` 且 `generation` 匹配 next plan 时，daemon 才把该 scope 的 active map 切到 next reverse map。
4. 任何失败、timeout、generation mismatch 或 partial apply，都保留旧 active map。
5. 如果没有旧 active map，该 scope 的 command dispatch fail-closed。

daemon 启动或重启时必须重新构建 plan 并 apply；远端 command 可能仍存在，但本地 active map 只有 apply 成功后才恢复。激活成功前该 scope dispatch fail-closed 是预期行为。

平台 native API 如果不提供 all-or-nothing 语义，adapter 必须把任一 planned command 的失败表示为 `status:"failed"`；不得在 partial success 后要求 daemon 激活 next map。Discord adapter 必须使用能表达期望全集的提交方式，例如 bulk overwrite，而不是只增量 create/upsert。

## Dispatch

平台收到 slash command 后，按 `message-protocol.md` 产出 `NormalizedEvent { type:"command" }`。`CommandPayload.name` 是用户触发的 platform-visible command name；daemon 用 active reverse map 解析 canonical command。

Dispatch 顺序：

1. platform context：用投递该事件的 platform instance 得到 `platformName` / `platformType`。
2. auth：按 `security/auth.md` 执行该 platform instance 的 allowlist。拒绝时不得查 command handler。
3. scope：用 `platformName`、`platformType` 和 `CommandPayload.registrationScope` 找到 active map。
4. reverse-map lookup：用 `CommandPayload.name` 精确查 `CommandRoute`。
5. owner dispatch：按 `CommandRoute.owner.type` 进入对应 owner handler。

Owner dispatch：

| Owner type | Dispatch target |
|---|---|
| `agent` | 先按 `config-routing.md` 选出 binding / agentName，再验证该 agent instance 的 owner 与 command owner 匹配 |
| `platform` | 对应 platform adapter 的 platform command handler |
| `daemon` | daemon command handler |

所有 miss 都 fail-closed，并写结构化日志。必须覆盖：

- active map 不存在
- command name 不在 reverse map
- event scope 与 active map scope 不匹配
- agent command 未命中 binding 或多重命中 binding
- route 命中的 agent owner 与 `agent` command owner 不匹配
- handlerKey 在对应 owner 中不存在

daemon 不得从 `codex-new` / `discord-reply-mode` 这类字符串中拆 owner 或 localName。

Agent command 的远端可见性是 registration scope 粒度，binding 是 channel 粒度。多 agent scope 中，用户可能看见某个 stable agent command 但在当前 channel route 到另一类 agent；这种情况必须以 `command_agent_owner_mismatch` fail-closed。

## `/new` First Slice

首批 agent commands：

| Descriptor | Stable name | Bare alias 条件 |
|---|---|---|
| `agent:codex:new` | `codex-new` | single-agent scope |
| `agent:claudecode:new` | `claudecode-new` | single-agent scope |

`new` 的语义是重置当前 route 命中的 agent conversation；如果用户同时提供 prompt，则重置后立即用该 prompt 开启新一轮。该语义由 agent command descriptor 声明，daemon handler 负责复用现有 session store / agent session lifecycle。

不得把 Claude Code 或 Codex 自身 TTY slash commands 直接透传为首批 agent-nexus slash command。后端 CLI 私有命令若要暴露，必须先补对应 backend contract 和安全边界。

## `/reply-mode` Migration

Discord reply mode command descriptor：

```text
CommandDescriptor {
    canonicalId: "platform:discord:reply-mode"
    owner: { type: "platform", platformType: "discord" }
    localName: "reply-mode"
    summary: "Query or switch the bot reply trigger mode"
    options: [
        {
            name: "mode"
            type: "string"
            required: false
            description: "New mode (omit to query current)"
            choices: [
                { name: "mention", value: "mention" }
                { name: "all", value: "all" }
            ]
        }
    ]
    handlerKey: "reply-mode"
    applicability: {
        platformTypes: ["discord"]
        requiredCapabilities: ["slash-command-registration", "ephemeral-response"]
    }
    legacyNames: [{ name: "reply-mode", reason: "historical-compatibility" }]
}
```

注册结果：

- stable `/discord-reply-mode`
- legacy `/reply-mode`

两者必须进入同一个 handler，保持现有授权、查询、切换与 state file 语义。legacy alias 移除前，Discord adapter 必须同时处理两个名字。

## 错误与日志

最低结构化错误码：

| 错误码 | 触发 |
|---|---|
| `command_descriptor_invalid` | descriptor 字段、canonical id 或 applicability 非法 |
| `command_name_collision` | 同 scope 内 command name 冲突 |
| `command_name_reserved` | alias 或 stable name 命中保留规则 |
| `command_registration_failed` | 远端注册失败或 partial apply |
| `command_activation_generation_mismatch` | registration result generation 与 next plan 不一致 |
| `command_active_map_missing` | 收到 command event 但 scope 没有 active map |
| `command_reverse_map_miss` | active map 中没有该 platform-visible name |
| `command_agent_owner_mismatch` | route agent owner 与 agent command owner 不一致 |
| `command_handler_missing` | owner 内找不到 handlerKey |

日志不得记录 raw platform payload、未脱敏 option 值或 secret。需要诊断时记录 `traceId`、`platformName`、`scope`、`commandName`、`canonicalId`、`aliasKind`、`generation`。

## 合约测试

P3-P5 必须覆盖：

- canonical id uniqueness 和 owner/localName 一致性。
- product/platform/active agent reserved prefix collision。
- historical reserved bare name 拒绝 agent alias。
- single-agent alias 生成；scope 从 single-agent 变 multi-agent 后 alias 移除。
- stable name 始终保留。
- required capability 过滤。
- remote registration failure 或 partial apply 保留旧 active map。
- stale generation result 不激活 active map。
- active map missing、reverse map miss、agent owner mismatch fail-closed。
- `/discord-reply-mode` 与 `/reply-mode` 都路由到 `platform:discord:reply-mode`。
- Claude Code / Codex descriptors 不 import platform package 或 platform naming utility。

## 反模式

- 从平台 command name 字符串拆 owner 或 handler。
- 在 agent package 中 import Discord SDK、platform package 或 platform naming policy。
- 在 platform package 中定义 agent command name policy。
- 让 CLI 生成 alias 或解释 handlerKey。
- 远端注册失败后切换本地 active map。
- 使用增量 upsert 导致已移除 alias 在远端残留。
- 新增 bare command name 作为用户友好短名。
- 移除 legacy alias 后释放 historical bare name 给 agent alias。
