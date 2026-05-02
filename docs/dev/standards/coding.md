---
title: 编码规范（语言无关部分）
type: standards
status: active
summary: 命名、函数长度、模块边界、注释、依赖与泛化时机的语言无关原则
tags: [coding, standards]
related:
  - dev/standards/errors
  - dev/standards/logging
  - dev/architecture/dependencies
---

# 编码规范（语言无关部分）

具体语法规范（格式化、lint 规则、类型系统用法）等 ADR 0004 语言选型后补独立文件（例如 `coding-ts.md` / `coding-go.md`）。本文件只讲跨语言的原则。

## 命名

- 名字要**说清楚这个东西做什么**，不要说清楚它是什么类型（避免匈牙利命名）
- 模块/包名用名词，函数名用动词
- 测试名用完整短句：`should_<行为>_when_<条件>`
- 布尔变量前缀用 `is` / `has` / `should` / `can`
- 常量用大写加下划线，或语言惯例

### 做 / 不做

| 不做 | 做 |
|---|---|
| `func DoStuff()` | `func dispatchDiscordEvent()` |
| `data: map` | `sessionsByKey: map` |
| `flag: bool` | `isIdempotencyChecked: bool` |
| `TestFoo` | `should_reject_duplicate_messageId_when_seen_within_window` |

## 函数长度

- 默认 ≤ 50 行。超过要有理由（有限状态机、表驱动）
- 一个函数只做一件事；做两件事拆成两个

## 模块边界

- 每个模块有**一个对外入口**（index / mod.rs / package-level export），其他文件皆内部
- 跨模块只通过对外入口交互，不 import 另一模块的内部文件
- 循环依赖直接拒绝合并

## 错误处理

见 [`errors.md`](errors.md)（owner）。

## 日志

见 [`logging.md`](logging.md)（owner）；字段契约见 [`../spec/infra/observability.md`](../spec/infra/observability.md)；禁止打印项见 [`../spec/security/redaction.md`](../spec/security/redaction.md)。

## 注释

默认**不写注释**，只在下列情况写：

- 为什么这么做的理由（非显而易见的权衡、历史包袱）
- 外部约束（协议要求、三方 bug workaround）
- TODO / FIXME 必须带 issue 编号：`// TODO(#42): ...`

### 做 / 不做

| 不做 | 做 |
|---|---|
| `// 发送消息` 之前是 `send(msg)` | 不加（代码自己说清楚了） |
| `// hack: 因为 XX API 返回不一致这里绕一下` | 好的——解释了 why |
| `// 用于后续可能的 Y 功能` | 不加（YAGNI） |

## 依赖

- 新增任何三方依赖都需要在 PR 描述里说明替代方案和选择理由
- 大类依赖（IM SDK、Agent SDK、数据库）必须先发 ADR
- 禁止引入已知不活跃、或单一维护者、或许可证不兼容的依赖

## 泛化时机

- 出现**第一次重复**：不抽象，先 copy
- 出现**第二次重复**：考虑抽象，但先写下来为什么要抽象
- 出现**第三次重复**：抽象

过早抽象比过晚抽象代价高得多。

## 模块深度评估

判断一个抽象（模块、接口、包装层、文件拆分）是否值得存在，看两个收益：

- **Leverage（杠杆）面向 caller**：小接口背后压住大量行为，调用方写更少代码。
- **Locality（局部性）面向 maintainer**：与这个概念相关的所有变更、bug、必备知识汇在一处——出问题在一处看，改需求在一处改。

深模块两份都赚；浅模块（pass-through、纯 wrapper）两份都没；最阴险的是"为测试性抽出的纯函数"——单测漂亮，bug 却躲在 caller 怎么把参数喂进来，locality 反而下降，debug 时跨文件追。

## 加抽象前的 Deletion test

新增任何包装层、小函数抽出、文件拆分、facade 前，问自己：**假想删掉它，复杂度消散还是扇出到 N 个 caller？** 消散 = pass-through，别加；扇出 = 真在收复杂度，加。

特别警惕"为测试性抽出的纯函数"：单测漂亮，bug 却躲在 caller 怎么把参数喂进来，抽完反而要跨文件追 bug。这种情况下测真实接线（integration test through the seam），而不是抽纯函数。

例外：契约先行的 spec 接口（`PlatformAdapter` / `AgentRuntime` 等）由 ADR 决定形状，不走此判据。

reviewer 可据此直接拒稿——"过不了 deletion test"是合法的 review 理由。

## 可见性

- 默认最小可见性（private > package > public）
- 提升可见性前反问一遍：真的要对外吗？有没有更小的暴露方式？

## 不可变优先

- 默认不可变，可变要有理由
- 函数优先返回新值而非 mutate 参数
- 例外：性能关键路径、明确文档化的 in-place mutator

## 并发

具体模型语言相关，通用原则：

- 共享状态默认加保护
- 避免嵌套锁
- 长期持有锁做 I/O 是 bug
- 超时必须显式设置，没有"永远等"

## 禁止

- 魔法数字、魔法字符串散落各处（抽成命名常量）
- `if` / `switch` 覆盖所有可能分支后还写 `default`/`else` 兜底 panic（除非是 enum 语义）
- 复制粘贴的代码块超过 5 行
- 函数参数超过 5 个（改用结构体）
- 任何形式的"只在生产环境不走"的分支（除非是 feature flag 显式机制）

## Review 反馈处理优先级

见 [`review.md`](review.md)。
