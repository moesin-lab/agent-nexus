---
title: 发版流程
type: process
status: active
summary: npm CLI 二进制包的本地打包、验证与发布前检查流程；版本号和正式发布渠道仍需单独 ADR 决策
tags: [release, process]
related:
  - dev/process/commit-and-branch
  - dev/adr/0004-language-runtime
---

# 发版流程

## 当前产物

MVP 的可安装产物是 `@agent-nexus/cli` npm 包。该包提供 `agent-nexus` 二进制入口，并在打包时把 monorepo 内部 `@agent-nexus/*` package bundle 进 `dist/index.js`；运行时只依赖 npm 可安装的第三方包。

本流程只定义本地 tarball 与 npm 包发布前检查。正式版本号策略、tag 策略、npm organization / channel 与 release announcement 仍需单独 ADR 或 owner 决策。

## 本地打包

```bash
pnpm install
pnpm build
pnpm pack:cli
```

`pnpm pack:cli` 产物位于 `packages/cli/agent-nexus-cli-*.tgz`。

## 安装验证

每次改变 CLI 入口、package metadata、bundle 配置或运行时依赖时，PR 必须验证 tarball 安装后的二进制入口：

```bash
tmp="$(mktemp -d)"
export HOME="$tmp/home"
npm install --prefix "$tmp/install" packages/cli/agent-nexus-cli-*.tgz
"$tmp/install/node_modules/.bin/agent-nexus"
```

在没有真实配置的环境里，二进制可以以配置模板创建提示退出；验收重点是：

- npm 安装成功
- bin shim 能启动到应用自己的配置校验，而不是因 workspace 依赖或 shebang / 权限问题在 Node loader 阶段失败
- `~/.agent-nexus/` 与 `~/.agent-nexus/secrets/` 被创建为 `0700`
- `~/.agent-nexus/config.json` 与 `~/.agent-nexus/secrets/DISCORD_BOT_TOKEN` 被创建为 `0600`

## 发布前检查

发布候选必须至少通过：

- `pnpm build`
- `pnpm test`
- `pnpm pack:cli`
- tarball 安装验证
- `git diff --check`

涉及 ADR、spec、process 或 security 文档的发布 PR 仍按对应 owner 文档要求补 review 证据；本流程不降低代码 review 与安全 review 要求。
