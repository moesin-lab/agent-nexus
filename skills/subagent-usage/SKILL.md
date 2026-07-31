---
name: subagent-usage
description: 当用户明确要求派发多个、若干或并行 subagent，或当前任务涉及跨文件探索、长日志/长输出分析、独立可验证子任务、独立 review / 第二意见、批量同质操作或研究类问题时触发。小型直接修改、需要持续用户澄清或高度共享上下文的任务不触发。本文件是 harness-neutral 薄入口；权威流程与标准在 docs/dev/process/subagent-usage.md 和 docs/dev/standards/subagent-usage.md。
---

# subagent-usage（通用入口）

> 本文件只负责触发与导航。流程编排、派发判据、prompt 合格条件和产物标准分别由下列 owner 文档定义；规则冲突时以 owner 文档为准。

## 先读

触发后完整读取：

- [`docs/dev/process/subagent-usage.md`](../../docs/dev/process/subagent-usage.md)
- [`docs/dev/standards/subagent-usage.md`](../../docs/dev/standards/subagent-usage.md)
- 探索 / 侦察类任务额外读取 [`docs/dev/standards/subagent-recon-prompt-template.md`](../../docs/dev/standards/subagent-recon-prompt-template.md)

## 执行入口

按 process 文档编排派发与收敛，按 standards 文档判断是否适合派发并组织 prompt。主 session 收到结果后必须完成 [`verify + sweep`](../../docs/dev/standards/subagent-usage.md#收敛阶段产物)，再形成最终结论。

当前 harness 如有专用执行器，使用 `harnesses/<harness>/SKILL.md` 中的工具映射；没有专用执行器时，使用当前 harness 可用的等价多代理能力，并显式说明无法执行的环节。
