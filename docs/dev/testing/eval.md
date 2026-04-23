---
title: Eval：对话质量回归
type: testing
status: active
summary: 对话质量 eval 的 case 结构、seed 最小集、断言类型、记分与回归门槛
tags: [testing, eval]
related:
  - dev/testing/strategy
  - dev/testing/fixtures
  - dev/spec/agent-runtime
---

# Eval：对话质量回归

Eval 测 agent 的**行为质量**（LLM 侧），不是代码的正确性。目的是防止提示词 / 工具集 / 模型升级带来的**静默退步**。

## 为什么要 eval

- LLM 输出是概率性的，常规测试难捕捉退步
- 提示词改一处可能让 10 种场景退步
- CC 版本升级、Anthropic 模型升级都会漂移
- cc-connect 的坑之一：对话质量没回归测试，问题到用户投诉才知道

## Eval vs 普通测试

| 维度 | 普通测试 | Eval |
|---|---|---|
| 对象 | 代码 | agent 行为 |
| 断言形式 | 确定性 == | 模糊匹配 / rubric / 副作用 |
| 运行成本 | ms 级 | 10s–分钟级 |
| 稳定性 | 确定 | 概率（需要多次跑或容忍阈值） |
| 运行频率 | 每次 commit | 定时 / 改提示时 |

## Case 结构

每个 eval case 是一个独立可运行的配置：

```text
EvalCase {
    id: string                              // 稳定唯一 ID
    name: string
    description: string
    tags: string[]                          // 例 ["happy_path", "permission"]

    // 输入
    input: {
        messages: NormalizedEvent[]         // 一条或多条用户消息
        sessionConfig: SessionConfig        // workingDir, toolWhitelist, budget
        fixtures: {
            workingDir?: FixtureDirRef      // 预置工作目录内容
        }
    }

    // 断言
    assertions: Assertion[]
}
```

### Assertion 类型

| 类型 | 含义 | 示例 |
|---|---|---|
| `text_contains` | 输出文本包含某子串 | 回复里有 "file not found" |
| `text_matches` | 正则匹配 | 回复符合代码块格式 |
| `tool_called` | 某工具至少被调用一次 | `Read` 被调用 |
| `tool_not_called` | 某工具未被调用 | `Bash` 未被调用 |
| `tool_call_sequence` | 工具调用顺序符合模式 | `Grep` → `Read` → `Edit` |
| `error_raised` | 期望一个特定错误类 | `auth_denied` |
| `side_effect_file` | 某文件存在/内容匹配 | `workingDir/out.txt` 包含 "done" |
| `budget_within` | 本 case 消耗不超过 | `< $0.05` |
| `llm_as_judge` | 用另一个 LLM 评分 | rubric 评分 ≥ 4/5 |

### llm-as-judge 规则

- rubric 写清楚打分维度与满分
- 判分 prompt 不依赖被测内容的特定字段
- 同一 case 跑 3 次取中位数（减少方差）
- 阈值通常 ≥ 4/5 才通过

## Seed case 最小集（MVP 必备）

第一天就要落盘的 case，至少 10 个：

| ID | 名字 | 断言 |
|---|---|---|
| `01-happy-path` | 基本问答 | `text_contains`（合理回复）、`budget_within` |
| `02-file-read-simple` | 读一个文件 | `tool_called("Read")`、`text_contains`（文件内容摘要） |
| `03-permission-denied` | 非 allowlist 用户发消息 | `error_raised("auth_denied")`、无 CC 调用 |
| `04-tool-not-whitelisted` | CC 尝试调用未在白名单的工具 | `tool_not_called("Bash")`、`text_contains`（拒绝提示） |
| `05-resource-limit-hit` | turn / wall-clock / tool-call 任一硬限触发 | `error_raised("turn_limit" / "wallclock_timeout" / "tool_limit")`、用户通知、session 归档或 Errored |
| `06-idempotency` | 同一 messageId 重发两次 | 第二次被拦截，CC 只被调用一次 |
| `07-gateway-reconnect` | 模拟 gateway 断连后恢复 | session 保活、消息不丢 |
| `08-long-context` | 多轮对话（10+ 轮） | 最后一轮正确指代前面内容 |
| `09-tool-error` | 工具调用失败（文件不存在） | `tool_call_sequence`、`text_contains`（错误解释） |
| `10-sensitive-redaction` | CC 输出含绝对路径 / token 样式串 | 发到 IM 的消息中已脱敏 |

Seed case 放 `testdata/eval/cases/seed/`。持续扩充。

## 运行

### 本地

```bash
scripts/eval run --case 01-happy-path
scripts/eval run --tag permission
scripts/eval run --all
```

（`scripts/eval` 在 ADR-0004 语言定后实现。）

### CI

- 不进 PR 必跑集
- main 分支每晚跑一次
- 失败 → 自动开 Issue + 保留本次运行的完整 transcript

## 记分

每个 case 的输出：

```text
EvalResult {
    caseId: string
    run: int                              // 第几次（判重读）
    startedAt, finishedAt
    passed: bool
    assertionResults: [{ type, passed, details }]
    actualTranscript: AgentEvent[]        // 完整记录便于复盘
    costUsd: float
    seed: int                             // 随机种子（如适用）
}
```

落盘 `eval-runs/<date>/<caseId>-<run>.json`。

## 回归门槛

- 每个 case 在最近 3 次运行里**至少 2 次通过**视为绿色
- 全套 case 通过率下降 > 10% → 阻止自动 PR 合并（人工 review）
- 单个 case 连续 3 次失败 → 打 `needs-investigation` 标签

## 成本管理

- 每次全量运行预算上限：`$10`（可配）
- 超预算 → 停止后续 case 并标记"未完成"
- 新增 case 前估算单次成本，记录在 case metadata

## 反模式

- 断言具体的 LLM 输出文本完全一致（概率性的，必挂）
- 不跑多次取中位数（单次结果噪声大）
- Case 依赖真实外部数据（必须用 fixture 或预置状态）
- Case 相互依赖（每个 case 独立，跑任意子集都可）
- 不落盘 transcript（出事无法复盘）
- 阈值设成 100%（概率系统永远达不到）

## 何时扩展 eval

- 引入新 prompt / 系统指令
- 升级 CC 版本
- 换 Anthropic 模型
- 新增工具集能力
- 发现某类 bug 被 eval 漏掉 → 补 case

## Out of spec

- Eval case 的用户可见 UI
- 跨版本 eval 的趋势面板（ops 阶段）
- 自动从用户 transcript 生成 eval case（研究课题）
