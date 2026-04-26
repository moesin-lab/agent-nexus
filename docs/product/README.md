---
title: 产品文档中心
type: index
status: placeholder
summary: 面向使用者的文档中心；本阶段仅占位，等 MVP 可运行后填写
tags: [product, navigation]
related:
  - root/README
  - product/user-guide
  - product/platforms/discord
  - product/faq
---

# 产品文档中心

> **状态**：占位。本阶段（文档与规范骨架）尚无可用产物，本中心所有文档均为骨架，**等 MVP 可运行后填写**。

## 本中心的定位

面向**使用者**（非开发者）。回答：

- 怎么安装？
- 怎么配置 Discord bot / Anthropic API key？
- 在 Discord 里怎么用？支持哪些命令？
- 出问题怎么查？

## 为什么现在不写

- 还没有可用的可执行文件，写"怎么装"没意义
- Slash command 集合、配置项、错误提示都尚未定型
- 过早的产品文档必然变成过时内容，误导用户

## 本中心 vs `dev/` vs `ops/`

| 问题 | 去哪 |
|---|---|
| "我要改代码" | [`../dev/`](../dev/) |
| "我要部署维护" | [`../ops/`](../ops/) |
| "我要使用" | 本中心（占位中） |

## 占位文件清单

- [`user-guide.md`](user-guide.md) — 入门与使用指南
- [`platforms/discord.md`](platforms/discord.md) — Discord 专属使用手册
- [`faq.md`](faq.md) — 常见问题

## 填写时机

本中心在下列里程碑后开始填写：

1. 可执行二进制/包产出（ADR-0004 语言定、首版编译通过）
2. Slash command 集合冻结
3. 配置项清单冻结
4. 有外部测试用户（哪怕 1 位）给出初版反馈

## 语言

本中心填写时同时提供中英双语（写给全球使用者）。开发文档只写中文。
