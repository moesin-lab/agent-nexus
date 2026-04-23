---
title: Spec：Secrets（密钥管理）
type: spec
status: active
summary: OS keychain / env / 文件三层存储；命名前缀；禁止写入清单；轮换策略
tags: [spec, security, secrets]
related:
  - dev/spec/security
  - dev/spec/redaction
  - dev/spec/persistence
  - dev/spec/observability
---

# Spec：Secrets（密钥管理）

定义密钥的获取与约束。配套 [`redaction.md`](redaction.md)（出口过滤）、[`persistence.md`](persistence.md)（禁止落盘项）、[`observability.md`](observability.md)（禁止打印字段）共同构成"防泄露"体系。

对应模块：`core.secrets`。

## 存储层级（优先顺序）

启动时按顺序查找，前一级命中即停：

1. **OS keychain**（推荐）
   - macOS：Keychain
   - Linux：`libsecret` / `secret-service`
   - Windows：Credential Manager
2. **环境变量**
3. **文件** `~/.agent-nexus/secrets/<name>`，权限 `0600`

启动时在日志里记录**来源**（来源本身，例 "keychain"、"env"、"file"；**不含值**）。

## 命名与约定

- 所有密钥名带明确前缀：`ANTHROPIC_API_KEY`、`DISCORD_BOT_TOKEN`
- 启动时加载，内存保留最短必要时间
- 密钥变量在内存中应包装为 secret string 类型（避免 accidentally log）

## 禁止写入清单

**绝不**写入以下位置：

| 位置 | 原因 |
|---|---|
| SQLite（任何表、任何字段） | 本地文件虽 `0600`，但与业务数据不隔离 |
| 任何日志文件 | 跨日期轮转难彻底清理 |
| Transcript 文件 | 长期保留、用户可能导出 |
| IM 消息（发给用户） | Discord 侧立刻公开 |
| 错误栈 / trace | 栈里出现时拦截并替换为 `<redacted>`（由 [`redaction.md`](redaction.md) 实现） |
| `.data/` / `cache/` 任何子目录 | 同 SQLite 理由 |

## 轮换

- Bot token 轮换：重启进程即生效
- 旧 token 应被用户在平台侧作废，本程序不主动做
- 未来如支持热重载密钥，需独立 ADR

## 启动自检

- 所有必需密钥能加载（否则退出并提示**来源层级**，不提示值）
- 加载来源层级必须一致（禁止 Anthropic 走 env、Discord 走 file 这种混合；避免忘配项）

## 合约测试

- **keychain 命中**：fixture keychain 中有 key → 不读 env / 不读 file
- **env 回退**：keychain miss → 读 env；日志记 `source=env`
- **file 回退**：前两层 miss → 读 file；文件权限不是 `0600` 时启动失败
- **日志无泄露**：构造含密钥的错误栈 → 日志里无原文（redactor 配合）
- **SQLite 无密钥**：启动后 dump 所有表，断言无密钥模式匹配

## 反模式

- Token 写进 `config.toml`
- 用 `if debug { log.debug(token) }`——debug 模式下也禁止
- 把密钥名放进命令行参数（会进程列表泄露；用 env 或 stdin）
- 缓存解密后的密钥到文件以"加速启动"

## Out of spec

- 加密存储 SQLite 文件（本机 `0600` 权限够用）
- 多因素认证（与本机桌面形态不匹配，见 ADR-0003）
- HSM / KMS 集成（MVP 未考虑）
