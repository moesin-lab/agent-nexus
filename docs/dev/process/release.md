---
title: 发版流程
type: process
status: active
summary: 单一公开 npm CLI 的候选制品验证、0.1.0 tag、受保护首发与后续 OIDC 迁移流程
tags: [release, process, npm, cli]
related:
  - dev/process/commit-and-branch
  - dev/testing/strategy
  - dev/adr/0020-publish-single-npm-cli-package
---

# 发版流程

## 发布边界

MVP 唯一公开产物是 `@moesin-lab/agent-nexus`。它提供 `agent-nexus` 二进制，把五个内部 `@agent-nexus/*` workspace package bundle 进 `dist/index.js`；内部 package 保持 `private: true`。

首发版本是 `0.1.0`，Git tag 是 `v0.1.0`，npm dist-tag 是 `latest`。支持范围与认证迁移决策见 [ADR-0020](../adr/0020-publish-single-npm-cli-package.md)。

## 本地候选验证

从干净 checkout 执行：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm pack:cli
node scripts/verify-packed-cli.mjs packages/cli/moesin-lab-agent-nexus-0.1.0.tgz
git diff --check
```

验证器安装并复验传入的同一个 tarball，包括包内容、bin 权限、内部 workspace bundle 边界、`better-sqlite3` 原生查询和首次启动脚手架。证据定义与 CI 矩阵见 [`../testing/strategy.md` §发布制品验证](../testing/strategy.md#发布制品验证)。

## 首发前一次性配置

1. npm 组织管理员确认当前账号控制 `moesin-lab`，并确认执行首发的用户具有该 scope 的 package publish 权限。仅有 organization 管理权限不自动授予 package publish 权限；未登录查询得到 404 也不能作为控制权证据。
2. 为该用户创建一天有效、只允许 `@moesin-lab` scope read/write 的 npm granular access token，并显式启用 bypass 2FA。npm 的非交互 publish 要求这个选项；token 仅放入受保护的部署 environment，首发结束后立即撤销。细节见 [npm access token](https://docs.npmjs.com/about-access-tokens/) 与 [2FA publish 要求](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)。
3. 在 GitHub 创建 `npm-production` environment：
   - 配置 required reviewers；
   - deployment branch/tag policy 只允许受保护的 `v*` tag；
   - 添加 environment secret `NPM_TOKEN`。
4. 为 `refs/tags/v*` 配置 repository ruleset：限制创建权限，并禁止更新和删除。environment 的 tag filter 只控制部署，不替代 tag 不可变保护。
5. 确认默认分支已包含 `.github/workflows/publish-npm.yml`，且所有分支保护和 CI 通过；发布 workflow 的第三方 Actions 必须继续固定到完整 commit SHA。

## 发布 0.1.0

1. 确认 `CHANGELOG.md` 已把本次内容归入带日期的 `0.1.0`，CLI manifest 版本为 `0.1.0`。
2. 从已通过保护的 `main` commit 创建 annotated tag `v0.1.0` 并推送；tag 不指向未合入的发布分支。
3. 在 GitHub Actions 选择 **Publish npm CLI**，从 `v0.1.0` tag 手动触发，并在输入框填写 `0.1.0`。
4. environment reviewer 核对 tag、commit、CI 与 npm scope 后批准。
5. 无 secret 的 build job 重新 build/test，生成 tarball，用统一验证器复验同一文件，并上传带 SHA-256 的短期 artifact。受保护的 publish job 下载该 artifact、核对 build job 输出的 digest，再执行：

   ```bash
   npm publish packages/cli/moesin-lab-agent-nexus-0.1.0.tgz \
     --access public \
     --tag latest
   ```

6. 发布后核对：
   - `npm view @moesin-lab/agent-nexus version dist-tags engines`;
   - 在干净 Node.js 22 与 24 环境执行 `npm install -g @moesin-lab/agent-nexus`；
   - GitHub tag、npm version 和 changelog 三者均为 `0.1.0`。
7. 撤销首发 token，并移除 `NPM_TOKEN` environment secret。

同一版本不可覆盖。任一步失败时不要移动 tag 或改写已发布版本；修复后递增 patch 版本重新走完整流程。

## 首发后迁移 OIDC

包创建成功后，在 npm package settings 中添加 GitHub Actions trusted publisher：

- organization/user：`moesin-lab`
- repository：`agent-nexus`
- workflow filename：`publish-npm.yml`
- environment：`npm-production`
- allowed action：`npm publish`

然后只在受 `npm-production` environment 保护的 `publish` job 中增加 `permissions: { contents: read, id-token: write }`，顶层与无 secret 的 build job 继续保持 `contents: read`；同时移除 publish step 的 `NODE_AUTH_TOKEN`，并确保 Node.js 不低于 22.14、npm CLI 不低于 11.5.1。合并并验证 OIDC 发布后，不再恢复长期 npm token。

## 不在本流程内

- 不发布内部 workspace package；
- 不自动创建 tag 或绕过 environment approval；
- 不在首发阶段引入 Changesets、semantic-release 或 Windows 支持承诺；
- GitHub Release 文案与公告可在 npm 发布成功后另行创建。
