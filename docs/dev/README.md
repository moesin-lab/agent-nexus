---
title: 开发文档中心
type: index
status: active
summary: 开发文档目录（architecture/adr/spec/process/testing/standards）的索引、主判定轴与阅读顺序
tags: [navigation, dev-docs]
related:
  - README
  - dev/architecture/overview
  - dev/adr/README
  - dev/spec/README
  - dev/process/workflow
---

# 开发文档中心

面向**实现者**。本中心是本项目当前阶段的文档主线，其他中心（`product/`、`ops/`）仅占位。

## 目录分类

开发文档按主判定轴组织。分类冲突时，以 [`process/doc-layering.md`](process/doc-layering.md) 的 owner 判定与冲突裁决为准。

| 目录 | 主判定轴 | 读者的核心问题 |
|---|---|---|
| [`architecture/`](architecture/) | 组合事实 | 代码整体怎么组织？谁依赖谁？ |
| [`adr/`](adr/) | 决策依据 | 为什么这么做？考虑过什么替代方案？ |
| [`spec/`](spec/) | 契约事实 | 模块之间交换什么数据？签名是什么？ |
| [`process/`](process/) | 编排事实 | 什么时候做？谁负责？门禁怎么触发？ |
| [`testing/`](testing/) | 验证证据模型 | 用什么测试、fixture、eval、CI 证据证明正确？ |
| [`standards/`](standards/) | 静态产物形态 | 代码、日志、错误、文档应该怎么写？ |

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

**读取方式**：active 路径下的文档（含 `placeholder` 骨架）可直接 `Read`；归档路径（`docs/dev/adr/deprecated/` / `docs/_deprecated/`）和外部导向文档（仓库根 `README.md` / `CONTRIBUTING.md`）的 `Read` 由 hook 拦截，需走 `scripts/docs-read --force`。

完整规则见 [`../../AGENTS.md`](../../AGENTS.md) §"读文档的防污染规则"；机制细节（三模式、作废工作流、hook 集成）见 [`process/docs-read.md`](process/docs-read.md)。

**使用建议**（给 agent）：

- 派发子任务时把读文档动作替换成 `Bash: scripts/docs-read [mode] <path>`
- 进项目后先 `--head` 扫几份关键文档 summary 建立心智再选性全读
- 顺 `related` 链条探索上下文
- 默认模式遇到退出码 2 → 看告警里的替代文档指引（如 `superseded_by`），再决定切 `--force` 读历史还是改读取代者

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

## 目录间引用规则

- `spec/` 引用 `architecture/`（契约基于架构设计），不反向复述接口细节
- `standards/` 引用 `spec/`（例如 `standards/logging.md` 按 `spec/observability.md` 的字段）
- `testing/` 引用 `spec/` 与 `architecture/`（测试按契约写断言）
- `process/` 引用其他所有（流程只编排何时检查，不复述被检查规则）
- `adr/` 可被任何部分引用；ADR 自身只引用其他 ADR

## 不做的事

- 不把使用手册放进 `dev/`（放 `product/`）
- 不把部署脚本的说明放进 `dev/spec/`（放 `ops/` 或 `product/`）
- 不在 spec 里预设实现语言（spec 必须语言无关）
- 不在 architecture 里写具体代码片段（写伪代码或字段表）
