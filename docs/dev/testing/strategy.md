---
title: 测试策略
type: testing
status: active
summary: 四层测试模型（Unit/Integration/E2E/Eval）的职责、Mock 策略、运行节奏与 CI 门槛
tags: [testing, strategy]
related:
  - dev/process/tdd
  - dev/testing/fixtures
  - dev/testing/eval
---

# 测试策略

定义测试的分层、覆盖目标、mock 边界、运行节奏。配套 [`../process/tdd.md`](../process/tdd.md) 使用——tdd 讲"怎么写"，本文件讲"写哪一层"。

## 四层模型

```
 ┌──────────────┐ ← 最少量
 │    Eval      │  对话质量回归（LLM 输出）
 ├──────────────┤
 │     E2E      │  真实 CC CLI + mock Discord
 ├──────────────┤
 │  Integration │  模块间（adapter ↔ core、core ↔ store）
 ├──────────────┤
 │    Unit      │  单函数/类；覆盖最广
 └──────────────┘ ← 最多量
```

### 各层职责

| 层 | 范围 | Mock 边界 | 典型时长 |
|---|---|---|---|
| Unit | 单函数、单类 | 外部 I/O 全 mock | <50ms / 测试 |
| Integration | 模块对接 | 只 mock 系统边界 | <500ms / 测试 |
| E2E | 完整链路 | 只 mock Discord | 5–30s / 测试 |
| Eval | 对话质量 | 真实 LLM + 真实 CC | 数十秒 / case |

## 各层目标

### Unit

- 覆盖所有**业务逻辑**分支
- 覆盖所有**错误路径**
- 覆盖**纯函数** / 数据变换 / 状态机转换
- 覆盖**脱敏规则**的各种 pattern

不覆盖：I/O 细节、框架初始化、与外部系统的真实通信。

### Integration

- Adapter ↔ Core：给 adapter 喂 fixture 事件 → 断言 core 被正确调用；给 core 一个 OutboundMessage → 断言 adapter 发出的平台调用
- Core ↔ Store：SQLite 真跑，断言数据落盘与读出
- Core ↔ Redactor：输入含敏感 → 输出脱敏
- Core ↔ RateLimiter / BudgetTracker：触发各种阈值

### E2E

- 真实 CC CLI 子进程
- Mock Discord（用 fake server 或 in-memory adapter 实现）
- 端到端断言：用户消息 → 经过完整链路 → 产生正确的 outbound 消息
- **数量很少**：5–10 个关键流程（happy path、权限拒绝、超预算、断线重连、熔断）

### Eval

- 真实 LLM 调用
- 针对 agent 行为的回归（见 [`eval.md`](eval.md)）
- 成本较高，独立 CI pipeline

## Mock 策略

### 总原则

- **单元测试**：mock 所有 I/O（网络、磁盘、时钟、子进程）
- **集成测试**：只 mock 系统边界（Discord API、Anthropic API、CC CLI 子进程）
- **E2E**：只 mock Discord（CC CLI 真跑）
- **Eval**：什么都不 mock

### 每个依赖的 mock 策略

| 依赖 | Unit | Integration | E2E | Eval |
|---|---|---|---|---|
| Discord API | mock | mock | mock（fake server） | mock |
| Anthropic API | mock | 真（对核心路径） | 真 | 真 |
| CC CLI 子进程 | mock | transcript 回放 | 真（spawn） | 真 |
| SQLite | mock / in-memory | 真（临时文件） | 真 | 真 |
| 时钟 | mock | 真 | 真 | 真 |
| 文件系统 | mock / tmpdir | tmpdir | tmpdir | 真（项目目录） |

### CC CLI 的两种 mock

CC 是黑盒，输出格式可能变。维护两种 mock：

1. **Transcript 回放**：预录的 CC 输出 JSONL，按时间戳重放；用于稳定的 integration/unit 测试
2. **真实 spawn**：CC 真跑；用于 E2E 与 eval；每个 CC 版本升级需要重新录一批 transcript

详细见 [`fixtures.md`](fixtures.md)。

## 组织与命名

### 位置

- 语言无关原则：测试文件**与被测文件相邻**（同目录 `*_test.ts` / `_test.go` / `test_*.py`，具体语言定后细化）
- 集成测试放 `tests/integration/<module>/`
- E2E 放 `tests/e2e/`
- Eval 放 `tests/eval/`

### 命名

单元测试函数名：`should_<行为>_when_<条件>`

### 文件对齐

- 一个被测文件 → 一个以上测试文件（按场景拆）
- 测试文件只测它对应的被测文件；跨文件逻辑 → 集成测试

## 覆盖率

- 不追求百分比指标
- **关键路径必须接近 100%**：消息流、脱敏、权限检查、预算、熔断
- 新增代码无测试覆盖：reviewer 追问

## 运行节奏

| 层 | 本地开发 | PR CI | main CI | 定时 |
|---|---|---|---|---|
| Unit | 每次 save 跑受影响的 | 全跑 | 全跑 | — |
| Integration | 相关模块变更时 | 全跑 | 全跑 | — |
| E2E | 可选 | 改核心时触发 | 全跑 | — |
| Eval | 改 prompt/工具集时 | 选择性跑（标签触发） | — | 每晚 |

## CI 门槛

- Unit + Integration：**必须全绿**才能合并
- E2E：PR 标签 `requires-e2e` 时跑；默认 main CI 每次跑
- Eval：定时跑；回归则自动开 Issue 但不 block 合并

## 测试工具链

（等 ADR-0004 语言定后补独立文件 `testing-tooling.md`）

需要的能力：

- 单元测试 runner + 断言库
- 模块级 mock 框架
- Fake HTTP server（或等效）做 Discord/Anthropic mock
- SQLite 临时库 helper
- Fixture 管理（见 fixtures.md）

## 反模式

- 每个测试都起一个真 CC 子进程（慢且脆弱，应 transcript 回放）
- Mock 自己（只 mock 外部依赖）
- 用 sleep 等异步（用 fake clock 或显式同步）
- 用 print 调试后不删
- Skip 挂掉的测试当作"通过"（禁止）
- 一个测试测 10 个断言（拆成多个）
- 测试里硬编码绝对路径（用临时目录）
- 改实现时顺手改测试让它过（说明重构破坏了契约，应先确认）

## 不做的事

- 不做 BDD 层（Given-When-Then 当做内部命名约定即可，不用独立 DSL）
- 不做性能测试（MVP 规模下不需要）
- 不做 mutation testing（成本高、收益低）
- 不覆盖 third-party 库（它们有自己的测试）
