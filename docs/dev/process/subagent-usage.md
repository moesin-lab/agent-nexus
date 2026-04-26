---
title: Subagent 使用规范
type: process
status: active
summary: 何时派发子代理、如何写 prompt、主 session 收敛职责与并行策略
tags: [subagent, process]
related:
  - root/AGENTS
  - dev/process/code-review
  - dev/standards/subagent-usage
---

# Subagent 使用规范

在多代理 harness 环境里，**何时派发子代理、派发后如何收敛**直接决定效率与上下文质量。Prompt 与产物合格条件见 [`../standards/subagent-usage.md`](../standards/subagent-usage.md)。

## 何时派发（强烈建议）

- **跨文件探索**：不知道功能在哪实现、需要 grep + 多文件 read
- **长日志/长输出分析**：CC CLI 几千行输出、测试失败长 traceback
- **独立可验证子任务**：写一个独立工具函数、写一批 fixture、生成一段样板代码
- **第二意见**：让另一个模型（codex）给出独立判断（见 [`code-review.md`](code-review.md)）
- **批量同质操作**：在多个文件里做相似改动
- **研究类问题**：查外部文档、API、协议规范

## 何时不派发

- 任务粒度小（1–2 个文件、明确入口）——主 session 直接做更快
- 需要与用户来回澄清——中间结论需要用户实时参与
- 任务需要强依赖上下文记忆（前面几轮对话里讨论过的约束）——子代理没有这些上下文，抓不准
- 低风险可回滚的快速操作（小的 edit、单条命令）

## 派发哪个子代理

按 `~/.claude/CLAUDE.md` 的全局约定，常用：

| 场景 | 子代理类型 |
|---|---|
| 代码/文件探索 | `Explore`（快速）或 `general-purpose`（深度） |
| 实现方案设计 | `Plan` |
| 独立 review | `superpowers:code-reviewer` 或 codex-review skill |
| 第二意见/盲点检查 | `codex:codex-rescue` 或 codex-review skill |
| 简化改进既有代码 | `code-simplifier` |

本项目专属补充：待 ADR 0004 语言定后，如有需要可新增项目专属子代理（如"spec 合约测试生成器"），届时在本文件登记。

## Prompt 与回报格式

派发前按 [`../standards/subagent-usage.md`](../standards/subagent-usage.md) 检查 prompt；探索类回报格式使用 [`subagent-recon-prompt-template.md`](../standards/subagent-recon-prompt-template.md)。

## 主 session 的职责

派发子代理后，主 session 的职责是：

1. **收敛**：把多个子代理的产出整合成一致结论
2. **决策**：基于产出做出选择（子代理不替你决策）
3. **落盘**：把最终产物写入正确位置（代码文件、文档、ADR）
4. **追问**：子代理结论有漏洞，补问或重新派发

主 session **不应**：

- 复制粘贴子代理的结论不做过滤
- 把子代理当 oracle（把决策责任转移给它）
- 发出子代理后自己也做一遍同样的事

## 任务拆分与并行派发

**前提**：先通过 §何时派发 / §何时不派发 确认任务该派发出去。一旦确认要派，**默认倾向**把工作拆成多个没有共享状态的子任务并行发出；但这是倾向不是义务——下面的信号和阈值都是**经验参考**，不机械执行。

### 触发拆分的信号（倾向拆）

- **扫描范围较大（>5 份文件 / >5 个目录）**：按目录或按子域切片
- **产出天然分区**：例如审计文档按 `adr/` `architecture/` `spec/` 分区，搜索按模块分区
- **多路径探索**：要同时比较 A / B / C 三种技术方案可行性
- **汇总型报告**：最终要合并成一份报告，但各子报告独立生成

### 反向信号（倾向不拆）

- 子任务之间**上下文耦合高**：需要共享同一批约束、同一批中间结论——拆分后每个子 agent 都要重复收到整套背景，净收益变负
- **收敛成本 > 并行收益**：4 个并行 agent 若合成一份一致报告的工作量本身很大，不如一个 agent 串行做
- **任务本身很短**：主 session 直接做都在几分钟内，引入 subagent 的 prompt 开销反而更慢
- **需要来回澄清**：subagent 单次往返，碰到边界歧义要重派，主 session 直接做可中途问用户

### 常用拆分维度

| 维度 | 例子 |
|---|---|
| 按目录 | `docs/dev/adr/` / `docs/dev/architecture/` / `docs/dev/spec/` 分三路扫 |
| 按模块 | `daemon/` / `platform/` / `agent/` 分三路搜同一 pattern |
| 按关注点 | "安全盲点" / "内部矛盾" / "缺失文档" 分三路审同一批文件 |
| 按层级 | contract 扫一路、implementation 扫一路、test 扫一路 |
| 按方案 | 方案 A 可行性、方案 B 可行性、方案 C 可行性 并行对比 |

### 子任务规模 / 审计类 prompt / 收敛产物的合格条件

见 [`../standards/subagent-usage.md` §子任务规模 / §审计类派发 prompt / §收敛阶段产物](../standards/subagent-usage.md)。

### 反例

> 派一个 Explore 扫遍 `docs/dev/` 下 40 份 markdown，逐文件审计矛盾、缺失、stale。

正确做法：派 ≥2 个并行 `general-purpose`（**不是 Explore**——Explore 优化"快速查找"，不擅穷举判定），按目录或维度切片（如 `adr/` + `architecture/` / `spec/` 核心三件套 + `agent-backends/` / `spec/infra/` + `spec/security/` + `standards/` + `testing/`），主 session 再做一次跨分区收敛。审计类 prompt 还需满足 standards 里列出的硬约束（逐文件 enumerate + 三态判定 / 不预设豁免），收敛阶段做完整 verify + sweep。

### 串行不可避免的场景

子任务 B 依赖子任务 A 的产出时严格串行。但先问：A 的产出里**真正**被 B 依赖的是什么？能不能把那部分单独抽出来先跑 A'，然后 A'' 与 B 并行？

## 登记新用途

在项目里发现某种场景下"派发子代理效果特别好"或"特别差"，在本文件追加记录，避免同类经验流失。
