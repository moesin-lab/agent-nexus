# @moesin-lab/agent-nexus

在本机运行 agent-nexus，把 Discord 或中国版飞书消息路由到已登录的 Claude Code CLI、Codex exec 或持久 Codex app-server backend。

## 安装

需要 Node.js 22 或 24，以及至少一个已安装并登录的 agent CLI。使用 `codex-app-server` backend 时，当前必须安装精确的 `codex-cli 0.146.0`；该 backend 使用独立持久 thread，且默认不启用 supplemental TUI viewer。

```bash
npm install -g @moesin-lab/agent-nexus
agent-nexus
```

首次运行会在 `~/.agent-nexus/` 下创建配置和密钥模板。按提示配置 Discord bot 或中国版飞书自建应用、访问
allowlist、目标会话和 agent 工作目录后，再次运行 `agent-nexus`。

首发验证范围为 Ubuntu 24.04 x64、macOS 15 arm64 和 macOS 15 x64；暂不承诺 Windows 支持。

完整配置、权限边界与排障说明见
[用户指南](https://github.com/moesin-lab/agent-nexus/blob/main/docs/product/user-guide.md)、
[Discord 配置](https://github.com/moesin-lab/agent-nexus/blob/main/docs/product/platforms/discord.md)、
[飞书配置](https://github.com/moesin-lab/agent-nexus/blob/main/docs/product/platforms/lark.md)和
[运维手册](https://github.com/moesin-lab/agent-nexus/blob/main/docs/ops/runbook.md)。

## License

[MIT](LICENSE)
