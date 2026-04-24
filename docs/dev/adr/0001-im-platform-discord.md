---
title: ADR-0001：MVP IM 平台选型——Discord
type: adr
status: active
summary: 选择 Discord 作为 MVP 首个 IM 平台，理由是个人场景下 SDK 最齐、Thread/Slash command 交互模型最贴合
tags: [adr, decision, discord, platform-adapter]
related:
  - dev/adr/0002-agent-backend-claude-code-cli
  - dev/adr/0003-deployment-local-desktop
  - dev/spec/platform-adapter
adr_status: Accepted
adr_number: "0001"
decision_date: 2026-04-22
supersedes: null
superseded_by: null
---

# ADR-0001：MVP IM 平台选型——Discord

- **状态**：Accepted
- **日期**：2026-04-22
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0002、ADR-0003

## 状态变更日志

- 2026-04-22：Proposed（对话中提出）
- 2026-04-22：Accepted（对话中锁定，无其他候选被深入评审）

## Context

agent-nexus 需要一个 IM 平台作为 MVP 的首个接入对象。选择会深度影响：

- 事件接收机制（webhook 还是长连接 gateway）
- 消息模型（纯文本 / 富媒体 / 组件）
- SDK 生态与维护成本
- 用户身份与权限模型
- 是否有 thread/slash command 等高级交互

cc-connect 试图一次适配 8 个平台（Feishu、Slack、Telegram、Discord、DingTalk、WeCom、QQ、LINE），结果抽象层被"共同子集"拉到最低，每个平台的高级特性都打了折扣，维护也极吃力。我们刻意反其道：**第一个版本只支持一个平台，把它做深**。

当前的使用者（项目发起人）是个人开发者，主要场景是"在 Discord 里远程驱动本机 CC CLI"。因此 Discord 是最贴合的起点。

## Options

### Option A：Discord

- **是什么**：面向社区与个人的 IM，支持 bot 账号、slash command、embed、button、thread
- **优点**：
  - discord.js / discordgo / discord.py 三大 SDK 成熟
  - Bot 账号注册简单，无需企业审核
  - Thread 与 channel 模型天然支持"多会话"
  - Slash command 提供标准化命令入口
  - 长连接 gateway + REST 混合，事件低延迟
- **缺点**：
  - 国内访问偶有问题（用户群自行解决）
  - Rate limit 严格，需要认真处理 429
- **主要风险**：如果后续要接入企业场景，Discord 不是主流选择，需要再加平台

### Option B：Feishu / Lark

- **是什么**：字节跳动的企业协作平台
- **优点**：国内企业主流、OpenAPI 完善、消息卡片强
- **缺点**：
  - 个人开发者调试不便（需要租户/应用审核）
  - SDK 偏企业化，配置复杂
  - 不贴合"本机桌面远程遥控"的个人使用场景
- **主要风险**：本阶段用户是个人开发者，Feishu 优势发挥不出来

### Option C：Telegram

- **是什么**：面向个人/小团队的 IM
- **优点**：Bot API 最简单、长轮询即可起步
- **缺点**：
  - 缺少 thread / slash command 的标准化（Bot Menu 有但弱）
  - 消息富交互组件少
  - channel/group 的会话模型映射不如 Discord 自然
- **主要风险**：模型表达力不足，后面接更多功能时要补锅

### Option D：Slack

- **是什么**：欧美企业协作平台
- **优点**：Bolt SDK 成熟、block kit 富组件、thread 原生
- **缺点**：
  - 个人用途需要新建 workspace 并登记 app
  - 免费 workspace 历史消息有限
  - 国内访问更慢
- **主要风险**：个人场景启动摩擦大于 Discord

## Decision

选 **Option A：Discord**。

理由（一句话）：在"个人开发者 / 本机桌面"这个 MVP 场景下，Discord 的注册成本最低、SDK 生态最齐、thread 与 slash command 的交互模型最贴合"多并发会话 + 命令式调用"的需求。

## Consequences

### 正向

- 上手最快，第一个 demo 可以在一两天内跑通
- Thread = 一个会话，天然的 session key 映射
- SDK 丰富，语言选型不因 Discord 而受限

### 负向

- 企业用户接入需要额外适配（未来可能的 Feishu / Slack 需要新 ADR 与新 adapter）
- 国内用户访问 Discord 有门槛（不在本项目修复范围）

### 需要后续跟进的事

- 在 spec/platform-adapter.md 中确保抽象层不因 Discord 过度定制；增加第二个平台时不应需要破坏性改动
- Rate limit 策略必须在 spec/cost-and-limits.md 落实

## Out of scope

- **不决定**未来是否接入其他 IM 平台（那是新 ADR）
- **不决定**Discord 账号类型（bot / user）与 OAuth scope 细节（属于 spec/platform-adapter.md）
- **不决定**富交互组件的选用（slash vs prefix command、embed vs plain）——属于 spec 层

## 参考

- 相关 spec（待创建）：`docs/dev/spec/platform-adapter.md`
- cc-connect 平台一览：`/workspace/cc-connect-src/docs/discord.md` 等
