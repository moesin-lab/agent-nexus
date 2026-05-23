---
title: 产品文档中心
type: index
status: active
summary: 面向使用者的文档中心；覆盖本机安装、Discord 配置、启动与基础使用
tags: [product, navigation]
related:
  - root/README
  - product/user-guide
  - product/platforms/discord
  - product/faq
---

# 产品文档中心

> **状态**：可用于本机 Discord MVP。高级部署、预算视图与多平台内容仍按实际需求补齐。

## 本中心的定位

面向**使用者**（非开发者）。回答：

- 怎么安装和启动？
- 怎么配置 Discord bot？
- 在 Discord 里怎么用？支持哪些命令？
- 出问题怎么查？

## 范围

- 本中心只写使用者能直接执行的步骤。
- 内部接口、架构决策、测试策略放在 [`../dev/`](../dev/)。
- 本机长期运行、日志、停机与排障放在 [`../ops/runbook.md`](../ops/runbook.md)。

## 本中心 vs `dev/` vs `ops/`

| 问题 | 去哪 |
|---|---|
| "我要改代码" | [`../dev/`](../dev/) |
| "我要部署维护" | [`../ops/`](../ops/) |
| "我要使用" | 本中心 |

## 文档清单

- [`user-guide.md`](user-guide.md) — 安装、配置、启动与基础使用
- [`platforms/discord.md`](platforms/discord.md) — Discord bot 申请、邀请、权限与验证
- [`faq.md`](faq.md) — 常见问题

## 继续补齐的触发条件

下列内容出现稳定需求后再补：

1. 多平台安装包或二进制分发
2. 长期运行方式从手动命令升级到 service / launch agent
3. 预算与成本的用户可见界面
4. 外部测试用户反馈出的高频问题

## 语言

当前只写中文。双语翻译等产品入口稳定后统一处理。
