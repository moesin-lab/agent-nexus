---
title: Spec：Secrets（密钥管理）
type: spec
status: active
summary: 实例 home 下 0600 secret 文件的加载、引用命名、禁止写入清单与轮换策略
tags: [spec, security, secrets]
related:
  - dev/spec/security/README
  - dev/spec/security/redaction
  - dev/spec/infra/persistence
  - dev/spec/infra/observability
---

# Spec：Secrets（密钥管理）

定义密钥的获取与约束。配套 [`redaction.md`](redaction.md)（出口过滤）、[`persistence.md`](../infra/persistence.md)（禁止落盘项）、[`observability.md`](../infra/observability.md)（禁止打印字段）共同构成"防泄露"体系。

对应实现：CLI 组装层的 secret loader；platform config 只持有 secret ref。

## 存储与加载

当前只支持文件 provider：

- 路径：实例根路径下的 `secrets/<name>`；实例根路径见 [`persistence.md`](../infra/persistence.md#存储根路径)
- secret ref 只能是名称，不能包含路径分隔符或目录跳转
- secret 文件权限必须精确为 `0600`；缺失、空文件或权限不符时启动失败
- 启动日志记录 `source=file` 与 platform instance 名，不记录 secret 值
- 不读取同名环境变量，也不访问 OS keychain

新增其它 provider 或优先级前，必须先扩展本契约与合约测试，不能静默改变同名 ref 的解析来源。

## 命名与约定

- 建议使用平台可识别前缀，例如 `DISCORD_BOT_TOKEN`、`FEISHU_APP_SECRET`；ref 语法只强制安全文件名规则
- 启动时加载，内存保留最短必要时间
- Lark config 只保存 `appSecretRef`；loader 解析后把 secret 直接注入官方 SDK constructor，不回写 config / SQLite

## 禁止写入清单

**绝不**写入以下位置：

| 位置 | 原因 |
|---|---|
| SQLite（任何表、任何字段） | 本地文件虽 `0600`，但与业务数据不隔离 |
| 任何日志文件 | 跨日期轮转难彻底清理 |
| Transcript 文件 | 长期保留、用户可能导出 |
| IM 消息（发给用户） | Discord / Lark 侧会立刻对收件人可见 |
| 错误栈 / trace | 栈里出现时拦截并替换为 `<redacted>`（由 [`redaction.md`](redaction.md) 实现） |
| `.data/` / `cache/` 任何子目录 | 同 SQLite 理由 |

## 轮换

- Bot token / app secret 轮换：重启进程即生效
- 旧 credential 应被用户在平台侧作废，本程序不主动做
- 未来如支持热重载密钥，需独立 ADR

## 启动自检

- 所有 platform 引用的 secret 文件都能加载，否则退出并提示 ref 对应路径，不提示值
- 多个 platform 可以引用同一文件；同一进程内相同 ref 只需加载一次

## 合约测试

- **文件加载**：合法 ref 只读取 `<home>/secrets/<name>`；日志记 `source=file`
- **fail-closed**：文件缺失、为空、权限不是 `0600` 或 ref 含路径分隔符时启动失败
- **日志无泄露**：构造含密钥的错误栈 → 日志里无原文（redactor 配合）
- **SQLite 无密钥**：启动后 dump 所有表，断言无密钥模式匹配
- **Lark secret ref**：config 只含 `appSecretRef`；SDK fake 收到 secret 值但日志、错误、SQLite 与 transcript 均无原文

## 反模式

- Token 写进 config 文件
- 用 `if debug { log.debug(token) }`——debug 模式下也禁止
- 把密钥名放进命令行参数（会进程列表泄露；用 env 或 stdin）
- 缓存解密后的密钥到文件以"加速启动"

## Out of spec

- OS keychain、环境变量与远程 secret manager provider
- 加密存储 SQLite 文件（本机 `0600` 权限够用）
- 多因素认证（与本机桌面形态不匹配，见 ADR-0003）
- HSM / KMS 集成（MVP 未考虑）
