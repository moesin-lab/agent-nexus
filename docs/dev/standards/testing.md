---
title: 测试合格条件
type: standards
status: active
summary: 测试代码的产物形态价值标准——探针例外、反模式、断言写法、命名与位置、覆盖率政策、合约测试合格条件
tags: [testing, standards, tdd, anti-patterns]
related:
  - dev/adr/0009-tdd-mandatory
  - dev/process/tdd
  - dev/testing/strategy
  - dev/testing/fixtures
---

# 测试合格条件

定义测试代码的产物形态合格条件——什么样的测试算合格、什么样不合格。

**Red-Green-Refactor 节奏 / 何时跑测试 / CI 失败处理**等流程编排见 [`../process/tdd.md`](../process/tdd.md)；**测试分层 / mock 边界 / 各层目标**等验证证据模型见 [`../testing/strategy.md`](../testing/strategy.md)。本文件只承载"测试本身长什么样才算合格"的标准本体。

## 探针例外（exploratory spike）

允许在不知道接口形态时先写一段探针代码跑通 happy path，但探针**不是**"先写实现再补测试"的借口。区别：探针会被丢弃重写，"先写实现"不会。

合格条件：

- 探针代码放在 `spikes/` 目录或 PR 描述里
- **不合并到主干**
- 跑通后丢弃，按 Red-Green-Refactor 重写
- 单次探针 ≤ 半天；超过说明问题要先拆

reviewer 看到 `spikes/` 之外的探针残留，或 PR 同时合入"探针 + 实现"——直接拒。

## 反模式

### 事后补测试

"我先写完功能，测试马上补"——禁止。事后补的测试几乎必然只测通路不测错路，且会按现有实现来写断言（循环论证）。

reviewer 验收方式：检查 commit 历史是否先有 failing test commit；如果实现 commit 在前测试在后，要求拆分重做。

### 过度 mock

一个测试 mock 了 5 个依赖，只剩 1 个真实对象——这测不到任何业务逻辑。合格的 mock 边界：

- **单元测试**：mock 外部 I/O（网络、磁盘、时钟）
- **集成测试**：只 mock 系统边界（Discord API、CC CLI 子进程），内部全真
- **e2e**：除 Discord 外全真

### 测实现细节

测试里断言"调用了哪个私有方法几次"——这种测试只要重构就挂。合格断言：

- 断言**对外行为**：输出、副作用、错误类型
- 不断言：调用顺序、私有字段、私有方法名

### 一个测试测 10 件事

一个测试只验证一个命题。多命题在一个测试里合并 → 失败时无法 binary 判定哪条命题挂了。

### 跳过 / 注释测试

永远不 skip，永远不注释。测试挂了要么修代码要么修测试；跳过等于删除。`@skip` / `xtest` / `it.skip` / 注释整段测试代码——reviewer 看到即拒。

## 断言写法

好断言回答三个问题：

1. **Given**——输入是什么？
2. **When**——执行了什么？
3. **Then**——期望什么结果？

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

## 测试命名

- 测试名用完整短句：`should_<行为>_when_<条件>`
- 不许 `TestFoo` / `test1` / `it_works` 这类无信息量命名
- reviewer 看到模糊命名要求改

## 测试文件与被测文件的对齐

- 测试文件命名和位置必须能**一眼对应**到被测文件（具体规则待 ADR-0004 语言定后细化）
- 一个被测文件可以有多个测试文件（按场景拆）
- 测试文件只测它对应的被测文件；跨模块的放集成测试

## 覆盖率政策

不追求覆盖率数字。覆盖率是**结果**不是目标。但：

- **关键路径**（消息流、错误处理、脱敏、限流）覆盖率必须接近 100%
- 新增代码未被测试覆盖，review 时要追问为什么；作者必须给出非"懒得写"的理由
- 单纯刷覆盖率数字而不增加断言强度的测试 → 拒

## 与 spec 的关系（合约测试）

- 每个 spec 文件的"接口契约"部分，应有对应的合约测试（contract test）
- 合约测试是单元测试的一种，断言"实现符合 spec 的字段、语义、错误码"
- spec 改动时，合约测试同 PR 改

## Reviewer 拒绝条件

reviewer 在 PR 里看到下列模式应直接拒绝：

- commit 历史先有实现后补测试（事后补）
- 单元测试 mock 内部模块、集成测试 mock 内部模块
- 断言私有字段 / 私有方法 / 调用顺序
- 一个测试断言多个独立命题
- `@skip` / `xtest` / `it.skip` / 注释掉的测试
- 测试名 ≤ 3 个词或不含 `should_..._when_...` 句式
- spec 改动 PR 不含合约测试更新
- 关键路径新增代码无覆盖
