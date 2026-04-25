---
title: TDD（测试驱动开发）
type: process
status: active
summary: 本项目强制 TDD 的理由与 Red-Green-Refactor 节奏、探针例外与反模式
tags: [tdd, testing, process]
related:
  - dev/process/workflow
  - dev/testing/strategy
  - dev/testing/fixtures
---

# TDD（测试驱动开发）

本项目**强制** TDD。理由不是教条，而是：

1. 缺测试时每次改动都是赌博，回归只能靠"祈祷"。
2. LLM 生成代码速度快但易漂移，测试是最稳的防护栏。
3. 先写测试逼你先想清楚接口。

## Red-Green-Refactor

```
Red      → 写一个**会失败**的测试，确认它确实失败
Green    → 写**最小**实现让它通过，不做多余事
Refactor → 在测试保持绿的前提下，整理代码与命名
```

循环粒度要小：每一轮 5–20 分钟。如果一轮超过 30 分钟，多半是粒度过大，拆。

## 何时写哪一层的测试

按 [`../testing/strategy.md`](../testing/strategy.md) 的四层模型选择：

- **新增函数/类** → 单元测试先行
- **模块间交互** → 集成测试先行（例如 adapter ↔ core）
- **端到端流程** → e2e 用真实 CC CLI + mock Discord；但不是每个功能都要 e2e
- **对话质量** → eval；当且仅当改动影响 agent 提示或工具集

## 允许的例外：探针（exploratory spike）

有时你不知道接口该长什么样，允许先写一段"探针代码"跑通 happy path：

- 探针代码放在 `spikes/` 或 PR 描述里，**不合并到主干**
- 跑通后丢弃探针，按 Red-Green-Refactor 重写
- 探针不能超过半天；超过说明问题要先拆

探针不是"先写实现再补测试"的借口。区别：探针会被丢弃重写，"先写实现"不会。

## 反模式

### 事后补测试

"我先写完功能，测试马上补"——绝对禁止。事后补的测试几乎必然只测通路不测错路，且会按现有实现来写断言（循环论证）。

### 过度 mock

一个测试 mock 了 5 个依赖，只剩 1 个真实对象——这测不到任何业务逻辑。规则：

- 单元测试：mock 外部 I/O（网络、磁盘、时钟）
- 集成测试：只 mock 系统边界（Discord API、CC CLI 子进程），内部全真
- e2e：除 Discord 外全真

### 测实现细节

测试里断言"调用了哪个私有方法几次"——这种测试只要重构就挂。规则：

- 断言**对外行为**：输出、副作用、错误类型
- 不断言调用顺序、私有字段、私有方法名

### 一个测试测 10 件事

一个测试只验证一个命题。命名直接：`should_<行为>_when_<条件>`。

### 跳过/注释测试

永远不 skip，永远不注释。测试挂了要么修代码要么修测试；跳过等于删除。

## 断言写法

好断言回答三个问题：

1. 输入是什么？（Given）
2. 执行了什么？（When）
3. 期望什么结果？（Then）

例（伪代码）：

```
// Given: 一个已满载的 session 预算
session := newSession(tokenBudget=1000, used=950)

// When: 收到会超预算的 LLM 调用请求
err := session.requestLLMCall(estimatedTokens=100)

// Then: 应返回 BudgetExceeded 错误，且 session 状态标为 Halted
assert err == ErrBudgetExceeded
assert session.state == Halted
```

## 测试文件与被测文件的对齐

- 测试文件命名和位置必须能**一眼对应**到被测文件（具体规则由 ADR 0004 语言定后细化）
- 一个被测文件可以有多个测试文件（按场景拆）
- 测试文件只测它对应的被测文件；跨模块的放集成测试

## 覆盖率

不追求覆盖率数字。覆盖率是**结果**不是目标。但：

- 关键路径（消息流、错误处理、脱敏、限流）覆盖率必须接近 100%
- 新增代码未被测试覆盖，review 时要追问为什么

## 与 spec 的关系

- 每个 spec 文件的"接口契约"部分，应有对应的合约测试（contract test）
- 合约测试是单元测试的一种，断言"实现符合 spec 的字段、语义、错误码"
- spec 改动时，合约测试同 PR 改

## 反复出错的 checklist

- [ ] 是否先跑了一次确认测试确实失败？
- [ ] 是否写了**最小**实现通过测试？（不做多余的事）
- [ ] refactor 后测试还绿吗？
- [ ] 是否 mock 了不该 mock 的东西？
- [ ] 测试名是否清楚表达了"在什么条件下期望什么行为"？
- [ ] 合并前整个测试套是否都绿？
