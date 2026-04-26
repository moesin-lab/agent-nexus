---
title: 任务追踪
type: task
status: active
summary: 当前主线进度与待完成项，按全局 AGENTS.md 第 4 条约定维护
tags: [task]
related:
  - root/AGENTS
---

# 任务追踪

> 按全局 `~/.claude/CLAUDE.md` 第 4 条约定：非平凡任务在需要持续跟踪时写入本文件。不追踪一次性小任务。

## 当前主线

**阶段**：文档与规范骨架（进行中，接近收尾）

### 已完成

- [x] 仓库 `git init` + `.gitignore` + `CHANGELOG.md`
- [x] 仓库根文件（`README`/`AGENTS`/`CONTRIBUTING`）+ `docs/README.md`
- [x] `docs/dev/process/`：workflow / tdd / code-review / subagent-usage / commit-and-branch / release
- [x] `docs/dev/standards/`：coding / logging / errors / docs-style
- [x] `docs/dev/adr/`：README / template / 0001–0003 Accepted / 0004 Proposed
- [x] `docs/dev/architecture/`：overview / session-model / dependencies
- [x] `docs/dev/spec/` 核心三件套：platform-adapter / agent-runtime / message-protocol
- [x] `docs/dev/spec/` 横切四件套：persistence / observability / security / cost-and-limits
- [x] `docs/dev/testing/`：strategy / fixtures / eval
- [x] `docs/product/` + `docs/ops/` 占位
- [x] `.tasks/todo.md` 初始化

### 待完成（本阶段收尾）

- [x] ADR 0004 语言选型的二次评审（含 Go/TS/Python 对比矩阵），仍 `Proposed`，待用户最终决策
- [x] 一次性 commit：`docs: bootstrap dev docs and ADRs`（d2fd1ab）
- [x] 加 YAML frontmatter：`docs: add YAML frontmatter for progressive agent reading`（da7ac3d）
- [x] ADR-0005 订阅一等路径 + 重构 cost-and-limits + 同步相关文档
- [ ] 整份 `docs/dev/` 丢给 `codex-review` skill 独立 review（推迟）
- [ ] ADR-0004 语言最终决策（用户拍板）
- [ ] 可选：PreToolUse hook 硬性拦截对 `docs/**/*.md` 的 `Read`（将 AGENTS.md 约定升级为 harness 级强制）
- [ ] 可选：`scripts/docs-lint`（提交前校验 frontmatter 完整性与枚举值）

## SSOT / 文档分类（PR #18 docs/adr-0008-doc-layering-ssot 主线）

经 Opus + Codex + Sonnet 三方迭代后收敛的执行计划。核心判断：当前 6-owner 不重组，
用清理过程当探针，按发现的具体摩擦决定是否引入新规则或后续重组。

### 阶段 1：本 PR 收尾（最小动作）—— ✅ 已合入（PR #18, commit 004a0f2）

- [x] doc-ownership.md "不属于本规则" 段加元层文档豁免（README / template / 索引 / 归档说明等不受 owner 矩阵约束）
- [x] reviewer 后续追问的两条静默丢失 gating 补到 process/code-review.md（缺 frontmatter 拒入 / 文档落后于代码按 bug 处理）
- [x] AGENTS.md §10 删掉代码层逃生口
- [x] commit + push + 合入

**不**引入 Codex 提的两条精细化规则（"实现充分性"判据 / "决策权威 vs 操作权威"区分）
——它们的价值要在阶段 2 清理场景里被验证后再考虑正式引入。

### 阶段 2：清理既有 owner 违反（每处一个小 PR）

#### 2a. ADR-0008 Context 列出的 8 处跨文件重复

- [ ] SessionKey 完整定义重复（architecture/session-model + spec/platform-adapter + spec/agent-runtime）
- [ ] PlatformAdapter / AgentRuntime / Engine 接口签名（architecture/overview 伪代码 + spec/* 权威）
- [ ] 限流默认阈值（ADR-0006 声明"不决定阈值" vs spec/infra/cost-and-limits 已写死值）
- [ ] 横切能力清单（architecture/overview 14 项表 + spec 子目录散落引用）
- [ ] PR #19：限流"一等机制 vs 二等机制"论述（ADR-0006 + spec/infra/cost-and-limits）—— 进行中
- [ ] NormalizedEvent 字段表（spec/message-protocol 完整 + spec/platform-adapter 重列）
- [ ] Session vs AgentSession 状态枚举（命名混淆 → 改名消歧）
- [ ] AgentEvent / usage 字段映射（spec/agent-runtime 内部组织松散，单文件重组）

#### 2b. PR #18 后扫描发现的 standards/process 内部 owner 违反

PR #18 合入后用 explore agent 系统扫描 6 standards + 11 process 文件，新增以下违反——standards 全部 OK，process 4 处需清理：

- [ ] 🔴 **重写**：`process/commit-and-branch.md` L14-99 → 主体是产物形态价值标准（Conventional Commits format / 分支命名规则）。新建 `standards/commit-style.md` 承载产物形态本体；process 只剩生命周期编排 + link
- [ ] 🟡 **小补**：`process/workflow.md` L65-82 → 准入条件清单（"满足任一条件就需要 ADR：..."）属价值标准本体。迁到 `adr/README.md`（已有 ADR 准入清单）
- [ ] 🟡 **小补**：`process/code-review.md` L78-88 → Review 优先级表（正确性 > 安全 > 契约 > 可维护性 > 风格）属价值判据。迁到 `standards/coding.md` 或新建 `standards/code-review-criteria.md`
- [ ] 🟡 **小补**：`process/pre-decision-analysis/README.md` L18-33 → 核心原则（"Agent-first / review 做选择不批改"等）属工程哲学/价值判断。迁到 ADR 或 `standards/collaboration-model.md`

#### Instrumentation 要求

每个清理 PR 在描述里强制回答：

1. doc-ownership.md 的六步判定 + 冲突裁决表能否稳定决定 owner？
2. 还是诉诸语感？哪一段判据最难用？
3. 边界 case 是否反复出现，提示需要新规则？

汇总数据用于阶段 3 决策。

### 阶段 3：按清理证据决定后续

完成阶段 2（共 12 处清理，2a 八处 + 2b 四处）后回看：

- [ ] 复盘：12 次清理中现有规则的稳定性如何？
- [ ] 决策：是否引入 Codex 的"实现充分性"判据（替换或加强"提及 vs 复述"）
- [ ] 决策：是否引入 Codex 的"决策权威 vs 操作权威"区分
- [ ] 决策：是否需要更深层结构重组（开 ADR-0009/0010）

**默认不重组**——只有清理证据明确指向"现有六步判定不够用"才进入重组讨论。

## 下一阶段（预留）

- [ ] ADR 0004 决定后：建立代码目录骨架（`core/`、`agent/claudecode/`、`platform/discord/`、`cmd/`）
- [ ] TDD 起步：第一个模块的 spec 合约测试
- [ ] 基础工具链搭建（测试 runner、lint、CI）

## 暂搁待议

- 是否单独文件写"CC transcript 录制脚本规范"
- 是否为每条 ADR 引用建跳转索引（md 内链够不够用）
- `docs/product/` 是否应在第一版时提供英文 stub
