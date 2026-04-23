---
title: 开发流程（workflow）
type: process
status: active
summary: 从想法到合并的主路径；何时需要 ADR/spec/TDD、完成定义、轻量路径白名单
tags: [workflow, process]
related:
  - root/AGENTS
  - dev/process/tdd
  - dev/process/code-review
  - dev/adr/README
  - dev/spec/README
---

# 开发流程（workflow）

定义"从想法到合并"的完整路径。所有代码改动都走此流程，除非命中下文"轻量路径"白名单。

## 主路径

```
想法
 │
 ├─> 1. 开 Issue 说明问题与目标
 │
 ├─> 2. 判断是否需要 ADR
 │     ├─ 是 → 写 ADR（docs/dev/adr/）→ 评审 → 状态标为 Accepted
 │     └─ 否 → 跳过
 │
 ├─> 3. 判断是否需要 spec
 │     ├─ 是 → 写或改 spec（docs/dev/spec/）→ 评审
 │     └─ 否 → 跳过
 │
 ├─> 4. 写 failing test（TDD，见 process/tdd.md）
 │
 ├─> 5. 写最小实现让测试变绿
 │
 ├─> 6. 按需 refactor（保持测试绿）
 │
 ├─> 7. 自查清单（见 process/code-review.md）
 │
 ├─> 8. Codex review（大变更额外跑 ultrareview）
 │
 ├─> 9. 人类 review（如果有协作者）
 │
 └─> 10. Merge（遵循 commit-and-branch.md 的合并策略）
```

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

## 轻量路径（可跳过 ADR/spec/TDD）

以下改动允许直接走"改 → 自查 → review → merge"：

- 文档错别字、链接修复、术语统一
- 依赖的补丁版本升级（无 breaking change）
- 代码注释修改
- 本地开发脚本的小调整（不影响 CI）

轻量路径仍然需要 Conventional Commit 且 PR 必须范围收敛。

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

- 先写实现再补测试（违反 TDD，见 `process/tdd.md`）
- 先写实现再补 spec（违反"契约先行"）
- ADR 写完就开始写代码，跳过评审
- 在主 PR 里一起改 3 件无关的事
- PR 里不回答"三问"（见 `AGENTS.md`）
- 把 codex review 当 rubber stamp，不逐条回应
