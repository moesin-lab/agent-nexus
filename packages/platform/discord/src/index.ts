// TODO MVP 跳过：
// - DM 消息（intents 没开 DirectMessages）
// - 长文本切片保留代码块边界 → docs/dev/spec/message-protocol.md §文本切片
// - edit / delete / react / typing → spec/platform-adapter.md 各对应段
// - threads / interactions / slash commands → 同上

import { randomUUID } from 'node:crypto';
import { Client, GatewayIntentBits, type Message } from 'discord.js';
import type {
  CapabilitySet,
  EventHandler,
  MessageRef,
  NormalizedEvent,
  OutboundMessage,
  PlatformAdapter,
  SessionKey,
} from '@agent-nexus/protocol';
import type { Logger } from '@agent-nexus/daemon';

export interface DiscordPlatformOptions {
  token: string;
  botUserId: string;
  logger: Logger;
}

export const SLICE_SIZE = 1900;

/**
 * Exported for tests. Splits arbitrary text into chunks of `sliceSize`.
 * Empty input returns `['']` so callers always have at least one sendable message.
 */
export function buildSlices(text: string, sliceSize: number = SLICE_SIZE): string[] {
  if (text.length === 0) return [''];
  const slices: string[] = [];
  for (let i = 0; i < text.length; i += sliceSize) {
    slices.push(text.slice(i, i + sliceSize));
  }
  return slices;
}

/**
 * 已 export 用于测试。给 botUserId 构造只剥**本机器人**自身 mention 的正则。
 *
 * 旧实现 `/<@!?\d+>/g` 一刀切：用户写 `@bot summarise what @alice said` 会被剥成
 * `summarise what said`——丢失对其他用户的引用语义。新版只剥 botUserId 对应的两种
 * mention 形式（`<@id>` / `<@!id>`），保留其他 @mention 给 CC 看到原文。
 *
 * botUserId 来自 config（信任域内）+ Discord ID 是 snowflake 纯数字，理论无 regex
 * 元字符；仍做一次保守 escape 避免未来类型/校验放宽时引入注入。
 */
export function buildBotMentionRegex(botUserId: string): RegExp {
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<@!?${escaped}>`, 'g');
}

/**
 * 已 export 用于测试。msg → NormalizedEvent | null：null 表示不该派给 daemon。
 *
 * 过滤顺序：
 *   1. 任意 bot 发的（含本机器人）→ null
 *   2. 与 botUserId 同 id 的 author → null（防御 bot 标志位被绕）
 *   3. 没显式 @ 本机器人 → null
 *   4. 否则剥本机器人 mention，构造事件
 */
export function parseInbound(
  msg: Message,
  botUserId: string,
): NormalizedEvent | null {
  if (msg.author.bot === true) return null;
  if (msg.author.id === botUserId) return null;

  const mentionPlain = `<@${botUserId}>`;
  const mentionNick = `<@!${botUserId}>`;
  if (
    !msg.content.includes(mentionPlain) &&
    !msg.content.includes(mentionNick)
  ) {
    return null;
  }

  const text = msg.content.replace(buildBotMentionRegex(botUserId), '').trim();

  const sessionKey: SessionKey = {
    platform: 'discord',
    channelId: msg.channelId,
    initiatorUserId: msg.author.id,
  };
  return {
    eventId: msg.id,
    platform: 'discord',
    sessionKey,
    messageId: msg.id,
    traceId: randomUUID(),
    type: 'message',
    text,
    receivedAt: new Date(),
    platformTimestamp: msg.createdAt,
    initiator: {
      userId: msg.author.id,
      displayName: msg.author.username,
      isBot: false,
    },
    rawPayload: msg,
    rawContentType: 'discord:message',
  };
}

export function createDiscordPlatform(opts: DiscordPlatformOptions): PlatformAdapter {
  const { token, botUserId, logger } = opts;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  let started = false;
  let stopped = false;

  return {
    name() {
      return 'discord';
    },

    capabilities(): CapabilitySet {
      return {
        maxTextLength: 2000,
        supportsEdit: false,
        supportsDelete: false,
        supportsReactions: false,
        supportsEmbeds: false,
        supportsButtons: false,
        supportsThreads: false,
        supportsEphemeral: false,
        supportsAttachments: false,
        maxAttachmentsPerMessage: 0,
        supportsTypingIndicator: false,
      };
    },

    async start(handler: EventHandler): Promise<void> {
      if (started) return;
      started = true;

      client.on('ready', () => {
        logger.info({ user: client.user?.tag }, 'discord_ready');
      });

      client.on('messageCreate', async (msg: Message) => {
        const event = parseInbound(msg, botUserId);
        if (!event) return;

        try {
          await handler(event);
        } catch (err) {
          // 不重抛——保持事件循环
          logger.error(
            { err, traceId: event.traceId, messageId: msg.id },
            'platform_handler_error',
          );
        }
      });

      await client.login(token);
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await client.destroy();
    },

    async send(sessionKey: SessionKey, message: OutboundMessage): Promise<MessageRef> {
      const channel = await client.channels.fetch(sessionKey.channelId);
      if (!channel || !channel.isTextBased()) {
        throw new Error(
          `platform-discord: channel ${sessionKey.channelId} is not text-based or not found`,
        );
      }
      // isSendable 进一步收窄到具备 send 方法的具体频道类型，
      // 避免在 TextBasedChannel union 上调 send 时的重载分裂问题
      if (!channel.isSendable()) {
        throw new Error(
          `platform-discord: channel ${sessionKey.channelId} is text-based but not sendable`,
        );
      }

      // 文本切片：朴素按 1900 切（保 2000 上限的余量），
      // TODO 保代码块边界 → docs/dev/spec/message-protocol.md §文本切片
      const slices = buildSlices(message.text);

      const sentIds: string[] = [];
      for (const slice of slices) {
        const msg = await channel.send(slice);
        sentIds.push(msg.id);
      }

      if (sentIds.length === 0) {
        // 理论上不会到这里——slices 至少 1 个
        throw new Error('platform-discord: send produced no message');
      }

      // Collect every slice's ID into messageIds; messageId points at the last one (single-slice compat)
      // → docs/dev/spec/platform-adapter.md §MessageRef
      const lastId = sentIds[sentIds.length - 1];
      return {
        platform: 'discord',
        channelId: sessionKey.channelId,
        messageId: lastId,
        messageIds: sentIds,
        sentAt: new Date(),
      };
    },

    async edit(): Promise<void> {
      throw new Error('platform-discord MVP: edit not supported');
    },

    async delete(): Promise<void> {
      throw new Error('platform-discord MVP: delete not supported');
    },

    async react(): Promise<void> {
      throw new Error('platform-discord MVP: react not supported');
    },
  };
}
