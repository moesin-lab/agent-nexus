---
name: skill-setup
description: 当用户要求在 agent-nexus 仓库新增、修改、删除或重命名协作性 skill，调整 skills.manifest，或配置、修复仓库 skill 的 harness 挂接时触发。仅使用现有 skill、创建个人或全局 skill、修改普通项目文档时不触发。
---

# skill-setup（通用入口）

本 skill 只负责仓库协作性 skill 的准入与挂接导航，不定义目录、manifest 或校验规则。

## 先读

完整读取：

- [`docs/dev/process/skill-setup.md`](../../docs/dev/process/skill-setup.md)
- [`docs/dev/adr/0007-collaborative-skill-promotion.md`](../../docs/dev/adr/0007-collaborative-skill-promotion.md)

仓库准入、文件归属、挂接和验证均以上述 owner 为准。若任务涉及创建或改进 `SKILL.md` 内容，可在确认符合仓库准入后调用当前环境可用的 `skill-creator`；它只辅助产物编写，不能替代仓库 owner 的判定。

## 边界

- 个人偏好或全局 skill 转交环境级 `skill-creator` / 安装流程，不写入本仓库。
- 仅安装、启用或调用一个现有 skill 时，不进入本流程。
- 当前 harness 有专用执行器时，使用 `harnesses/<harness>/SKILL.md` 完成具体工具映射。
