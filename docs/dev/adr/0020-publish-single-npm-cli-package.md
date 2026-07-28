---
title: ADR-0020：首发只发布单一 npm CLI 包
type: adr
status: active
summary: 首发只公开 @moesin-lab/agent-nexus CLI，内部 workspace 包保持 private，并锁定版本、Node、平台与发布认证边界
tags: [adr, decision, release, language-runtime]
related:
  - dev/adr/0004-language-runtime
  - dev/process/release
  - root/README
adr_status: Proposed
adr_number: "0020"
decision_date: 2026-07-26
supersedes: null
superseded_by: null
---

# ADR-0020：首发只发布单一 npm CLI 包

- **状态**：Proposed
- **日期**：2026-07-26
- **决策者**：项目 owner
- **相关 ADR**：ADR-0004

## 状态变更日志

- 2026-07-26：Proposed

## Context

MVP 的用户入口是一个 `agent-nexus` 命令，但仓库由 CLI、daemon、protocol、
两个 agent backend、Discord platform 和 Lark platform 七个 workspace package 组成。内部包用于
约束源码依赖方向，不是当前对外扩展 API；把它们全部发布会过早形成兼容性承诺。

原计划中的 `@agent-nexus/cli` 与无 scope 的 `agent-nexus` 均已被其他 npm 项目使用。
`@moesin-lab/agent-nexus` 当前 registry 查询无结果，但 registry 404 只表示没有公开包，
不能证明项目维护者控制 `moesin-lab` npm organization。

CLI bundle 已把六个内部 workspace package 编入单个 JavaScript 入口。第三方原生依赖
`better-sqlite3` 必须继续作为 npm 运行时依赖安装，不能依赖内部 daemon manifest
随 bundle 自动传播。

Node 20 已结束安全维护。首发需要在仍受 Node.js 官方支持的 LTS 主版本上验证，同时
为 `better-sqlite3` 这类原生依赖保留明确、可重复的 OS / Node 安装证据。

本机部署依赖 POSIX 权限位和进程信号。Linux 与 macOS 已有运行路径，Windows 尚缺
权限、信号和安装验证；首发应把支持承诺收敛到能稳定复现的 OS 与架构。

npm trusted publishing 需要先在已存在的 package 设置中绑定发布者。新 package 首次
创建仍需传统认证；选择哪种 bootstrap 认证会决定仓库是否要长期保存写 token。

## Options

### Option A：发布一个 scoped CLI，内部包保持 private

- **是什么**：只发布 `@moesin-lab/agent-nexus`，提供 `agent-nexus` bin；六个内部包只参与构建并进入 bundle。
- **优点**：
  - 用户只安装一个包，符合当前产品入口。
  - 不对尚未稳定的内部模块 API 作公共兼容承诺。
  - scoped 名称与仓库 owner 对齐，避开现有同名包。
  - 发版、回滚和 provenance 只围绕一个制品。
- **缺点**：
  - CLI manifest 必须显式维护 bundle 外部的全部第三方运行时依赖。
  - 第三方暂时不能独立复用内部 agent / platform package。
- **主要风险**：若 npm organization 控制权未确认，首发会在最后一步失败。

### Option B：公开发布全部 workspace package

- **是什么**：CLI 与六个内部包全部改为 public，并用 workspace 版本关系发布。
- **优点**：
  - npm 原生表达包间依赖，不需要把内部实现 bundle。
  - 第三方可以直接引用 daemon、protocol、agent 和 platform package。
- **缺点**：
  - 一次首发形成七个公共版本和兼容矩阵。
  - 需要处理发布顺序、同步版本与 breaking change 策略。
  - 当前内部接口尚未被定义为公共扩展 API。
- **主要风险**：过早固定内部边界，后续重构成本转化为公共 breaking changes。

### Option C：另选无 scope 的 CLI 名称

- **是什么**：选择一个当前可用的无 scope 名称，只发布 CLI。
- **优点**：
  - 安装命令更短。
  - 不依赖 npm organization。
- **缺点**：
  - 名称与仓库、GitHub organization 的对应关系较弱。
  - 可用名称仍需持续抢占和品牌核验。
- **主要风险**：为避让名称引入新的产品命名，扩大首发决策范围。

### 支持矩阵子选项

| 候选 | 优点 | 代价 |
|---|---|---|
| 只支持最新 LTS Node 24 | CI 矩阵最小 | 排除仍在官方维护期的 Node 22 用户 |
| 支持 Node 22/24 | 覆盖当前两个 LTS 主版本；bundle 可按 Node 22 生成 | native dependency 需要双版本验证 |
| 同时支持 Current Node 26 | 提前覆盖新 runtime | Node 官方不建议生产应用使用 Current |

OS 方面比较 Linux only、macOS + Linux、三平台三种范围。Linux only 最省验证成本，
但不覆盖本机桌面主要使用场景；加入 Windows 则必须先解决 POSIX 权限与信号差异。
因此首发选择 macOS 15 arm64/x64 与 Ubuntu 24.04 x64。

### 发布认证子选项

| 候选 | 优点 | 代价 |
|---|---|---|
| 维护者本机 2FA publish | 不向 CI 提供 token | 制品验证与 publish 环境分离，难以证明发布的是同一 tarball |
| 有到期时间的 granular token bootstrap | 首次创建 package 时可由受保护自动化发布同一制品 | 首发期间仍存在可写 token |
| 首发直接用 OIDC | 无长期 token | package 尚不存在时无法先配置 trusted publisher |

首发选择有到期时间的 granular token bootstrap；package 创建后立即迁移 OIDC。

## Decision

选择 Option A：首发只发布 `@moesin-lab/agent-nexus` CLI，六个内部 workspace package
保持 private 并 bundle 进 CLI。

首发边界同时锁定：

- npm version 为 `0.1.0`，dist-tag 为 `latest`，Git tag 为 `v0.1.0`。
- 版本遵循 SemVer，变更记录遵循现有 Keep a Changelog；出现两个以上公共包前不引入 Changesets 或 semantic-release。
- 支持 Node 22 与 24，bundle 以最低支持主版本 Node 22 为 target；不接受已 EOL 或未进入 LTS 的主版本作为首发运行基线。
- 首发支持 macOS 15 arm64/x64 与 Ubuntu 24.04 x64；Windows 暂不支持。
- 首次 publish 使用设有到期时间的 granular npm token；package 创建后迁移到 npm trusted publishing 并移除 token。
- `moesin-lab` npm organization 控制权是创建 `v0.1.0` 与执行 publish 前的人工门禁；registry 404 不替代该确认。

具体打包、验证、tag 与认证步骤由 [`release.md`](../process/release.md) 编排，制品证据
由 [`strategy.md`](../testing/strategy.md) 定义。

## Consequences

### 正向

- 公共兼容面收敛为包名、bin、Node 范围和用户可见 CLI 行为。
- 内部 package 可以继续按仓库架构演进，不需要同步发布。
- 发布自动化可以验证并发布同一 tarball，避免 publish 时再次隐式打包。
- 支持矩阵会真实加载 native SQLite binding，避免配置模板 smoke 假绿。

### 负向

- CLI package 需要直接声明 `better-sqlite3` 等 external 运行时依赖，即使源码所有权位于内部 package。
- 三种 OS / architecture × Node 22/24 会增加 CI 时间。
- 首发仍需要维护者完成 npm organization、GitHub environment 与 token 配置。
- 其他 macOS / Linux 版本与 Windows 可能可以运行，但不属于首发承诺支持范围。

### 需要后续跟进的事

- 首次 publish 后立即配置 npm trusted publisher，并删除 token fallback。
- 出现第二个公共包，或第三方明确需要内部 API 时，重新评估多包发布与版本编排。
- Node 22 进入 EOL 前，按 Node.js 官方发布计划更新支持矩阵和 bundle target。
- 扩大 OS / architecture 支持范围前，补齐对应的 pack、install、bin 与 native dependency 证据。

## Out of scope

- 不执行 `npm publish`、创建 Git tag 或 GitHub Release。
- 不定义内部 package 的公共 API 或未来何时公开它们。
- 不决定单二进制、Homebrew、Docker 或其他分发渠道。
- 不保证 registry 404 的 scoped package 已为本项目保留。
- 不承诺 Decision 之外的 OS 版本、架构或 libc。

## Amendments

- 无。

## 参考

- 相关 issue：[#187](https://github.com/moesin-lab/agent-nexus/issues/187)
- [Node.js 官方发布状态](https://nodejs.org/en/about/previous-releases)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
