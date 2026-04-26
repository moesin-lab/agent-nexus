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

const SLICE_SIZE = 1900;

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

  function buildEvent(msg: Message, text: string): NormalizedEvent {
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
        // 跳过自身 / 任意 bot 发的消息
        if (msg.author.bot === true) return;
        if (msg.author.id === botUserId) return;

        // 必须显式 mention 机器人（两种 Discord mention 形式）
        const mentionPlain = `<@${botUserId}>`;
        const mentionNick = `<@!${botUserId}>`;
        if (!msg.content.includes(mentionPlain) && !msg.content.includes(mentionNick)) {
          return;
        }

        // 剥所有 mention，得到纯净 text
        const text = msg.content.replace(/<@!?\d+>/g, '').trim();

        const event = buildEvent(msg, text);

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
      const text = message.text;
      const slices: string[] = [];
      if (text.length === 0) {
        slices.push('');
      } else {
        for (let i = 0; i < text.length; i += SLICE_SIZE) {
          slices.push(text.slice(i, i + SLICE_SIZE));
        }
      }

      let lastMsg: Message | undefined;
      for (const slice of slices) {
        lastMsg = await channel.send(slice);
      }

      if (!lastMsg) {
        // 理论上不会到这里——slices 至少 1 个
        throw new Error('platform-discord: send produced no message');
      }

      return {
        platform: 'discord',
        channelId: sessionKey.channelId,
        messageId: lastMsg.id,
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
