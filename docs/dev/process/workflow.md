---
title: 开发流程（workflow）
type: process
status: active
summary: 从想法到合并的主路径；分支先行、何时需要 ADR/spec/TDD、完成定义
tags: [workflow, process]
related:
  - root/AGENTS
  - dev/process/tdd
  - dev/process/code-review
  - dev/adr/README
  - dev/spec/README
---

# 开发流程（workflow）

定义"从想法到合并"的完整路径。所有代码与文档改动都走此流程，没有例外——包括错别字、注释、依赖补丁升级。

## 主路径

```
想法
 │
 ├─> 1. 开 Issue 说明问题与目标
 │
 ├─> 2. 从 main checkout 新分支（命名见 commit-and-branch.md）
 │     后续所有 ADR/spec/test/impl 的改动都落在这条分支上
 │
 ├─> 3. 判断是否需要 ADR
 │     ├─ 是 → 写 ADR（docs/dev/adr/）→ 评审 → 状态标为 Accepted
 │     └─ 否 → 跳过
 │
 ├─> 4. 判断是否需要 spec
 │     ├─ 是 → 写或改 spec（docs/dev/spec/）→ 评审
 │     └─ 否 → 跳过
 │
 ├─> 5. 写 failing test（TDD，见 process/tdd.md）
 │
 ├─> 6. 写最小实现让测试变绿
 │
 ├─> 7. 按需 refactor（保持测试绿）
 │
 ├─> 8. 自查清单（见 process/code-review.md）
 │
 ├─> 9. Codex review（大变更额外跑 ultrareview）
 │
 ├─> 10. 人类 review（如果有协作者）
 │
 └─> 11. Merge（遵循 commit-and-branch.md 的合并策略）
```

## 分支先行（不可跳过）

- 一切改动必须在从 `main` checkout 的新分支上进行，包括纯文档、错别字、依赖补丁升级。
- 禁止在 `main` 上直接编辑、commit 或累积未 PR 的改动。
- 即便是"一行改动"，也走 分支 → PR → review → squash merge 的完整链路。

理由：

1. **PR 是 review 的承载窗口**：codex review / ultrareview 当前由作者手动触发（见 `code-review.md`），但 diff 展示、评论、反馈与作者回应、决策记录都挂在 PR 上。直接在 `main` commit 等于把这些都丢掉。
2. **分支隔离**：每次改动独立、可单独 revert、可 abandon；不会把半成品和别人的工作搅在一起。
3. **强制范围收敛**：分支命名（`<type>/<short-description>`）本身就是"这次只做这一件事"的承诺，与"PR 单一关注点"形成双约束。
4. **为未来留位**：分支保护规则、PR 触发的 CI、自动 review hook、required reviewers——都需要"分支 → PR"已经是默认习惯才能挂上去。

## 何时需要 / 可跳过 ADR / spec / 测试

主路径中第 3、4、5 步的判定不在 process 编排——它们是各 owner 的准入条件（价值标准）：

| 步骤 | 该不该写 | 何时可跳过 |
|---|---|---|
| ADR | [`../adr/README.md` §什么情况写 ADR](../adr/README.md#什么情况写-adr) | [`../adr/README.md` §何时可跳过 ADR](../adr/README.md#何时可跳过-adr) |
| spec | [`../spec/README.md` §什么情况写 spec](../spec/README.md#什么情况写-spec) | [`../spec/README.md` §何时可跳过 spec](../spec/README.md#何时可跳过-spec) |
| 测试 | [`tdd.md`](tdd.md) + [`../testing/strategy.md`](../testing/strategy.md) | [`../standards/testing.md` §何时可跳过新增/修改测试](../standards/testing.md#何时可跳过新增修改测试) |

无论某步骤判定为不需要 ADR / spec / test，**分支、PR、review、squash merge 都不可跳过**——见上文"分支先行"。

## 完成定义（Definition of Done）

每一步达到对应 owner 的产物合格条件才能进入下一步。本表只编排顺序，合格条件本体在 owner：

| 步骤 | DoD 在哪 |
|---|---|
| ADR | [`../adr/README.md` §产物合格条件（DoD）](../adr/README.md#产物合格条件dod) |
| spec | [`../spec/README.md` §产物合格条件（DoD）](../spec/README.md#产物合格条件dod) |
| failing test / 实现 / refactor | [`../standards/testing.md` §TDD 各阶段产物合格条件](../standards/testing.md#tdd-各阶段产物合格条件) |
| 自查 | [`../standards/code-review.md` §自查清单合格条件](../standards/code-review.md#自查清单合格条件) |
| Codex review | [`../standards/code-review.md` §Codex review 反馈响应合格条件](../standards/code-review.md#codex-review-反馈响应合格条件) |
| Merge | [`../standards/commit-style.md` §Merge 阶段产物合格条件](../standards/commit-style.md#merge-阶段产物合格条件) |

## 新增模块 / 包

开新模块（新 agent、新 platform、或新的 daemon 子模块）按下面顺序走，每步达到 DoD 才进下一步：

1. **判定角色**：cli / daemon / agent / platform 哪一个？分类与 import 方向见 [`../architecture/dependencies.md`](../architecture/dependencies.md)
2. **判定依赖**：只能 import `daemon` 与 `protocol`？依赖准入清单见 [`../standards/dependencies.md`](../standards/dependencies.md)
3. **若需扩 daemon 接口**：先改 daemon 发 PR 合入，再开这个模块
4. **若需扩 protocol 接口契约**：先改 protocol 发 PR 合入，再开实现 package
5. **在 [`../architecture/dependencies.md`](../architecture/dependencies.md) §附录 package 清单登记**（若是新 agent / platform）

每步如需 ADR / spec / test 按本文件 §"何时需要 / 可跳过" 判定。

## 流程图里不画但必须做的事

- **及时同步文档**：代码改了接口，同 PR 改 spec；不接受"下 PR 再补"。
- **范围收敛**：一旦发现当前改动牵扯到其他问题，开新 Issue，不要在当前 PR 里顺手改。
- **失败时暂停**：如果某一步发现前提不成立（ADR 前提错了、spec 里某字段设计不对），**回到上一步**而不是绕过。

## 反模式

- **在 `main` 上直接实现 / commit**（违反"分支先行"，绕过 PR 与 codex review）
- 先写实现再补测试（违反 TDD，见 `process/tdd.md`）
- 先写实现再补 spec（违反"契约先行"）
- ADR 写完就开始写代码，跳过评审
- 在主 PR 里一起改 3 件无关的事
- PR 里不回答"三问"（见 `AGENTS.md`）
- 把 codex review 当 rubber stamp，不逐条回应
