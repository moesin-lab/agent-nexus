---
title: 文档元信息（YAML Frontmatter）
type: standards
status: active
summary: 所有文档必须带的 YAML frontmatter schema；通用 6 字段 + ADR/spec 专属扩展、tag 词汇表
tags: [docs-style, standards, metadata]
related:
  - dev/standards/docs-style
---

# 文档元信息（YAML Frontmatter）

所有进入 `docs/` 与仓库根的 Markdown 文档**必须**以 YAML frontmatter 起头。目的：让 agent 与人类可以**渐进式读取**——先扫元信息判断相关性，再决定是否全读。

## 通用字段（所有文档必填）

```yaml
---
title: <中文标题>                        # 人类可读；可与文档 H1 一致或更简
type: <类型>                             # 见下方枚举
status: <状态>                           # active | draft | placeholder | deprecated
summary: <一句话摘要>                    # ≤120 字；能独立回答"这篇讲什么"
tags: [<tag1>, <tag2>, ...]              # 主题标签，小写短横线
related:                                 # 相关文档，相对 docs/ 的路径去 .md
  - <path1>
  - <path2>
---
```

### type 枚举

| 值 | 对应目录 | 含义 |
|---|---|---|
| `index` | 任一 `README.md` | 导航/索引页 |
| `architecture` | `dev/architecture/` | 架构设计 |
| `adr` | `dev/adr/` | 决策记录 |
| `spec` | `dev/spec/` | 接口契约 |
| `process` | `dev/process/` | 开发流程 |
| `standards` | `dev/standards/` | 代码/文档规范 |
| `testing` | `dev/testing/` | 测试策略 |
| `product` | `docs/product/` | 使用者文档 |
| `ops` | `docs/ops/` | 运维文档 |
| `root` | 仓库根 | README / AGENTS / CONTRIBUTING 等 |
| `task` | `.tasks/` | 任务追踪（非公开文档） |

### status 取值

| 值 | 含义 |
|---|---|
| `active` | 当前生效，内容可信 |
| `draft` | 写作中，不稳定 |
| `placeholder` | 仅占位，内容空或纯骨架 |
| `deprecated` | 已废弃，保留供历史追溯 |

ADR 有独立的 `adr_status`，见下文。

### summary 写作要点

- 一句话，≤120 字
- 独立可读（不依赖标题）
- 说**做什么 / 定义什么**，不说"本文档介绍 X"这种废话
- 例：`IM 适配层对外接口契约与 Discord 到归一化事件的映射规则`

### tags 约定

- 全小写、英文短横线分隔
- 3–6 个为宜，太多稀释意义
- 从下方词汇表选；确有必要再新增并在本文件登记

### related 写法

- 相对 `docs/` 的路径（`dev/spec/message-protocol`）
- 根文档的引用写 `root/README`、`root/AGENTS` 等（虚拟前缀）
- 按强弱排序：强相关在前

## ADR 专属追加字段

```yaml
adr_status: Accepted                    # Proposed | Accepted | Deprecated | Superseded
adr_number: "0001"                      # 字符串，保留前导零
decision_date: 2026-04-22
supersedes: null                        # 被本 ADR 取代的编号；或 "0000"
superseded_by: null                     # 取代本 ADR 的编号
```

注意 `status` 与 `adr_status` 不冲突：

- `status`（通用）：文档本身是否可读、是否占位
- `adr_status`（ADR 专属）：决策本身的状态

一个 Deprecated 的 ADR 通常 `status: active`（文档仍可读）+ `adr_status: Deprecated`。同理，一个 Superseded 的 ADR 仍保留 `status: active`——ADR 的"被取代"由 `adr_status: Superseded` + 所在归档目录（`docs/dev/adr/deprecated/`）共同表达，`status` 字段不引入 `superseded` 值。

**归档路径下的 `status` 允许保持 active**：文档一旦位于 `docs/dev/adr/deprecated/` 或 `docs/_deprecated/` 下，路径本身就是"已作废"的信号（见 `AGENTS.md` §读文档的防污染规则）；frontmatter `status` 字段在归档路径下变为冗余，维持 active 不影响语义。这样 `status` 字段的允许值保持稳定（`active|draft|placeholder|deprecated`），不需要为 ADR 的 Superseded 语义再扩展。

## spec 专属追加字段

```yaml
contracts:                              # 本 spec 定义的对外契约名
  - PlatformAdapter
  - OutboundMessage
```

"契约"指代码里暴露的接口/类型名；用于 agent 按名称反查所属 spec。

## 其他类型的扩展

未来若其他类型（如 testing、process）出现稳定的专属字段需求，在本文件登记新字段 schema，**不允许**各文档自由发挥。

## 刻意不加的字段

- **id**：文档相对 `docs/` 的路径已是稳定 ID，冗余
- **audience**：目录结构（`dev/` / `product/` / `ops/`）已表达，冗余
- **author / updated / version**：git 元数据更权威，手工维护必漂移
- **priority / importance**：主观字段，易失控

## 标签词汇表

维护一份收敛的 tag 列表，避免近义词（`session` vs `sessions` vs `conversation`）。

### 架构与核心概念

- `architecture`, `layering`, `dependencies`
- `session`, `session-model`, `lifecycle`
- `idempotency`, `ordering`, `concurrency`

### 集成侧

- `discord`, `platform-adapter`, `gateway`
- `cc-cli`, `claude-code`, `agent-runtime`, `subprocess`
- `message-protocol`, `normalized-event`

### 横切

- `observability`, `logging`, `tracing`, `metrics`
- `security`, `auth`, `allowlist`, `redaction`, `secrets`
- `persistence`, `sqlite`, `storage`
- `rate-limit`, `budget`, `cost`, `circuit-breaker`

### 流程与规范

- `workflow`, `tdd`, `code-review`, `subagent`, `commit`, `release`
- `coding`, `errors`, `docs-style`

### 测试

- `testing`, `fixtures`, `eval`

### ADR / 决策

- `adr`, `decision`, `language-runtime`, `deployment`

### 产品 / 运维

- `product`, `user-guide`, `faq`
- `ops`, `runbook`

新增 tag 前先查词汇表；必须新增时在此追加。

## 示例

### 架构文档

```yaml
---
title: 架构总览
type: architecture
status: active
summary: agent-nexus 的三层结构、数据流、横切关注点与禁止的架构反模式
tags: [architecture, layering, session, discord, cc-cli]
related:
  - dev/architecture/session-model
  - dev/architecture/dependencies
  - dev/spec/platform-adapter
  - dev/spec/agent-runtime
---
```

### ADR

```yaml
---
title: MVP IM 平台选型——Discord
type: adr
status: active
summary: 选择 Discord 作为 MVP 首个 IM 平台，理由是个人场景下 SDK 最齐、交互模型最贴合
tags: [adr, decision, discord, platform-adapter]
related:
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/adr/0003-deployment-local-desktop
  - dev/spec/platform-adapter
adr_status: Accepted
adr_number: "0001"
decision_date: 2026-04-22
supersedes: null
superseded_by: null
---
```

### Spec

```yaml
---
title: Platform Adapter 接口
type: spec
status: active
summary: IM 平台适配层接口契约，规定事件归一化、发送能力、能力声明
tags: [spec, platform-adapter, discord, normalized-event]
related:
  - dev/spec/message-protocol
  - dev/architecture/overview
contracts:
  - PlatformAdapter
  - OutboundMessage
  - MessageRef
  - CapabilitySet
---
```

### 占位文档

```yaml
---
title: 用户指南
type: product
status: placeholder
summary: 用户侧安装、配置、使用指南；等 MVP 可运行后填写
tags: [product, user-guide]
related:
  - root/README
---
```

## 读取规则

2026-04 重构后，防污染主责已从"所有 docs 都必须走 docs-read"下放到**路径层**：作废文档物化到归档目录（`docs/dev/adr/deprecated/` / `docs/_deprecated/`），active 路径下的文档可直接 `Read`。

完整规则见 [`../../../AGENTS.md`](../../../AGENTS.md) §"读文档的防污染规则"；`scripts/docs-read` 三模式（`--head` / `--force` / 默认兜底）与作废工作流、hook 集成等细节见 [`../process/docs-read.md`](../process/docs-read.md)。

## 校验（后续工具化）

MVP 阶段 frontmatter 由人类与 agent 手动维护；未来可加脚本校验：

- frontmatter 存在
- 必填字段齐全
- `type` / `status` / `adr_status` 在枚举内
- `tags` 在词汇表内（或已登记新增）
- `related` 路径存在
- ADR 文件名 `<adr_number>-...` 与 frontmatter 一致

`scripts/docs-read` 是工具化的第一步（运行时读取过滤）；后续可追加 `scripts/docs-lint` 做提交前校验。具体实现的更完整版本等 ADR-0004 语言选型后再定。

## 反模式

- 把标题写成 `"这是一份讲 XX 的文档"`（冗余、不要）
- 拿一堆 tag 凑数（3–6 个够用）
- 在 `summary` 里写"本文档介绍..."（直接讲内容）
- 用 `updated: 2025-xx-xx` 手维护日期（git 管这件事）
- 新增没登记的 tag（先登记再用）
- ADR 在 `adr_status` 里写 `In Progress` 之类自创状态（枚举不可扩）
- `related` 塞进无关文档（按强弱过滤）
