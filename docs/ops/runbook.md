---
title: 运维手册
type: ops
status: placeholder
summary: 部署、监控、排障、数据管理、安全检查手册；等 MVP 有部署产物后填写
tags: [ops, runbook]
related:
  - dev/architecture/overview
  - dev/spec/infra/observability
  - dev/spec/infra/persistence
  - dev/spec/infra/cost-and-limits
  - dev/spec/security/README
---

# 运维手册（占位）

> **状态**：占位。等 MVP 有可部署产物后填写。

## 将包含的章节（规划）

### 部署

- 安装包位置与校验
- 首次启动步骤
- 自启动配置（launchd / systemd / tray）
- 升级流程

### 监控

- 日志位置：`~/.agent-nexus/logs/<date>.jsonl`
- 关键事件（见 [`../dev/spec/observability.md`](../dev/spec/infra/observability.md)）
- 健康检查端点（如有）

### 排障

- 常见错误与解决
  - `gateway_disconnected` 频繁 → 网络
  - `auth_denied` 异常多 → 是否 allowlist 配错
  - `budget_threshold_crossed` → 调整预算或查 agent 是否失控
  - `circuit_opened` → 查最近 3 次 agent 错误
- 如何拿到特定 traceId 的完整日志：`jq`/`rg` 示例
- 如何查某 session 的 transcript

### 数据管理

- SQLite 备份：`~/.agent-nexus/state.db` + transcripts
- 日志轮转与清理
- 幂等表 GC 异常的应急清理

### 安全检查

- Token 是否在 OS keychain（优先）
- 文件权限：`~/.agent-nexus/` 应是 `0700`，`secrets/*` 应是 `0600`
- allowlist 是否含误入的公共 user id

### 性能

- CC 子进程数量与资源占用
- SQLite 索引使用情况
- 消息队列长度监控

## 为什么现在不写

没有部署产物、没有真实运行数据、没有真实故障场景——现在写就是拍脑袋。

## 参考规范

本手册在填写时必须与以下对齐：

- [`../dev/architecture/overview.md`](../dev/architecture/overview.md)
- [`../dev/spec/observability.md`](../dev/spec/infra/observability.md)
- [`../dev/spec/persistence.md`](../dev/spec/infra/persistence.md)
- [`../dev/spec/cost-and-limits.md`](../dev/spec/infra/cost-and-limits.md)
- [`../dev/spec/security.md`](../dev/spec/security/README.md)
