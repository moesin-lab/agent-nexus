---
name: release-workflow
description: 当用户要求 agent-nexus 发版、发布 npm 包、创建或推送发布 tag、验证 release candidate / CLI tarball，或修改发布 workflow 与 package 发布元数据后执行发布验证时触发。不用于普通 build/test、PR ready/merge、仅写 GitHub Release 文案，或版本与渠道仍待决策的讨论。
---

# Release workflow

本 skill 是发布流程的薄入口，不定义或复述项目规则。

## 触发边界

- 发布候选验证与真实发布都进入本 skill，但必须区分本地、可回滚验证和外部发布动作。
- 普通 PR readiness、日常 build/test 或仅撰写公告时不触发。
- 版本、tag、渠道或发布范围尚未确定时，先转入 `pre-decision-analysis`。

## 先读

读取以下 owner：

- 发布候选、tag 与发布流程：[`docs/dev/process/release.md`](../../docs/dev/process/release.md)
- 发布制品验证与 CI 证据：[`docs/dev/testing/strategy.md`](../../docs/dev/testing/strategy.md)
- 分支、提交、同步与合并编排：[`docs/dev/process/commit-and-branch.md`](../../docs/dev/process/commit-and-branch.md)
- 公开 npm CLI 的发布决策：[`docs/dev/adr/0020-publish-single-npm-cli-package.md`](../../docs/dev/adr/0020-publish-single-npm-cli-package.md)

PR 合并前仍使用 `pr-readiness`；只有进入发布候选或发布阶段才由本 skill 接管。

规则冲突或细节不一致时，以对应 owner 文档为准。
