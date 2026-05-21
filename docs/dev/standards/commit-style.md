---
title: Commit 与分支命名规范
type: standards
status: active
summary: Conventional Commits 格式、type 枚举、breaking change 写法、分支命名格式、commit 粒度合格条件、Co-Authored-By 标签
tags: [commit, standards, branch-naming, conventional-commits]
related:
  - dev/process/commit-and-branch
  - dev/standards/docs-style
---

# Commit 与分支命名规范

本文件定义 commit message、分支名作为产物的形态合格条件。**何时打 commit / 何时合分支 / 失败如何处理**等流程编排见 [`../process/commit-and-branch.md`](../process/commit-and-branch.md)。

## Conventional Commits

所有 commit 遵循 [Conventional Commits 1.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/)。

### 格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

- `type`：见下表
- `scope`：可选，模块或子系统名（`daemon` / `platform-discord` / `agent-claudecode` / `protocol` / `cli` / `docs` / `ci` / ...）
- `subject`：祈使句、小写开头、结尾不加句号
- `body`：解释**为什么**要做这个改动，而不是做了什么
- `footer`：Breaking change、关联 issue、Co-Authored-By 等

### Type 取值

| type | 用途 |
|---|---|
| `feat` | 新增功能 |
| `fix` | 修 bug |
| `docs` | 文档改动 |
| `refactor` | 不改行为的重构 |
| `perf` | 性能改进 |
| `test` | 只改测试 |
| `build` | 构建系统、依赖 |
| `ci` | CI 配置 |
| `chore` | 杂项（脚本、版本号、.gitignore 等） |
| `revert` | 回滚 |

### 示例

```
feat(adapter-discord): handle slash command dispatch

Discord slash command 事件需要映射到 NormalizedEvent 的 command 字段。
按 spec/platform-adapter.md §3.2 的字段表实现，并加合约测试。

Refs: docs/dev/spec/platform-adapter.md
Closes: #42
```

### Breaking change

在 footer 里用 `BREAKING CHANGE:` 或在 type 后加 `!`：

```
feat(daemon)!: change session key to include threadId

BREAKING CHANGE: session key 从 (platform, channelId, userId) 改为
(platform, channelId, threadId, userId)。所有 adapter 需要同步升级。
```

## 分支命名

```
<type>/<short-description>
```

- `type` 同 commit 的 type
- `short-description` 小写、短横线分隔
- 长度 ≤ 50 字符

示例：

- `feat/discord-slash-command`
- `fix/session-idempotency-race`
- `docs/update-spec-observability`

## Commit 粒度（合格条件）

- 一个 commit 只做**一件逻辑上的事**
- 新增功能 + 重构混在一个 commit 里——拆开
- 修 bug + 顺手改别的——顺手的部分不要做，或开独立 commit
- 纯格式化（缩进、换行）单独一个 commit

## Subject 语义合格条件

`<subject>` 必须承载完整 thesis ——**只看 git log 这一行**、没读 issue body、没参与改动 session 的读者，要能用一句话复述出这条 commit 做了什么。

squash merge 后 PR title 即落到 main 上的 commit subject，所以本节规则同时适用 PR title 与 commit subject。

### 不合格模式

| 不做 | 做 |
|---|---|
| `inline stopReasonToEnum + 加固 envelope→reason 测试覆盖` | 找统一动作覆盖；找不到 → 拆 commit / 拆 PR |
| `emoji-safe slicing + PartialSendError 保留 sentIds` | 同上（这条 `+` 通常还是 PR scope 该拆的信号） |
| `子进程句柄挂 session，interrupt / stopSession 真实生效` | 选 mechanism 或 outcome 之一作 subject |
| `钉死 UsageRecord.completeness 语义（选 A）` | 写实际选了什么（如 `按 $ 视图可信度三态判定`） |
| `partial textBuf 在异常退出时落日志（option C）` | 同上，把 option 字母换成实际方案描述 |
| `补 X 视角 + 反例` | 用承载 thesis 的强动词（如 `加可执行判据`） |

### 诊断信号

写完 subject 跑这套自检：

- **有 `+` / `、` / `,` / `；` 把两件事并列**：多半 thesis 没浓缩。问：两件事服务同一动作吗？是 → 用动作覆盖；不是 → **拆 commit / 拆 PR**（title 写不顺往往是 scope 该拆的信号，不只是写法问题）。
- **括号里有 `(选 A)` / `(option C)` 这种内部 reference**：把选项名换成实际选的内容。"选 A" 不传递语义，"按 $ 视图可信度三态判定" 才传递。
- **subject 里有刚发明的 framing 词或抽象名词**（"加固覆盖"、"冷上下文读者视角"等）：留给 body / doc，subject 用读者首读就能消化的具象内容。
- **想用"补 / 加固 / 完善 / 整理"等弱动词**：通常是 thesis 没找到，换强动词（`钉死` / `inline` / `禁` / `让 X 生效`）逼自己说清楚到底改了什么。

## Co-Authored-By

使用 AI 辅助生成的 commit，在 footer 加上对应的 Co-Authored-By 行，便于审计：

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Merge 阶段产物合格条件

PR 合入 main 时的产物形态判据：

- CI 全绿（unit + integration 必跑层全过；E2E / Eval 按 [`../process/tdd.md` §运行节奏与 CI 门槛](../process/tdd.md#运行节奏与-ci-门槛) 判定）
- 所有 commit message 符合本文件 §Conventional Commits + §Commit 粒度
- CHANGELOG 更新（若改动影响用户）
- 走 squash merge（按 [`../process/commit-and-branch.md` §合并策略](../process/commit-and-branch.md#合并策略)）

## Reviewer 拒绝条件

reviewer 在 PR 里看到下列模式应直接拒绝：

- commit message 不含 `<type>` 前缀或 `<type>` 不在上表枚举内
- subject 含句号、首字母大写或非祈使句
- `wip` / `temp` / `update` 等无信息量的 subject
- 未声明 breaking change 但实际改动破坏了对外契约
- 分支名不符合 `<type>/<short-description>` 格式或超过 50 字符
- 一个 commit 同时做了"新增功能 + 顺手重构"等多件逻辑事
- subject 用 `+` / `、` / `,` 把两件 mechanic 并列（违反 [§Subject 语义合格条件](#subject-语义合格条件)，多半 thesis 没浓缩或 PR 该拆）
- subject 含 `(选 A)` / `(option C)` 等只在 issue body 才有意义的内部 reference
- subject 含改动期间发明的 framing 词或抽象名词，未替换为具象内容
- AI 辅助生成的 commit 缺 `Co-Authored-By` footer
