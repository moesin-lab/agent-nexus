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

#### 2a. ADR-0008 Context 列出的 8 处跨文件重复（PR #19）

按抽样复核结果（部分原列违反实为合规），实际清理 / 跳过情况：

- [x] **#1 SessionKey** 重构：spec/message-protocol 成为 owner，architecture/session-model 改为引用
- [x] **#2 接口签名伪代码**：删除 architecture/overview L113-140 的 PlatformAdapter/AgentRuntime/Engine 伪代码，改为 link 到各 spec
- [x] **#3 限流阈值**：ADR-0006 L100 措辞从 negative claim 改为 positive link（指向 spec/infra/cost-and-limits）
- [⊘] **#4 横切能力清单**：抽查后判定**已合规**——architecture/overview L155-167 是组合事实索引（每行只列入口和 spec 路径），不复述
- [x] **#5 限流"一等/二等机制"论述**：spec/cost-and-limits 三处复述清理为 link
- [⊘] **#6 NormalizedEvent 字段子集**：抽查后判定**已合规**——spec/platform-adapter L73-84 是"adapter 必填子集"索引，不是字段定义复述
- [x] **#7 Session vs AgentSession**：命名混淆——加澄清注释（不 rename），不同 entity 不同状态机
- [⊘] **#8 AgentEvent/usage 映射**：抽查后判定**已合规**——spec/agent-runtime 现状已清晰（UsageRecord 定义 + 与 llm_call_finished 一一对应说明）

#### 2b. PR #18 后扫描发现的 standards/process 内部 owner 违反（PR #19）

抽样复核：1 处 explore 误判（25%），其余 3 处准确。

- [x] 🔴 **重写**：`process/commit-and-branch.md` 拆分——产物形态价值标准（Conventional Commits 格式 / 分支命名 / commit 粒度 / Co-Authored-By）迁到新 `standards/commit-style.md`；process 只剩分支生命周期、合并策略、行为禁止
- [x] 🟡 **小补**：`process/workflow.md` 准入条件清单 → `adr/README.md`（合并入"什么情况写 ADR"段）+ `spec/README.md`（新增"什么情况写 spec"段）
- [x] 🟡 **小补**：`process/code-review.md` Review 优先级表 → `standards/coding.md` 新增"Review 反馈处理优先级"段
- [⊘] **跳过**：`process/pre-decision-analysis/README.md` 核心原则段——抽样复核显示 explore 误判：6 条核心原则中多数是 process 形态（trigger / role / default behaviour），只有"核心前提"段（git 便宜 / agent 便宜 / review 贵）是 ADR 形态根因论证。整段迁出会割裂阅读链，保留为流程内嵌哲学

#### 2c. 用户指出的 explore 漏判

- [x] 🔴 **重写**：`process/tdd.md` —— explore 整体判 OK 但实际三种 owner 内容混在一起。新建 ADR-0009 承载决策依据；新建 `standards/testing.md` 承载合格条件本体（探针、反模式、断言写法、命名、覆盖率、合约测试）；process/tdd.md 精简为 Red-Green-Refactor 节奏 + 层级触发 + 失败处理 + 自查 checklist

#### Instrumentation 数据汇总（PR #19 八处清理 + 三处判合规）

每个清理 PR 在描述里强制回答（结果汇总）：

1. **doc-ownership.md 的六步判定 + 冲突裁决表能否稳定决定 owner？**
   - 8 处清理中 7 处可稳定决定（spec vs architecture 边界靠"契约定义 vs 组合视角"）
   - 1 处需要语感（spec/cost-and-limits L45 "机制级设计意图脚注"——是 ADR 还是 spec？最终保留 spec）
2. **诉诸语感的边界**：
   - "机制级设计意图脚注" vs "决策论述"（出现 1 次）
   - "Conventional Commits 行为禁止 vs 产物形态禁止"（混合在原 process 文件里，需手工拆分）
3. **explore 报告抽样复核**：4 处中 1 处误判（pre-decision-analysis 核心原则）；ADR-0008 列 8 处中 3 处是伪违反（已判合规跳过）；用户事后指出 tdd.md 也被 explore 漏判（整体判 OK 但实际三种 owner 混在一起）。提示扫描方法论应区分"流程导言 / 工程哲学论证 / 价值标准本体 / 决策论述"四档而非两档，且应**逐节审视**而非文件级判定
4. **新规则需求信号**：
   - "机制级设计意图脚注"边界出现 ≥1 次但暂未达到引入新规则阈值
   - 抽样复核显示现有规则在多数情况稳定可用，**不引入新判据**

汇总数据用于阶段 3 决策。

### 阶段 2.5：全仓库逐节扫描（独立 PR）

**触发原因**：tdd.md 暴露 explore agent 文件级判定的系统性盲点——一份文件可能融合三种 owner（process 顺序 + standards 价值本体 + ADR 决策论述），文件级"判 OK"会全部漏判。本 PR 内的 explore 扫描结果不可信任，需要重做一遍。

**本 PR 不处理**——PR #19 已含 12 commit 跨 17 文件，再扩 scope 会让 reviewer 失焦。本阶段在 PR #19 合入后单独起 PR。

#### 扫描方法论改进（吸取 tdd.md 教训）

1. **逐节审视**而非文件级——每个 `## ` 段独立标 owner 性质，不允许"整份文件 OK"判定
2. **四档分类**而非两档：
   - **process**（流程编排）：trigger / role / step / failure handling
   - **standards**（价值标准本体）："必须 X / 不许 Y" / 做不做对照 / 禁入清单 / 合格条件
   - **ADR-rationale**（决策论述）：选项对比 / 权衡论证 / 放弃理由
   - **engineering-philosophy**（前提论证 / 流程导言）：背景假设 / 触发推论 / 元层观念
3. **比例阈值**：文件主体若 < 50% 真 owner 内容，强制拆分；导言/前提段 < 20% 可保留
4. **可疑信号词**速判：
   - 看到 "为什么 X / 因为 Y" → ADR
   - 看到 "X 必须 / 不许 / 合格条件" → standards
   - 看到 "先 X 再 Y / 何时 X / 由谁 X" → process
   - 看到 "本质是 X / 假设 X / 前提是 X" → engineering-philosophy（保留还是迁出按比例阈值判）

#### 高度可疑文件清单（按 tdd.md 教训预判）

按可疑度排，每文件需逐节审：

- [ ] `process/subagent-usage.md` —— 派子代理流程 + 好 prompt 价值标准混合
- [ ] `process/skill-setup.md` —— 挂接流程 + skills.manifest schema（产物形态）混合
- [ ] `process/docs-read.md` —— 防污染流程 + "什么 case 必须 force"价值判据混合
- [ ] `process/pre-decision-analysis/anti-patterns.md` —— 名字就是 anti-patterns，按定义是禁入清单（应在 standards 而非 process）
- [ ] `process/pre-decision-analysis/output-template.md` —— 输出模板 = 产物形态价值标准
- [ ] `process/pre-decision-analysis/subflow-*.md` 5 份 —— 大概率有"argue 应该怎么写"等价值判据
- [ ] `process/self-refinement/README.md` —— explore 自己标"边界 case"，没仔细审
- [ ] `process/subagent-recon-prompt-template.md` —— 模板 = 产物形态
- [ ] `standards/coding.md` 反向：可能有"PR 时检查 X"流程编排塞进来
- [ ] `standards/errors.md` 反向：可能有"何时打错误日志 / 何时熔断"流程混入
- [ ] `standards/logging.md` 反向：可能有"何时记日志"流程混入

#### 执行步骤

1. 派改进版 explore agent，brief 强制四档分类 + 逐节 + 比例阈值
2. **抽样复核**——本 PR 教训：explore 输出 100% 信任不可取，每份至少独立 1 处复核
3. 按真违反清单做拆分 PR（一个 PR 一个文件 / 一组相关文件）
4. 每个拆分 PR 维持 instrumentation 要求（doc-ownership 判据稳定性 / 边界 case / 新规则需求）

### 阶段 3：按清理证据决定后续

完成阶段 2（含 2.5）后回看：

- [ ] 复盘：阶段 2 + 2.5 全部清理中现有规则的稳定性如何？
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
