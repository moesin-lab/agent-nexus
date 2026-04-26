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

本文件定义文档作为静态产物的形态价值标准（篇幅、章节模板、frontmatter、代码块、链接、图表、中英文混排）。某段内容该落到哪个 owner，见 [`doc-ownership.md`](doc-ownership.md)。"何时按本文件检查 / 失败如何处理"的流程编排见 `process/`。

## 元信息（YAML Frontmatter）

**所有 Markdown 文档必须**以 YAML frontmatter 起头。详细 schema 见 [`metadata.md`](metadata.md)。

合格条件：

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
- 顶层目录的新增 / 合并属于架构决策——走 ADR；ADR 通过后才动文件树

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
| `testing/*.md` | 80–300 行 | 80 行 |
| `standards/*.md` | 40–200 行 | 40 行 |
| `process/*.md` | 30–150 行 | 30 行 |
| `README.md`（目录索引） | 30–100 行 | 30 行 |

超出上限拆文件；低于下限说明内容不足以独立成篇，合并到相邻文件。流程文档可以很短（trigger / role / gate / failure handling 写完即止），不强行扩篇幅。

## 结构约定

按 owner 类型给章节模板。owner 语义见 [`doc-ownership.md`](doc-ownership.md)；本节只规定**呈现形态**，不重写 owner 准入禁入。

### spec 文档必含

承载契约事实的呈现形态：

1. 一句话**定位**（这个 spec 解决什么问题）
2. **字段表**或**接口伪代码**（语言无关）
3. **状态 / 语义**说明（生命周期、幂等、错误码）
4. **边界条件**（超时、并发、错误分支）
5. **反模式**（什么情况会误用契约）

### architecture 文档必含

承载组合事实的呈现形态：

1. 一句话**定位**（这份文档讲哪一层 / 哪一套组合）
2. **模块清单**与**依赖方向**（拓扑图或表）
3. **数据流 / 调用流**（按场景列）
4. 与外部 spec / ADR 的引用（只 link 不复述契约）

### ADR 必含

见 [`../adr/template.md`](../adr/template.md)。字段：Context / Options / Decision / Consequences / Out of scope。

### testing 文档必含

承载验证证据模型的呈现形态：

1. 一句话**定位**（要证明什么行为正确）
2. **测试层级**（unit / integration / e2e / eval）与各自覆盖目标
3. **fixture / 数据来源**与生成方式
4. **CI 触发条件**与门禁（链到 process）
5. **不测什么**（已知留白）

### standards 文档必含

承载价值标准的呈现形态：

1. 一段**原则陈述**——本标准要保护的属性
2. **做 / 不做对照表**或**准入 / 禁入清单**
3. **Reviewer 拒绝条件**（看到什么模式直接拒）

### process 文档必含

承载流程编排的呈现形态：

1. 一句话**触发条件**（什么时候走这套流程）
2. **角色与责任**（谁做、谁审）
3. **步骤序列**（每步对应哪份 standards / spec 的检查）
4. **失败处理**（任一步骤失败怎么办、谁负责修复）

process 文档**不写**做 / 不做对照、禁入清单、价值判据——这些是 standards 本体，process 只 link。

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

## 时效合格条件

- 文档与代码同 PR 改是合格条件；具体编排（何时检查、谁修复）见 `process/code-review.md`
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
| 重复定义同一规则 | 按 [ADR-0008](../adr/0008-doc-layering-ssot.md) 保留 owner，其他只引用 |
| emoji 装饰 | 纯文本 |
| 跳级标题 | 逐级嵌套 |
