---
title: 中国版飞书使用手册
type: product
status: active
summary: 中国版飞书自建应用、长连接事件、密钥、ID 与 agent-nexus 配置步骤
tags: [product, lark, feishu, user-guide]
related:
  - product/user-guide
  - dev/adr/0019-lark-platform-via-official-node-sdk
  - dev/spec/platform-adapter
  - dev/spec/security/secrets
---

# 中国版飞书使用手册

这页只适用于中国版飞书，开放平台域名固定为 `open.feishu.cn`。当前不支持国际版 Lark，也没有域名切换配置。

首版能力边界：

- 只接收机器人与用户的单聊（P2P）纯文本消息
- 只发送纯文本消息，长回复按 4000 个 UTF-16 code unit 切片
- 支持把纯文本 `/new` 或 `/new <prompt>` 作为新会话入口
- 不支持群聊、图片/文件、卡片、富文本、消息编辑、删除、reaction、typing indicator 或飞书 slash command

## 创建飞书自建应用

首次运行 `agent-nexus` 时，终端会输出下面这个完整链接。常见终端可直接点击；SSH、CI 或日志中也能复制原始 URL：

<https://open.feishu.cn/page/launcher?from=backend_oneclick>

1. 打开上面的[飞书官方创建入口](https://open.feishu.cn/page/launcher?from=backend_oneclick)，创建企业自建应用。
2. 在应用能力中启用机器人。
3. 在权限管理中开通接收用户发给机器人的单聊消息，以及以应用身份发送消息所需的最小权限。
4. 在事件与回调中选择“使用长连接接收事件”，订阅 `im.message.receive_v1`。
5. 创建并发布一个应用版本，把测试用户加入可用范围。
6. 在“凭证与基础信息”复制 `App ID` 和 `App Secret`。`App Secret` 只写入本机 secret 文件，不写进 `config.json`。

飞书官方的 [Echo Bot 教程](https://open.feishu.cn/document/develop-an-echo-bot/explanation-of-example-code?lang=zh-CN) 展示了 Node SDK 的 `Client`、`WSClient`、`EventDispatcher`、`im.message.receive_v1` 和发送消息 API。agent-nexus 使用同一套官方长连接与消息接口。

## 获取 bot open_id

配置中的 `botOpenId` 是机器人自身的 `open_id`，不是应用 `App ID`，也不是操作者的用户 `open_id`。可以用应用凭证调用飞书接口获取：

```bash
FEISHU_APP_ID='cli_0123456789abcdef'
FEISHU_APP_SECRET="$(tr -d '\n' < ~/.agent-nexus/secrets/FEISHU_APP_SECRET)"
export FEISHU_APP_ID FEISHU_APP_SECRET
FEISHU_TENANT_TOKEN="$(
  jq -n '{app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET}' \
    | curl -fsS \
      -H 'Content-Type: application/json; charset=utf-8' \
      --data-binary @- \
      https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
    | jq -r '.tenant_access_token'
)"
curl -fsS \
  -H "Authorization: Bearer ${FEISHU_TENANT_TOKEN}" \
  https://open.feishu.cn/open-apis/bot/v3/info \
  | jq -r '.bot.open_id'
unset FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_TENANT_TOKEN
```

命令依赖 `curl` 和 `jq`。启动时 agent-nexus 会再次调用 bot info 接口，实际 `open_id` 与 `botOpenId` 不一致时以 `lark_bot_identity_mismatch` 拒绝启动。

## 写入密钥

```bash
mkdir -p ~/.agent-nexus/secrets
chmod 700 ~/.agent-nexus ~/.agent-nexus/secrets
printf '%s' '<your-feishu-app-secret>' \
  > ~/.agent-nexus/secrets/FEISHU_APP_SECRET
chmod 600 ~/.agent-nexus/secrets/FEISHU_APP_SECRET
```

`appSecretRef` 填 secret 文件名 `FEISHU_APP_SECRET`，不要填 App Secret 明文。

## 配置 agent-nexus

下面只展示飞书相关片段；`agents[]`、`daemon`、`ui` 和 `log` 仍按[用户指南](../user-guide.md)配置：

```json
{
  "platforms": [
    {
      "name": "feishu-main",
      "type": "lark",
      "appId": "cli_0123456789abcdef",
      "appSecretRef": "FEISHU_APP_SECRET",
      "botOpenId": "ou_actual_bot_open_id",
      "auth": {
        "allowlist": {
          "userIds": ["ou_allowed_user_open_id"],
          "roleIds": [],
          "allowedGuildIds": [],
          "allowedChannelIds": [],
          "allowDM": true,
          "requireMentionOrSlash": false
        }
      }
    }
  ],
  "bindings": [
    {
      "name": "feishu-main-codex-dev",
      "platformName": "feishu-main",
      "agentName": "codex-dev",
      "match": {
        "lark": {
          "chatIds": ["oc_p2p_chat_id"]
        }
      }
    }
  ]
}
```

飞书 P2P 必须显式配置非空 `auth.allowlist.userIds` 和 `match.lark.chatIds`。前者是允许使用机器人的用户 `open_id`，后者是对应单聊的 `chat_id`；两层校验都会生效。

如果暂时不知道这两个 ID：

1. 先给 `chatIds` 和 `userIds` 填语法合法的临时值并启动。
2. 给机器人发送一条单聊消息；`route_not_found` 日志中的 `channelId` 就是该会话 `chat_id`。
3. 更新 `chatIds` 并重启，再发一条消息；`auth_denied` 日志中的 `userId` 就是发送者 `open_id`。
4. 把该 `open_id` 加入 `userIds`，重启后再次验证。

## 启动与验证

```bash
agent-nexus
```

启动成功时应看到：

- `platform_connection_ready`，且 `platform=lark`
- `engine_started`

在飞书里给机器人发送：

```text
ping
/new 从一个新会话开始
```

机器人能返回纯文本即表示接入成功。飞书长连接不需要公网 webhook 或本机监听端口。

同一个飞书应用不要同时启动多个 agent-nexus 进程。官方长连接会在同应用的多个客户端间分发事件，不会向每个客户端广播；要路由到多个 agent，应在同一 platform 下增加 bindings。
