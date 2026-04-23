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
- 即便是"一行改动"，也走 分支 → PR → review → squash merge 的完整链路。原因：本项目把 PR 作为强制的 codex review 触发点，绕过分支就绕过了 review。

## 何时需要 ADR

满足任一条件就需要 ADR：

- 引入/替换一个外部依赖的大类（IM 平台、agent 后端、数据库、框架）
- 改变模块依赖方向（参见 `architecture/dependencies.md`）
- 改变对外契约（`spec/` 下任意文件的接口签名或字段）
- 改变部署形态（单机 → 多机、桌面 → 服务端）
- 改变安全模型（权限边界、密钥存储、脱敏规则）

## 何时需要 spec

- 新增模块或新增模块间交互
- 改变已有接口的字段、语义、错误码
- 新增横切约束（observability 字段、限流策略、session 存储）

只改单一模块内部实现、不影响外部契约的，不需要改 spec。

## 可跳过 ADR / spec / TDD 的情形

流程主路径的每一步都保留，但以下改动允许在该步"判断为不需要"后直接跳过，而**分支、PR、review、squash merge 不可跳过**：

- 文档错别字、链接修复、术语统一 → 跳过 ADR / spec / test
- 依赖的补丁版本升级（无 breaking change） → 跳过 ADR / spec；是否需要 test 看风险
- 代码注释修改 → 跳过 ADR / spec / test
- 本地开发脚本的小调整（不影响 CI） → 跳过 ADR / spec；是否需要 test 看风险

上述改动同样需要独立分支、Conventional Commit 和 PR 范围收敛。

## 完成定义（Definition of Done）

每一步都必须达到其 DoD 才能进入下一步：

| 步骤 | 完成定义 |
|---|---|
| ADR | 状态为 Accepted，Context/Options/Decision/Consequences 四段齐全 |
| spec | 至少包含字段表或伪代码接口，有 reviewer 通读确认 |
| failing test | 运行确实失败，且失败原因是"功能未实现"而非"语法错" |
| 实现 | 所有相关测试通过，无测试被跳过或删除 |
| 自查 | 清单每一项打勾；新增的 public 接口都在 spec 中 |
| Codex review | 收到反馈，逐条回应（采纳或说明理由） |
| Merge | CI 全绿、commit 信息符合规范、CHANGELOG 更新（若影响用户） |

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
