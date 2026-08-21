---
title: 中国版飞书使用手册
type: product
status: active
summary: 中国版飞书自建应用、长连接事件、密钥、ID 与 agent-nexus 配置步骤
tags: [product, lark, feishu, user-guide]
related:
  - product/user-guide
  - dev/adr/0019-lark-platform-via-official-node-sdk
  - dev/adr/0021-lark-thread-as-session-container
  - dev/spec/platform-adapter
  - dev/spec/security/secrets
---

# 中国版飞书使用手册

这页只适用于中国版飞书，开放平台域名固定为 `open.feishu.cn`。当前不支持国际版 Lark，也没有域名切换配置。

能力边界：

- 接收机器人与用户的单聊（P2P）、群主时间线控制文本，以及话题群中带 `thread_id` 的 Session 文本
- 一个飞书话题固定对应一个 Session；P2P 与群主时间线普通文本静默拒绝，不会进入 agent
- 只发送纯文本消息，长回复按 4000 个 UTF-16 code unit 切片
- `/new` 与 `/new <prompt>` 只提示新建话题，不在现有话题或 P2P 下生成第二个 Session
- 保存话题根消息 AppLink，`/nexus-sessions` 可引导回原话题；当前引用仍只在 daemon 内存中，进程重启会丢失列表
- 不支持图片/文件、卡片、富文本、消息编辑、删除、reaction、typing indicator 或飞书原生 slash command

## 创建飞书自建应用

首次运行 `agent-nexus` 时，终端会输出下面这个完整链接。常见终端可直接点击；SSH、CI 或日志中也能复制原始 URL：

<https://open.feishu.cn/page/launcher?from=backend_oneclick>

1. 打开上面的[飞书官方创建入口](https://open.feishu.cn/page/launcher?from=backend_oneclick)，创建企业自建应用。
2. 在应用能力中启用机器人。
3. 在权限管理中开通单聊消息、群聊中 @机器人的消息和 bot 发消息所需的最小权限；群消息接收至少使用
   `im:message.group_at_msg:readonly`。若希望话题内不必每条都 @机器人，再申请敏感权限
   `im:message.group_msg`。
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
          "chatIds": ["oc_topic_group_chat_id"]
        }
      }
    }
  ]
}
```

飞书必须显式配置非空 `auth.allowlist.userIds` 和 `match.lark.chatIds`。前者是允许使用机器人的用户 `open_id`；
后者可以包含 P2P `chat_id` 或私有话题群的父 `chat_id`。话题 `thread_id` 不需要逐个写入配置：它继承父群的
binding 与 auth，但 session、queue 和 agent conversation ref 都按 `thread_id` 隔离。

如果暂时不知道这两个 ID：

1. 先给 `chatIds` 和 `userIds` 填语法合法的临时值并启动。
2. 在 P2P 或群主时间线发送精确命令 `/nexus-sessions`；`route_not_found` 日志中的 `channelId` 就是该会话或父群 `chat_id`。普通文本会在 route 前静默终止，不能用于发现 ID。
3. 更新 `chatIds` 并重启，再发 `/nexus-sessions`；`auth_denied` 日志中的 `userId` 就是发送者 `open_id`。
4. 把该 `open_id` 加入 `userIds`，重启后再次验证。

## 创建 session 话题群

1. 在飞书中新建一个私有话题群，把机器人和允许使用的用户加入群聊。
2. 确认群消息模式是“话题”；普通群的平铺消息不会被 agent-nexus 接收为 session。
3. 在群里 @机器人发送一条话题消息，从 `route_not_found` 日志取得父群 `chat_id`。
4. 把父 `chat_id` 加入对应 binding 的 `match.lark.chatIds` 并重启。
5. 新建两个话题并分别发送不同 prompt；机器人回复应留在原话题，两个话题的上下文互不影响。

若应用已获“接收群聊全部消息”权限并发布生效，话题内无需每条 @机器人；否则使用 @机器人触发。群主时间线消息
即使 @机器人也不会作为 prompt 进入 agent，必须创建或进入话题。话题第一次进入 daemon 后即固定绑定一个
Session 和当时命中的 agent 实例；后续配置热更新不会把已有话题切到另一实例。需要新上下文时新建话题，不在原话题执行 `/new`。

## 启动与验证

```bash
agent-nexus
```

启动成功时应看到：

- `platform_connection_ready`，且 `platform=lark`
- `engine_started`

在飞书里给机器人发送：

```text
P2P：/nexus-sessions
话题：ping
```

P2P 应返回可恢复话题列表或 `[no resumable sessions]`；话题中的 `ping` 应收到留在原话题的回复。P2P 或群主
时间线发送普通文本时没有任何回复，这是预期行为。飞书长连接不需要公网 webhook 或本机监听端口。

飞书没有可注册的原生 slash command。P2P/群主时间线的首批控制入口是 `/nexus-sessions`；`/new` 与
`/new <prompt>` 只返回“请新建话题”指引。普通文本、未知 `/foo` 和未列入控制面的命令均静默拒绝。话题内
`/status`、`/stop` 仍控制该话题的后端任务；`/new`、`/kill` 与 `/nexus-kill` 不会替换或归档固定 Session。

`/nexus-sessions` 优先展示飞书返回的精确根消息 AppLink；链接读取暂时失败时降级显示父群入口和
`thread_id/root_id`，在原话题再发一条消息会重试补齐。

同一个飞书应用不要同时启动多个 agent-nexus 进程。官方长连接会在同应用的多个客户端间分发事件，不会向每个客户端广播；要路由到多个 agent，应在同一 platform 下增加 bindings。
