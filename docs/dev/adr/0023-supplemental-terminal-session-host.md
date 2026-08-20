---
title: ADR-0023：补充终端会话采用窄接口与可替换 PTY/tmux 适配器
type: adr
status: active
summary: Codex remote TUI 首版仅作为结构化 app-server 的可选 passive viewer；内部定义窄会话接口，PTY 与 tmux 分别承担短生命周期和可重连托管，人工接管另立契约
tags: [adr, terminal, tui, pty, tmux, codex]
related:
  - dev/adr/0022-codex-app-server-primary-tui-supplemental
  - dev/spec/agent-backends/codex-app-server
  - dev/spec/security/tool-boundary
  - dev/architecture/session-model
adr_status: Proposed
adr_number: "0023"
decision_date: 2026-07-31
supersedes: null
superseded_by: null
---

# ADR-0023：补充终端会话采用窄接口与可替换 PTY/tmux 适配器

- **状态**：Proposed
- **日期**：2026-07-31
- **决策者**：senticx@foxmail.com
- **相关 ADR**：ADR-0022

## 状态变更日志

- 2026-07-31：Proposed

## Context

ADR-0022 已确定 Codex `app-server` 是跨 turn 输入、输出、状态和控制的唯一业务事实源，同时把真实 TUI viewer、durable mux 与人工 attach 留给后续决策。当前还需要满足两类补充需求：操作者查看 Codex 原生界面并进行 UI-only 操作，以及未来为没有 structured server 的 CLI 承载真实终端。

botmux 的 MIT hybrid 实现证明：一个 WebSocket app-server 可以让控制连接创建 turn，同时让 `codex --remote ... resume <threadId>` TUI 接收同一 thread 的广播；tmux 只负责 viewer 常驻和人工 attach。该实现也暴露了边界：app-server 重启后旧 pane 仍指向失效端口，必须重建 viewer；其自动批准、全环境继承和 `danger-full-access` 不符合本项目安全模型，不能复制。

公开 TypeScript 方案处于不同层次。本次评估固定在 `pty-manager@1.12.1`、`tmux-manager@0.1.3`、MaxMux `0.4.3` 与 `@xterm/headless@6.0.0`。`pty-manager` README 声明基于 `node-pty`，提供生命周期、raw attach、按键和 bracketed paste；`tmux-manager` README 声明以相似接口委托系统 tmux，但其文档中的 `reconnect()` 示例与公开 API 列表不一致，本项目尚未验证 daemon crash 后的重连；MaxMux 是 Bun 上的完整终端应用，不是稳定的可嵌入会话库；`@xterm/headless` 只负责解释终端字节流，不负责进程持久化。把任一上游声明称为本项目已验证能力，或把任一方案称为完整替代品，都会混淆 PTY、终端模拟器与 multiplexer。

Codex remote viewer 要求 app-server 改用 WebSocket 或 Unix socket，而当前主路径使用不可被其它进程连接的匿名 stdio。重新核对 Codex 0.146.0 后确认其正式暴露 `--ws-auth capability-token`、`--ws-token-file`、`--ws-token-sha256` 与客户端 `--remote-auth-token-env`。本项目用 disposable home 做了真实握手探针：无 token 的 loopback WebSocket upgrade 返回 `401`，正确 bearer token 返回 `101`。因此“0.146.0 没有可验证认证”的旧前提不成立，但 bearer token 同时授予完整 app-server client 能力，仍必须按高权限控制 secret 管理。

## Options

### Option A：复制 botmux 的 tmux hybrid

- **是什么**：直接移植其 WebSocket app-server、remote TUI 和 tmux 生命周期。
- **优点**：已存在真实使用路径；本地 `tmux attach` 简单。
- **缺点**：同时继承高权限配置、生命周期耦合和 pane 管理细节；难以独立验证安全不变量。
- **主要风险**：把参考实现的信任模型一并复制，或让 viewer 状态覆盖 structured state。

### Option B：直接采用 MaxMux 作为内嵌 mux

- **是什么**：daemon 启动 MaxMux/Bun server，由其管理全部 TUI session。
- **优点**：TypeScript 实现，已有 client-server 和 headless terminal 组合。
- **缺点**：它是独立应用而非窄库；引入第二运行时和自身 UI/协议；版本仍早期。
- **主要风险**：依赖面大于所需能力，升级和安全边界由外部应用决定。

### Option C：内部窄接口，PTY 与 tmux 可替换

- **是什么**：项目只定义 spawn、write/paste、sendKeys、resize、snapshot、attach descriptor、stop 的 terminal-session contract；短生命周期实现参考 `pty-manager`，需要 shell attach/restart-survival 时对 `tmux-manager` 或等价 tmux adapter 先做采用 probe。
- **优点**：业务层不依赖具体 mux；可以分别测试终端字节、生命周期和持久化；保留替换底层的空间。
- **缺点**：需要维护一层很薄的适配代码；PTY 与 tmux 的能力并不完全对称。
- **主要风险**：若接口泄漏 pane/screen 细节，会再次把弱观察变成业务协议。

### Option D：只保留 app-server，不实现 viewer

- **是什么**：不提供 TUI、attach 或通用 PTY host。
- **优点**：攻击面和实现量最小。
- **缺点**：无法满足人工接管与 CLI-only 操作目标，也不能复用既有 probe 结论。
- **主要风险**：结构化协议未覆盖的交互长期没有操作面。

## Decision

选 **Option C**：定义 provider-neutral 的窄 terminal-session contract，PTY 与 tmux 作为可替换适配器；Codex remote TUI 仅为显式启用的 supplemental viewer，永远不成为业务状态源。首个 stable Codex adapter 只提供 passive observation，不暴露 write 或可写 attach；人工输入/接管后置到 foreign-turn admission 与审计 contract 完成之后。

首个稳定实现不得依赖 TUI 文本判断 turn 完成、approval 或 usage。terminal snapshot 只标记为 observation；所有飞书回复和控制结果继续来自 app-server。viewer 与 app-server incarnation 绑定，app-server 重启必须销毁并重建 viewer，不能重新使用指向旧 endpoint 的 pane。

remote viewer 默认关闭。接入真实 backend 时必须使用 Codex capability-token admission：每个 app-server incarnation 生成独立的至少 256-bit token，只监听 loopback，token 文件 mode `0600`，controller 与 viewer 都通过 bearer token 连接。未知、缺失或旧 incarnation token 必须 fail closed；token 不得进入 argv、attach descriptor、日志、snapshot、registry 或平台消息。随机端口、conversation-private home、最小 child environment、首连接绑定或连接数限制都不能单独替代认证。

controller 与 viewer 在协议层都是授权的完整 app-server client，因此 adapter 必须把 viewer 限制为 passive observation surface。viewer 只在操作者显式启用时创建，并与 `(homeId, appServerIncarnation, threadId)` 绑定；旧 token、旧 endpoint 或旧 pane 不得用于新 incarnation。任何 foreign turn 都 fail closed，不能归到平台 trace。实现仍不得监听非 loopback 地址、把 `ws://` 暴露给远端、自动批准请求，或把 viewer observation 提升为业务状态。跨机器访问不属于本 ADR；需要时另行采用 `wss://`/SSH 转发并重新评审。

对第三方实现只借鉴公开接口和行为。若后续复制 substantial source，源文件和发行物必须保留对应 copyright、MIT notice 与上游 commit；仅使用 npm dependency 时按依赖许可证清单归属。

## Consequences

### 正向

- agent runtime 与飞书消息流不感知 tmux pane、ANSI chrome 或 prompt pattern。
- 可以先用 fake adapter 覆盖隔离、重建与失败路径，再分别做真实 PTY、tmux 和 Codex remote probe。
- 首个 stable adapter 只提供 passive snapshot/read-only attach；可写 operator attach 后置，不能借 viewer 名义绕过 structured ownership。
- MaxMux、pty-manager 或 tmux-manager 可替换，不锁定完整外部应用协议。

### 负向

- remote viewer 需要将 stdio app-server 切换为 authenticated loopback WebSocket，controller transport、token 生命周期与 viewer 必须同一 incarnation 原子启动和清理。
- 原生 shell attach 仍依赖系统 tmux；纯 TypeScript PTY 需要另一个受认证终端前端才能人工操作。
- 大历史 resume、viewer 重建、端口抢占和本机非授权连接都需要真实测试。

### 需要后续跟进的事

- 新增 terminal-session spec，定义能力、状态、错误、owner token 与 snapshot 的弱证据语义。
- probe 固定版本的 `pty-manager`、`tmux-manager` 与 Codex 0.146.0 remote viewer，验证实际 API、广播、resize、Ctrl-C、重建和大历史；上游 README 声明不算通过。
- 在采用 tmux adapter 前，以真实 daemon crash/restart contract test 证明 session discovery、owner 校验和 reconnect；API 不满足时实现更窄的直接 tmux adapter。
- 为 capability-token listener 增加无 token、错误 token、旧 token、非 loopback、token 泄漏与双 client 广播对抗测试；任何一项失败都回退 stdio 主路径。
- 发布前生成第三方许可证清单，并审计 botmux substantial-copy 情况。

## Out of scope

- 不改变 app-server 作为 Codex 业务事实源的决定。
- 不在本 ADR 定义 Web terminal UI、飞书按钮或公开网络访问。
- 不承诺恢复 daemon crash 时正在执行的 turn 或交互请求。
- 不决定 Claude Code 是否采用同一 structured-primary 模式。
- 不把 prompt detection、screen scraping 或 idle heuristic 提升为强事件。

## Amendments

- 2026-07-31：Codex 0.146.0 官方 CLI 与真实握手探针确认 capability-token admission；解除“无认证只能 disposable probe”的前提，改为受认证 loopback remote viewer 门禁。
- 2026-08-20：配置面收敛为 restart-only `supplementalViewer.enabled`，默认关闭；viewer 采用 Codex 专用 fixed launcher 从 private token file 注入 secret，generic terminal host 继续拒绝 Codex token env。已确认无残留的 availability/crash 只禁用 viewer；无法确认退出时仍撤销 token并结束 structured host，但 stop barrier reject且不假报 cleanup success。

## 参考

- botmux pinned hybrid：<https://github.com/deepcoldy/botmux/blob/0afba71643270504a22551800b0196c752f412d9/src/codex-rpc-engine.ts>
- pty-manager `1.12.1`：<https://www.npmjs.com/package/pty-manager/v/1.12.1>
- tmux-manager `0.1.3`：<https://www.npmjs.com/package/tmux-manager/v/0.1.3>
- MaxMux `0.4.3`：<https://www.npmjs.com/package/@maxischmaxi/maxmux/v/0.4.3>
- xterm.js headless `6.0.0`：<https://www.npmjs.com/package/@xterm/headless/v/6.0.0>
- Codex CLI reference：<https://developers.openai.com/codex/cli/reference>
- Codex app-server daemon：<https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md>
- Codex remote 大历史风险：<https://github.com/openai/codex/issues/19837>
- 相关决策：[`0022-codex-app-server-primary-tui-supplemental.md`](0022-codex-app-server-primary-tui-supplemental.md)
