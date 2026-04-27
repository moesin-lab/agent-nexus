---
title: 产品文档中心
type: index
status: active
summary: 面向使用者的文档中心；已补齐 Discord 起步文档，其他章节继续完善
tags: [product, navigation]
related:
  - root/README
  - product/user-guide
  - product/platforms/discord
  - product/faq
---

# 产品文档中心

> **状态**：部分可用。当前先补齐 Discord 申请与使用起步文档，其他章节继续分批完善。

## 本中心的定位

面向**使用者**（非开发者）。回答：

- 怎么安装？
- 怎么配置 Discord bot / Anthropic API key？
- 在 Discord 里怎么用？支持哪些命令？
- 出问题怎么查？

## 为什么暂不全写

- 仍有部分使用流程和命令集合未冻结
- 先把已经稳定的入口、配置和申请步骤写清楚，避免散落在代码注释和 README 里
- 其余内容按实际反馈补齐，避免一次性写出过时文档

## 本中心 vs `dev/` vs `ops/`

| 问题 | 去哪 |
|---|---|
| "我要改代码" | [`../dev/`](../dev/) |
| "我要部署维护" | [`../ops/`](../ops/) |
| "我要使用" | 本中心 |

## 文档清单

- [`user-guide.md`](user-guide.md) — 入门与使用指南（仍在补充）
- [`platforms/discord.md`](platforms/discord.md) — Discord 专属使用手册（已补齐申请步骤）
- [`faq.md`](faq.md) — 常见问题（仍在补充）

## 继续补齐的触发条件

本中心在下列里程碑后开始填写：

1. 可执行二进制/包产出（ADR-0004 语言定、首版编译通过）
2. Slash command 集合冻结
3. 配置项清单冻结
4. 有外部测试用户（哪怕 1 位）给出初版反馈

## 语言

本中心填写时同时提供中英双语（写给全球使用者）。开发文档只写中文。
