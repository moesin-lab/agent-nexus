---
title: AGENTS.md（agent-nexus 项目规则）
type: root
status: active
summary: 项目特有协作规则入口，叠加在全局 ~/.claude/CLAUDE.md 之上，定义七条不可违反的核心原则与 PR 三问
tags: [workflow, tdd, code-review, subagent, commit]
related:
  - root/CONTRIBUTING
  - dev/process/workflow
  - dev/process/tdd
  - dev/process/code-review
  - dev/process/subagent-usage
---

# AGENTS.md（agent-nexus 项目规则）

> 本文件是协作规则的**入口索引**，叠加在全局 `~/.claude/CLAUDE.md` 之上。具体规则展开在 `docs/dev/process/` 下对应文件。规则冲突时，本文件和 `docs/dev/` 下的项目文档优先。

## 核心原则（不可违反）

1. **文档先行**：新模块没进 `docs/dev/spec/` 不接受 PR；架构级改动没进 `docs/dev/adr/` 不接受 PR。
2. **TDD 强制**：先 spec → 先 failing test → 再 impl。细节见 [`docs/dev/process/tdd.md`](docs/dev/process/tdd.md)。
3. **契约先行**：跨层交互必须走 `docs/dev/spec/` 定义的接口。新增能力先改 spec，再改代码。
4. **Code review 不走过场**：每个 PR 必须过 codex review（大变更走 ultrareview）。流程见 [`docs/dev/process/code-review.md`](docs/dev/process/code-review.md)。
5. **Subagent 优先**：探索类、长研究类任务优先派发子代理，主 session 只做收敛与决策。细节见 [`docs/dev/process/subagent-usage.md`](docs/dev/process/subagent-usage.md)。
6. **范围收敛**：每个 PR 只做一件事，禁止"顺手重构"无关代码。
7. **Conventional Commits**：所有提交遵循 [`docs/dev/process/commit-and-branch.md`](docs/dev/process/commit-and-branch.md)。
8. **读文档走 `scripts/docs-read`**：读 `docs/` 下的 markdown 或仓库根规则文档一律通过 `scripts/docs-read <path>`，**禁止**直接 `Read`。详见下文"读文档的防污染规则"。

## 读文档的防污染规则

### 为什么

`Read` 工具默认读全文，不会因为 YAML frontmatter 的 `---` 闭合符停下。如果直接 `Read` 一份 `adr_status: Superseded` 或 `status: placeholder` 的文档，**过时正文会立刻进入上下文**，之后再纠偏代价远高于第一次过滤。

### 强制规则

读项目文档**必须**通过 `scripts/docs-read`（三种模式按意图选）：

| 命令 | 用途 | 返回 | 退出码 |
|---|---|---|---|
| `scripts/docs-read <path>` | **默认（智能）**：大多数场景走这个 | active 全文；过时只 frontmatter + 告警 | 0 / 2 |
| `scripts/docs-read --head <path>` | **泛读**：先看 summary/tags 判断要不要读全文 | 仅 frontmatter（无视状态） | 0 |
| `scripts/docs-read --force <path>` | **强读**：研究历史（例：Superseded ADR 的演进） | 全文；过时在 stderr 告警 | 0 |

### 推荐的 harness 级强制（可选）

项目不假定协作者使用哪种 agent，所以 `.claude/`、`.codex/` 等 harness 本地配置**不入库**（见 `.gitignore`）。但我们提供了通用的守卫脚本 `scripts/pretool-read-guard`：任何支持 PreToolUse hook 的 harness 都能接入，获得硬拦截（命中 `docs/**/*.md` 或根规则文档的裸 `Read` → 直接 block，stderr 指引三种 docs-read 模式）。

#### Claude Code 集成示例

在本地创建 `.claude/settings.json`（不会被提交）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          { "type": "command", "command": "scripts/pretool-read-guard" }
        ]
      }
    ]
  }
}
```

#### 其他 harness

按自身文档在 PreToolUse 事件上挂 `scripts/pretool-read-guard` 即可——脚本读 stdin JSON 判断工具名与路径，通用。

#### 不配 hook 的后果

AGENTS.md 的"强制规则"仍然生效；只是少了 harness 兜底，依赖 agent 纪律与 reviewer 把关。

### 不走脚本的例外

- `CHANGELOG.md`（Keep a Changelog 规范，无 frontmatter）
- 代码文件（`.go` / `.ts` / `.py` 等）
- 非项目文件（`.git/`、`.tasks/`、`scripts/`、外部仓库）

### 违反的后果

reviewer 在 PR 里看到直接 `Read` 项目 markdown 且作者确实基于它做了决策的，应要求重做。过时内容进决策链后，整条链条都要重新验证。

### 脚本或 hook 不可用时

- `docs-read` 崩溃：退回 `Read(path, limit=20)` 只读前 20 行元信息，再人工判断；**不允许**直接读全文作为默认行为。
- 没有配 hook（协作者没用 Claude Code / 没装本地 `.claude/settings.json`）：仍按本节"强制规则"自律；reviewer 仍按硬标准验收。

## 每个 PR 必答三问

作者在 PR 描述里自答，reviewer 照此验收：

1. **对应哪条 ADR？**（无需 ADR 时说明理由）
2. **对应哪个 spec？**（纯实现细节可注明 N/A）
3. **对应哪些测试？**（列出新增/修改的测试文件与断言）

三问缺一，reviewer 有义务要求补齐或直接拒绝。

## 沟通与输出

遵循全局 `~/.claude/CLAUDE.md` 约定：

- 全程使用中文
- 表达直接、克制、无废话
- 长输出分段 check in，不为凑长度被截断

## 本项目特有的反模式（来自 cc-connect 教训）

以下行为在本项目**明确禁止**：

- 没有 ADR 就做架构级改动（例如新增一个 IM 平台、换 agent 后端、改 session 模型）
- 没有 spec 就开始写模块代码
- 把观测性、幂等、限流"留到以后做"——这些在 `core` 层强制，第一版就必须有
- 适配器（platform、agent）自己实现日志格式、错误处理、重试策略——必须复用 `core` 提供的基础设施
- 在 IM 里回显绝对路径、env、token、内部错误栈——必须经过 `core` 的脱敏层
- PR 里混多件事（"顺便改了下 X"）——单一关注点原则
- 为了赶时间跳过 codex review——大变更必须 review
- 派发 subagent 后主 session 又把同样的探索做一遍——相信子代理的产出，主 session 只做收敛

## 文件定位速查

| 想做什么 | 先看哪里 |
|---|---|
| 开新模块 | `docs/dev/process/workflow.md` |
| 写测试 | `docs/dev/process/tdd.md` + `docs/dev/testing/strategy.md` |
| 发 PR | `docs/dev/process/code-review.md` + 本文件"三问" |
| 写日志 | `docs/dev/standards/logging.md` + `docs/dev/spec/observability.md` |
| 处理错误 | `docs/dev/standards/errors.md` |
| 做架构决策 | `docs/dev/adr/README.md` + `docs/dev/adr/template.md` |
| 接入新 IM 平台 | `docs/dev/spec/platform-adapter.md` |
| 集成新 agent 后端 | `docs/dev/spec/agent-runtime.md` |

## 本文件不做的事

- 不展开具体规则——展开在 `docs/dev/` 下
- 不替代全局 `~/.claude/CLAUDE.md`——只在项目内追加与覆盖
- 不对使用者做说明——使用者文档在 `docs/product/`
