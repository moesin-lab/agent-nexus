---
title: 开发文档中心
type: index
status: active
summary: 开发文档六大支柱（architecture/adr/spec/process/testing/standards）的索引与阅读顺序
tags: [navigation, dev-docs]
related:
  - docs/README
  - dev/architecture/overview
  - dev/adr/README
  - dev/spec/README
  - dev/process/workflow
---

# 开发文档中心

面向**实现者**。本中心是本项目当前阶段的文档主线，其他中心（`product/`、`ops/`）仅占位。

## 六大支柱

开发文档由六个独立但互相引用的部分组成。各部分职责严格分离：

| 目录 | 职责 | 读者的核心问题 |
|---|---|---|
| [`architecture/`](architecture/) | 系统设计与分层 | 代码整体怎么组织？谁依赖谁？ |
| [`adr/`](adr/) | 架构决策记录 | 为什么这么做？考虑过什么替代方案？ |
| [`spec/`](spec/) | 接口契约与协议 | 模块之间交换什么数据？签名是什么？ |
| [`process/`](process/) | 开发流程规范 | 我该怎么做事？PR 流程是什么？ |
| [`testing/`](testing/) | 测试策略 | 我该写什么测试？在哪一层？ |
| [`standards/`](standards/) | 代码与文档规范 | 该怎么写日志/错误/文档？ |

每条规则只在一个地方被**定义**，其他地方只能**引用**。发现重复定义或冲突，视为文档 bug。

## 渐进式读取（YAML Frontmatter）

所有文档顶部有 YAML frontmatter 元信息，方便 agent 与人类先扫元信息再决定是否全读：

```yaml
---
title: <标题>
type: architecture | adr | spec | process | standards | testing | product | ops | index | root | task
status: active | draft | placeholder | deprecated
summary: <一句话 ≤120 字>
tags: [...]
related: [...]       # 相对 docs/ 的路径
---
```

ADR 和 spec 有专属扩展字段。完整 schema 见 [`standards/metadata.md`](standards/metadata.md)，强制要求见 [`standards/docs-style.md`](standards/docs-style.md)。

**读取方式（强制）**：项目文档一律通过 `scripts/docs-read <path>` 读取，不得直接 `Read`。脚本按 frontmatter 状态控制返回内容；active 返回全文，superseded / deprecated / placeholder 只返回 frontmatter + 告警。详见 [`../../AGENTS.md`](../../AGENTS.md) §"读文档的防污染规则"。

**使用建议**（给 agent）：

- 派发子任务时把读文档动作替换成 `Bash: scripts/docs-read <path>`
- 查找相关文档时先看 frontmatter 的 `summary` + `tags`，命中再全读
- 顺 `related` 链条探索上下文
- 遇到脚本返回退出码 2 → 看告警里的替代文档指引（如 `superseded_by`）

## 推荐阅读顺序

### 第一次进入项目

1. `architecture/overview.md` — 看整体拓扑与数据流
2. `adr/README.md` → 依次读 `0001`–`0004` — 理解为什么是 Discord、CC CLI、本机桌面
3. `process/workflow.md` — 了解从想法到合并的完整路径
4. `spec/platform-adapter.md` + `spec/agent-runtime.md` + `spec/message-protocol.md` — 掌握三大接口契约
5. 其余按需查阅

### 开始写代码前

1. `process/workflow.md` — 确认当前改动属于哪条路径
2. `process/tdd.md` — 决定从哪个测试开始
3. `testing/strategy.md` — 决定在哪一层写测试
4. `standards/` — 查代码/日志/错误规范

### 做架构级改动前

1. `adr/README.md` → `adr/template.md` — 起新 ADR
2. `architecture/dependencies.md` — 确认改动不违反依赖方向
3. 写完 ADR 先走 [`process/code-review.md`](process/code-review.md) 的评审流程

## 六大支柱的相互引用规则

- `spec/` 引用 `architecture/`（契约基于架构设计），**不反向**
- `standards/` 引用 `spec/`（例如 `standards/logging.md` 按 `spec/observability.md` 的字段）
- `testing/` 引用 `spec/` 与 `architecture/`（测试按契约写断言）
- `process/` 引用其他所有（流程把各部分串起来）
- `adr/` 可被任何部分引用；ADR 自身只引用其他 ADR

## 不做的事

- 不把使用手册放进 `dev/`（放 `product/`）
- 不把部署脚本的说明放进 `dev/spec/`（放 `ops/` 或 `product/`）
- 不在 spec 里预设实现语言（spec 必须语言无关）
- 不在 architecture 里写具体代码片段（写伪代码或字段表）
