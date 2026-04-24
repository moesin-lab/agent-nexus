> 本文件是 `docs/dev/process/pre-decision-analysis/README.md` 的组件，agent-agnostic。
> Claude Code 通过 `skills/pre-decision-analysis/` 引用；其他 harness 可同样引用。

# scratch 输出模板

**何时用**：仅在 scratch 硬触发场景（见 `pre-decision-analysis/README.md` "Scratch 硬触发"）才起 scratch 时，首次起草对照本模板。默认不起 scratch，走 PR diff 后审。

## 核心规范

**固定的只有 slot 格式和段边界**，段内内容形式完全放开——可以用小节、列表、表格、代码块、引用块，按问题类型自由组织。但每段必须能独立被 review。

## 文件骨架

```markdown
# <topic>：<一句话要决策什么>

> 本文件是 scratch（`.tasks/*.scratch.md` 已 gitignore，不入库）。
> 目的：<review / options / plan / survey / debate>。
> 决策者：人类。主 agent 只给分析与建议。

---

## 段 1：<自由标题>

<正文形式不限：小节 / 列表 / 表格 / 代码块 / 引用>

**想问你**（可选，当 agent 对本段有明确拿不准的点时加）：

- <定向问题 1——具体、可选项、带默认建议>
- <定向问题 2>

<!-- REVIEW 段 1：

-->

---

## 段 2：<自由标题>

<正文>

<!-- REVIEW 段 2：

-->

---

（...更多段）

---

<!-- REVIEW 总体意见（格式自由）：

-->
```

## "想问你" 块的用法

段末的"想问你"块是给用户的**定向引导**——当 agent 对本段存在明确的 ambiguity、希望用户在 slot 里针对性回答时埋入。比纯开放 slot 更利于用户落笔。

好的定向问题特征：

- **具体**：问"采用 A 还是 B"而不是"你怎么看"
- **带选项**：列 2-3 个候选让用户挑，而不是完全开放
- **带默认建议**：如果 agent 有倾向，标出来（"倾向 A，因为……"）
- **1-2 个足够**：多了用户会挑不过来

反例：

- ❌ "这段你觉得怎么样？"（太开放）
- ❌ "同意我的分析吗？"（rubber stamp 诱导）
- ❌ 一段里塞 5 个问题

不是每段都必须有"想问你"——只在确实需要定向反馈时加。纯事实描述段（"段 1：目前现状"）不需要。

## slot 格式强制

- slot 标签行（`<!-- REVIEW 段 N：`）与 `-->` 之间**至少一个空行**（给用户落笔空间）
- slot **前后各一个空行**，不挤在紧挨文本里
- 段与段之间用 `---` 分隔
- 文件末尾追加**一个**总体意见 slot，供跨段综合判断

## 命名

- `<topic>`：对象的短名，连字符分隔，如 `agentic-engineering-framework` / `promote-pre-decision-analysis`
- `<purpose>` ∈ `review` / `options` / `plan` / `survey` / `debate`
- 对应 `.gitignore`：`.tasks/*.scratch.*` 必须命中；缺失则先补 gitignore 再起草
