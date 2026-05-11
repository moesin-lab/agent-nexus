export { parseDiscordConfig, type DiscordConfig, DiscordConfigError } from './config.js';

// TODO MVP 跳过：
// - DM 消息（intents 没开 DirectMessages）
// - 长文本切片保留代码块边界 → docs/dev/spec/message-protocol.md §文本切片
// - edit / delete / react / typing → spec/platform-adapter.md 各对应段
// - threads → 同上

import { randomUUID } from 'node:crypto';
import {
  Client,
  GatewayIntentBits,
  type Interaction,
  type Message,
} from 'discord.js';
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
import {
  readReplyModeState,
  writeReplyModeState,
  type ReplyMode,
} from './state.js';
import {
  assertBotUserIdMatch,
  handleReplyModeInteraction,
  replyModeCommandDefinition,
} from './reply-mode.js';
import { registerSlashCommands } from './commands.js';

export interface DiscordPlatformOptions {
  token: string;
  botUserId: string;
  logger: Logger;
  /**
   * 持久化 reply-mode 状态的文件路径。CLI 必须给（adapter 不自己选位置——
   * 见 spec/platform-adapter.md §"运行时状态持久化"）。
   */
  statePath: string;
  /**
   * 用户白名单——同时控制 inbound chat 与 `/reply-mode` slash command。
   * fail-closed：CLI loader 必填且不允许空数组。
   * 详见 spec/platform-adapter.md §"用户白名单"。
   */
  allowedUserIds: readonly string[];
  /**
   * 可选：开发 / 单 guild 测试时把 slash command 限定注册到该 guild，
   * 瞬时生效（global 注册有最长 1 小时的 client 缓存延迟）。
   * 缺省 / 空 → 注册为全局 slash command（生产形态）。
   * 详见 spec/platform-adapter.md §"注册作用域"。
   */
  testGuildId?: string;
}

/**
 * 单切片最多容纳的 UTF-16 code unit 数。Discord 上限是 2000 UTF-16 单位，
 * 留 100 单位余量。该值是预算上限（不是固定切片长度）——单个代码点
 * 最多占 2 个 UTF-16 单位（surrogate pair），所以 100 余量足够任何
 * 代码点跨片场景。
 */
export const SLICE_SIZE = 1900;

export type { ReplyMode } from './state.js';

/**
 * 多片 send 中途失败时抛出，sentIds 列出已落地的消息 id。
 * 通过 pino 默认 err 序列化器自动序列化 enumerable 字段（含 sentIds）到日志。
 */
export class PartialSendError extends Error {
  public readonly sentIds: string[];
  public readonly totalSlices: number;
  public override readonly cause: unknown;
  constructor(opts: { sentIds: string[]; totalSlices: number; cause: unknown }) {
    super(
      `platform-discord: partial send (${opts.sentIds.length}/${opts.totalSlices} slices sent)`,
    );
    this.name = 'PartialSendError';
    this.sentIds = opts.sentIds;
    this.totalSlices = opts.totalSlices;
    this.cause = opts.cause;
  }
}

/**
 * 按 UTF-16 code unit 预算切片，迭代单位是 code point（`for…of` 行为）。
 * 切点不会落在 surrogate pair 内部，因此基本 emoji 不会被劈成 `�`。
 *
 * 已知限制：grapheme cluster（含 ZWJ 序列 / VS-16 / 国旗 / 肤色修饰符）
 * 仍可能在 code point 之间切——这是 BMP+emoji 约 95% 视觉场景的折中实现。
 * 完全正确需要 `Intl.Segmenter`，留 TODO 等流式 edit 主路径替换掉切片机制
 * （issue #56 stream-json epic 后切片会大幅缩减）。
 *
 * 空串返 `['']` 以保证 caller 总能拿到至少一条 sendable 消息。
 */
export function buildSlices(text: string, maxUtf16: number = SLICE_SIZE): string[] {
  if (text.length === 0) return [''];
  const slices: string[] = [];
  let current = '';
  let currentUtf16 = 0;
  for (const codePoint of text) {
    const cpLen = codePoint.length;
    if (cpLen > maxUtf16) {
      // 预算比单个 code point 还小 → 退化成强行切（不可能在正常 ≥2 的预算下命中）
      if (current.length > 0) {
        slices.push(current);
        current = '';
        currentUtf16 = 0;
      }
      slices.push(codePoint);
      continue;
    }
    if (currentUtf16 + cpLen > maxUtf16) {
      slices.push(current);
      current = codePoint;
      currentUtf16 = cpLen;
    } else {
      current += codePoint;
      currentUtf16 += cpLen;
    }
  }
  slices.push(current);
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
 * `parseInbound` 的返回形态——tagged union，让 caller 拿到"为什么被丢"。
 * `drop.reason` 只用于决定上层日志策略，不参与业务逻辑。
 */
export type ParsedInbound =
  | { kind: 'event'; event: NormalizedEvent }
  | { kind: 'drop'; reason: 'noise' | 'unauthorized' | 'no-mention' };

/**
 * 已 export 用于测试。msg → tagged 结果（见 `ParsedInbound`）。
 *
 * 过滤顺序见 spec/platform-adapter.md §"Discord Trigger 策略"：
 *   1. Discord system message（pin / join / thread-create 等）→ drop:noise
 *   2. 任意 bot 发的（含本机器人）→ drop:noise
 *   3. 与 botUserId 同 id 的 author → drop:noise（防 bot 标志位被绕；'all' 档下还兼防自回环）
 *   4. msg.author.id ∉ allowedUserIds → drop:unauthorized（fail-closed 用户白名单；空列表 = 拒绝所有）
 *   5. mention 模式且没显式 @ 本机器人 → drop:no-mention
 *   6. 否则剥本机器人 mention，构造事件 → kind:event
 *
 * `allowedUserIds` 同时管 inbound chat 与 slash command（见 spec §"用户白名单"）。
 * 这里仅做 chat 路径的 guard；slash command 路径在 reply-mode.ts 内做相同检查。
 *
 * 把 reason 抬到返回值里（而不是让 caller 重做一遍 guard 判断）是为了让
 * "guard 顺序变更" 与 "上层日志策略" 解耦——以后增/调 guard 不会让
 * `discord_inbound_unauthorized` 日志静默漂移。
 */
export function parseInbound(
  msg: Message,
  botUserId: string,
  allowedUserIds: readonly string[],
  replyMode: ReplyMode = 'mention',
): ParsedInbound {
  if (msg.system === true) return { kind: 'drop', reason: 'noise' };
  if (msg.author.bot === true) return { kind: 'drop', reason: 'noise' };
  if (msg.author.id === botUserId) return { kind: 'drop', reason: 'noise' };
  if (!allowedUserIds.includes(msg.author.id)) {
    return { kind: 'drop', reason: 'unauthorized' };
  }

  if (replyMode === 'mention') {
    const mentionPlain = `<@${botUserId}>`;
    const mentionNick = `<@!${botUserId}>`;
    if (
      !msg.content.includes(mentionPlain) &&
      !msg.content.includes(mentionNick)
    ) {
      return { kind: 'drop', reason: 'no-mention' };
    }
  }

  const text = msg.content.replace(buildBotMentionRegex(botUserId), '').trim();

  const sessionKey: SessionKey = {
    platform: 'discord',
    channelId: msg.channelId,
    initiatorUserId: msg.author.id,
  };
  const event: NormalizedEvent = {
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
  return { kind: 'event', event };
}

export function createDiscordPlatform(opts: DiscordPlatformOptions): PlatformAdapter {
  const { token, botUserId, logger, statePath, allowedUserIds, testGuildId } = opts;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  let started = false;
  let stopped = false;
  // 启动时从 state 文件读，缺省 'mention'。运行时由 /reply-mode 切换更新。
  let replyMode: ReplyMode = 'mention';

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

      const persisted = await readReplyModeState(statePath);
      if (persisted !== null) {
        replyMode = persisted.replyMode;
        logger.info({ replyMode, statePath }, 'discord_reply_mode_loaded');
      } else {
        logger.info(
          { replyMode, statePath },
          'discord_reply_mode_default',
        );
      }

      client.on('ready', () => {
        assertBotUserIdMatch({
          actualId: client.user?.id,
          configId: botUserId,
          tag: client.user?.tag,
          logger,
        });
        void registerSlashCommands(
          client.application?.commands,
          [{ name: 'reply-mode', data: replyModeCommandDefinition() }],
          logger,
          testGuildId,
        );
      });

      client.on('interactionCreate', async (interaction: Interaction) => {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== 'reply-mode') return;
        try {
          await handleReplyModeInteraction(interaction, {
            allowedUserIds,
            getMode: () => replyMode,
            setMode: async (next) => {
              await writeReplyModeState(statePath, next);
              replyMode = next;
            },
            logger,
          });
        } catch (err) {
          logger.error(
            { err, commandName: interaction.commandName },
            'discord_interaction_handler_error',
          );
        }
      });

      client.on('messageCreate', async (msg: Message) => {
        const parsed = parseInbound(msg, botUserId, allowedUserIds, replyMode);
        if (parsed.kind === 'drop') {
          // 仅在被 allowlist guard 拦下时打 info 日志（其它过滤路径噪声太大）。
          // 仅记 user id；不写 username / message text（PII / 隐私卫生）。
          if (parsed.reason === 'unauthorized') {
            logger.info(
              { userId: msg.author.id, channelId: msg.channelId },
              'discord_inbound_unauthorized',
            );
          }
          return;
        }

        const event = parsed.event;
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
      try {
        for (const slice of slices) {
          const msg = await channel.send(slice);
          sentIds.push(msg.id);
        }
      } catch (err) {
        // 中途失败：上抛 PartialSendError 保留已发的 sentIds，让上层日志
        // 可见"哪些已送出"，避免只剩"send_failed"什么都不知道的现场。
        throw new PartialSendError({
          sentIds,
          totalSlices: slices.length,
          cause: err,
        });
      }

      const lastId = sentIds[sentIds.length - 1];
      if (lastId === undefined) {
        // 理论上不会到这里——buildSlices 至少返 1 个切片
        throw new Error('platform-discord: send produced no message');
      }

      // Collect every slice's ID into messageIds; messageId points at the last one (single-slice compat)
      // → docs/dev/spec/platform-adapter.md §MessageRef
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
