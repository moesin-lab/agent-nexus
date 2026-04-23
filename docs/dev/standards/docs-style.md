---
title: 文档写作规范
type: standards
status: active
summary: 文档语言、目录命名、标题层级、篇幅、中英混排与写作风格规范
tags: [docs-style, standards]
related:
  - dev/standards/metadata
  - dev/README
---

# 文档写作规范

本项目文档的语言、结构、风格统一规则。

## 元信息（YAML Frontmatter）

**所有 Markdown 文档必须**以 YAML frontmatter 起头。详细 schema 见 [`metadata.md`](metadata.md)。

强制条款：

- 缺 frontmatter 的 PR 一律拒绝
- `title` / `type` / `status` / `summary` / `tags` / `related` 六项通用字段必填
- ADR 额外填 `adr_status` / `adr_number` / `decision_date` 等专属字段
- `summary` 一句话讲清这篇做什么，≤120 字
- `tags` 必须在 metadata.md 的词汇表内

目的：让 agent 与人类**渐进式读取**——先扫元信息再决定是否全读，避免上下文被无关文档污染。

## 语言

- 当前阶段**仅写中文**。
- 双语翻译推迟到 MVP 有产物时由 LLM 批量处理。
- 技术术语保留英文原文（API、token、session、TDD、ADR、spec），不强行翻译。

## 目录与命名

- 目录名全小写加短横线：`cost-and-limits.md`
- 不在文件名里用日期或编号，除非是 ADR（`0001-xxx.md` 格式）
- 每个目录有 `README.md` 作为该目录的索引
- 不新建顶层目录，需新增时先发 ADR 或本文件的改动 PR

## 标题层级

- 每篇文档只有一个 H1（`#`）
- 按 H2 → H3 → H4 逐级嵌套，不跳级
- 不用 H5 以下；如果需要 H5，说明内容应该拆成子文档

## 篇幅

| 文档类型 | 建议篇幅 | 下限 |
|---|---|---|
| `spec/*.md` | 100–400 行 | 100 行 |
| `architecture/*.md` | 80–300 行 | 80 行 |
| `adr/*.md` | 60–200 行 | 60 行 |
| `process/*.md` | 60–200 行 | 60 行 |
| `standards/*.md` | 40–150 行 | 40 行 |
| `README.md`（目录索引） | 30–100 行 | 30 行 |

超出上限拆文件；低于下限说明内容不足以独立成篇，合并到相邻文件。

## 结构约定

### spec 文档必含

1. 一句话**定位**（这个 spec 解决什么问题）
2. **字段表**或**接口伪代码**（语言无关）
3. **状态/语义**说明（生命周期、幂等、错误码）
4. **边界条件**（超时、并发、错误分支）
5. **反模式**（什么情况会误用）

### ADR 必含

见 [`../adr/template.md`](../adr/template.md)。字段：Context / Options / Decision / Consequences / Out of scope。

### process 文档必含

1. 核心原则（一段）
2. 具体步骤或清单
3. 做 / 不做对照
4. 反模式

### standards 文档必含

1. 原则一段
2. 做 / 不做对照表
3. 禁止清单

## 写作风格

### 做

- 直接、克制、无废话
- 技术事实、约束、风险
- 短段落（不超过 5 行），分点
- 用表格和清单代替长段落
- 外部链接写清楚是什么（`[Conventional Commits](url)` 而非裸 URL）

### 不做

- 不写"总结 / 综上所述 / 最后"式尾段
- 不写主观感叹（"非常强大"、"优雅"、"极其简洁"）
- 不写无信息量的过渡句（"下面我们来看 X"）
- 不写未定事项的承诺（"将来会支持 Y"）
- 不用 emoji（用户明确要求除外）

## 代码与伪代码

- 代码块必须标语言：` ```go ` / ` ```typescript ` / ` ```text `
- 伪代码用 ` ```text ` 或无标注
- 命令示例用 ` ```bash ` / ` ```shell `
- 超过 20 行的代码块考虑：能不能抽成独立例子文件

## 链接

- 文档内互链一律相对路径（`../spec/observability.md`）
- 不写永远在刷新的外链（"参见 StackOverflow 某回答"）
- 跨仓库引用用完整 URL

## 图表

- 优先 ASCII 图（易 diff、易 review）
- 必要时用 Mermaid 嵌入 Markdown（GitHub 原生渲染）
- 不提交 PNG/JPG 截图作为规范内容（可以作为辅助放在 PR 描述，不进仓库）

## 更新节奏

- 文档与代码同 PR 改
- 文档落后于代码超过 24 小时视为 bug
- 过期文档**删除**或**标注 Deprecated**，不留在那里混淆读者

## 中英文混排

- 中文与英文、数字之间加空格：`使用 Claude Code CLI`，不是 `使用Claude Code CLI`
- 代码、路径、命令不加空格（Markdown backtick 自然隔开）
- 标点用中文全角（`。`、`，`、`：`），除非在代码或英文短语内部

## 做 / 不做总表

| 不做 | 做 |
|---|---|
| 长段落 | 分点列表 |
| 空洞描述 | 具体字段、数字、路径 |
| "将来会支持 X" | 什么时候支持就什么时候写 |
| 重复定义同一规则 | 一处定义，其他引用 |
| emoji 装饰 | 纯文本 |
| 跳级标题 | 逐级嵌套 |
