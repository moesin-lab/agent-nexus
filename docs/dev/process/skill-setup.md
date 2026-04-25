---
title: 协作性 skill 挂接规范
type: process
status: active
summary: 协作性 skill 入库后如何挂接到各 harness 的 skill 目录；Claude Code 提供 sync-claude-skills.sh 脚本，其他 harness 自行挂接
tags: [skills, setup, process]
related:
  - root/AGENTS
  - dev/adr/0007-collaborative-skill-promotion
---

# 协作性 skill 挂接规范

**协作性 skill**（影响协作产出格式 / 需他人理解产物 / 多人共用；见 [ADR-0007](../adr/0007-collaborative-skill-promotion.md)）入库在仓库根 `skills/`，由 [`skills.manifest`](../../../skills.manifest) 声明。

各 harness 的 skill 目录（`.claude/skills/` / `.codex/skills/` / ...）按"harness 配置不入库"约定 gitignored；**首次 clone 后或 `skills.manifest` / skill 目录结构变更后**要把 `skills/` 下的 skill 挂接到本地 harness 目录。

## Skill 目录分层

按 ADR-0007 Decision 第 5 点：

```
skills/<name>/
├── SKILL.md                           # harness-neutral 通用入口（触发 / 先读 / 跨 harness 协作关系）
└── harnesses/
    └── claude-code/
        └── SKILL.md                   # Claude Code 执行细节（工具映射 / 具体派发方式 / 路径约定）
```

- 规则权威源在 `docs/dev/process/<name>.md`，agent-agnostic
- 通用入口 `SKILL.md` 描述跨 harness 通用行为，不点名特定工具
- per-harness 执行器住 `harnesses/<harness>/SKILL.md`，承载该 harness 特定细节

## 通用挂接原理（harness-agnostic）

无论 harness，挂接逻辑都是：

1. 检索 `skills/<name>/SKILL.md` 是否标注本 harness
2. 若有 harness-specific 执行器（`skills/<name>/harnesses/<harness>/SKILL.md`），优先用作入口
3. 否则回退到 `skills/<name>/SKILL.md` 通用入口
4. 通过 harness 自身机制（symlink / copy / hook）把执行器挂到本地 skill 目录

各 harness 的具体实现：

- **Claude Code**：见下文 §"Claude Code 协作者"
- **其他 harness**：参考 Claude Code 的脚本逻辑自行实现（见 §"其他 harness"）

## Claude Code 协作者

首次 clone 后（以及 `skills.manifest` 或 skill 目录结构变更后）运行一次：

```bash
bash scripts/sync-claude-skills.sh
```

脚本行为：

- **优先**挂 `skills/<name>/harnesses/claude-code/` 到 `.claude/skills/<name>`（per-harness 执行器）
- **回退**：若 `harnesses/claude-code/` 不存在，挂 `skills/<name>/`（通用入口，兼容未拆分 per-harness 的 skill）
- **幂等**：可重复跑，自动纠正过期 symlink
- **清理幽灵**：自动删除 `.claude/skills/` 下 target 以 `../../skills/` 开头但已不在 manifest 的 symlink
- **不碰用户私放**：只动自己建的 symlink，其他文件/目录不动

手动挂接（不推荐，除非脚本不可用）：

```bash
# 有 per-harness 执行器时
ln -sfn "../../skills/<name>/harnesses/claude-code" ".claude/skills/<name>"

# 只有通用入口时
ln -sfn "../../skills/<name>" ".claude/skills/<name>"
```

## 其他 harness（Codex / Cursor / ...）

本 repo 未内置挂接脚本。各 harness 按以下模式自行挂接到自己的 skill 目录：

1. 在 `skills/<name>/harnesses/<harness>/` 下添加本 harness 的执行器（可选；没有就用通用入口 fallback）
2. 用 symlink / copy / 其他机制把 `skills/<name>/harnesses/<harness>/`（优先）或 `skills/<name>/`（回退）挂到 harness 的 skill 目录
3. 挂接脚本入仓库 `scripts/`，文件名以 harness 区分（如 `sync-codex-skills.sh`）

规则本身以 `docs/dev/process/` 下的权威源为准，skill 只是执行器。

## 未挂接的后果

⚠️ **未挂接 → 协作 skill 静默不触发 → 协作产出格式漂移**。

`.claude/` / `.codex/` 等都 gitignored，`git status` 看不到异常；漂移只在 review 阶段才能被发现。clone 后、或 `skills.manifest` / `skills/<name>/` 目录结构有 PR 合入后，**记得跑一次挂接脚本**。

## 新增协作性 skill 的清单

按 ADR-0007 入库判据（影响协作产出格式 / 要他人理解产物 / 多人共用）确认该入库后：

1. 权威源进 `docs/dev/process/<name>/` 或 `docs/dev/process/<name>.md`（agent-agnostic）
2. `skills/<name>/SKILL.md` — harness-neutral 通用入口
3. `skills/<name>/harnesses/<harness>/SKILL.md` — 至少一个 harness 的执行器（否则脚本会 fallback 挂通用入口，对 Claude Code 触发质量可能打折）
4. 在 `skills.manifest` 加一行 `<name>`
5. Claude Code 协作者跑 `bash scripts/sync-claude-skills.sh` 验证挂接生效
6. 开 PR 前回答 AGENTS.md "三问"（对应哪条 ADR / 哪个 spec / 哪些测试）

## 范围

纯个人偏好 skill（提示语风格 / 输出 verbosity / 个人习惯）**不适用本规范**——它们继续留各自 harness 的 local 配置目录，不入库、不挂接。
