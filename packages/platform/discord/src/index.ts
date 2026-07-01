export {
  parseDiscordConfig,
  parseDiscordBindingMatchConfig,
  parseDiscordPlatformConfig,
  DiscordConfigError,
  type DiscordBindingMatchConfig,
  type DiscordConfig,
  type DiscordPlatformConfig,
  type DiscordPublicChannelMode,
} from './config.js';
export {
  createDiscordCommandRegistrationPort,
  plannedCommandToSlashCommandSpec,
} from './commands.js';
export { discordReplyModeCommandDescriptor } from './reply-mode.js';

// TODO MVP 跳过：
// - DM 消息（intents 没开 DirectMessages）
// - 长文本切片保留代码块边界 → docs/dev/spec/message-protocol.md §文本切片
// - delete → spec/platform-adapter.md 各对应段

import { randomUUID } from 'node:crypto';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from 'discord.js';
import type {
  CapabilitySet,
  CommandArgValue,
  CommandRegistrationPlan,
  CommandRegistrationPort,
  CommandRegistrationResult,
  CommandRegistrationScope,
  CreateThreadInput,
  CreateThreadResult,
  EventHandler,
  EventHandlerResult,
  EventModalResponse,
  MessageComponent,
  MessageEmbed,
  MessageRef,
  NormalizedEvent,
  OutboundMessage,
  PlatformSessionKey,
  PlatformAdapter,
  SessionKey,
  UpdateThreadInput,
} from '@agent-nexus/protocol';
import type { Logger } from '@agent-nexus/daemon';
import {
  readReplyModeState,
  writeReplyModeState,
  type ReplyMode,
} from './state.js';
import {
  assertBotUserIdMatch,
  discordReplyModeCommandDescriptor,
  handleReplyModeInteraction,
} from './reply-mode.js';
import {
  createDiscordCommandRegistrationPort,
  plannedCommandToSlashCommandSpec,
  registerSlashCommands,
} from './commands.js';

export interface DiscordCommandRegistration {
  plan: CommandRegistrationPlan;
  apply(
    port: CommandRegistrationPort,
    plan: CommandRegistrationPlan,
  ): Promise<CommandRegistrationResult>;
}

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
   * legacy 用户白名单。默认同时控制 inbound chat 与 `/reply-mode` slash command；
   * 多平台运行时可用 inboundAllowedUserIds 显式把 chat 授权交给 daemon。
   */
  allowedUserIds: readonly string[];
  /**
   * inbound chat 用户白名单。undefined → 复用 allowedUserIds；null → 不在 adapter
   * 层做用户白名单，交给 daemon 的 platform auth gate。
   */
  inboundAllowedUserIds?: readonly string[] | null;
  /**
   * 可选：开发 / 单 guild 测试时把 slash command 限定注册到该 guild，
   * 瞬时生效（global 注册有最长 1 小时的 client 缓存延迟）。
   * 缺省 / 空 → 注册为全局 slash command（生产形态）。
   * 详见 spec/platform-adapter.md §"注册作用域"。
   */
  testGuildId?: string;
  commandRegistration?: DiscordCommandRegistration;
}

/** 配置热重载时替换 adapter 内部授权数据；字段语义同 DiscordPlatformOptions 同名字段 */
export interface DiscordAuthUpdate {
  allowedUserIds: readonly string[];
  inboundAllowedUserIds?: readonly string[] | null;
}

export interface DiscordPlatformAdapter extends PlatformAdapter {
  updateAuth(update: DiscordAuthUpdate): void;
}

/**
 * 单切片字符预算（UTF-16 code unit）。Discord 文档说 message content 上限 "2000
 * characters" 但没明指口径（code point / UTF-16 / grapheme 都可能），保守按最严的
 * UTF-16 取 1900。
 */
export const SLICE_SIZE = 1900;

export const DISCORD_CAPABILITIES: CapabilitySet = {
  maxTextLength: 2000,
  supportsEdit: true,
  supportsDelete: false,
  supportsReactions: true,
  supportsEmbeds: true,
  supportsButtons: true,
  supportsSelects: true,
  supportsModals: true,
  supportsThreads: true,
  supportsThreadCreation: true,
  supportsEphemeral: true,
  supportsAttachments: false,
  maxAttachmentsPerMessage: 0,
  supportsTypingIndicator: true,
  supportsSlashCommands: true,
};

export type { ReplyMode } from './state.js';

/**
 * 多片 send 中途失败时抛出。`sentIds` 列出已落地的消息 id，顺序对应 `buildSlices`
 * 的输出 —— 依赖 `send()` 串行 await；如果未来改成并发，需要重新定义"前 N 片"语义。
 *
 * 日志序列化：`sentIds` / `totalSlices` 是 enumerable own props，pino 默认 err
 * serializer 会平铺到 `err.sentIds` / `err.totalSlices`。`cause` 走 pino 自身的
 * cause-chain（折进 stack 末尾），cause 上的字段（如 `DiscordAPIError.code` /
 * `status`）不会作为顶层字段输出 —— 想查 Discord 错误码要自行展开 cause 链。
 * 这个缺口由 daemon 错误日志契约整体落地时收口，见
 * spec/infra/observability.md §错误日志必含 + spec/infra/errors.md。
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
 * 按 UTF-16 code unit 预算切片，迭代单位是 code point（`for…of`），切点不落在
 * surrogate pair 内部 —— 基本 emoji 不会变成 `�`。
 *
 * 已知缺口：grapheme cluster（ZWJ 序列 / VS-16 / 国旗 / 肤色修饰）仍可能在 code point
 * 之间被切；测试里有 known-degenerate 用例钉死当前行为。彻底正确要 `Intl.Segmenter`，
 * 留到 stream-json epic（#56）替换整套切片机制时一并处理。
 *
 * 空串返 `['']` 以保 caller 总能拿到至少一条 sendable 消息。
 */
export function buildSlices(text: string, maxUtf16: number = SLICE_SIZE): string[] {
  if (text.length === 0) return [''];
  const slices: string[] = [];
  let current = '';
  let currentUtf16 = 0;
  for (const codePoint of text) {
    const cpLen = codePoint.length;
    if (cpLen > maxUtf16) {
      // 防御性兜底：预算比单个 code point 还小时强行切；正常预算（≥2）下不会命中
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
  if (current.length > 0) slices.push(current);
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

function discordMemberRoleIds(msg: Message): string[] {
  const cache = msg.member?.roles.cache;
  if (!cache) return [];
  return [...cache.keys()];
}

function discordInteractionRoleIds(interaction: { member?: unknown }): string[] {
  const member = interaction.member;
  const roles =
    member && typeof member === 'object' && 'roles' in member
      ? member.roles
      : undefined;
  if (Array.isArray(roles)) return roles;
  const cache =
    roles && typeof roles === 'object' && 'cache' in roles
      ? roles.cache
      : undefined;
  if (
    cache &&
    typeof cache === 'object' &&
    'keys' in cache &&
    typeof cache.keys === 'function'
  ) {
    return [...cache.keys()] as string[];
  }
  return [];
}

function discordChannelThreadParentId(channel: unknown): string | undefined {
  if (!channel || typeof channel !== 'object') return undefined;
  const isThread =
    'isThread' in channel && typeof channel.isThread === 'function'
      ? channel.isThread()
      : false;
  if (!isThread) return undefined;
  const parentId = 'parentId' in channel ? channel.parentId : undefined;
  return typeof parentId === 'string' ? parentId : undefined;
}

function discordMessageThreadParentId(msg: Message): string | undefined {
  return discordChannelThreadParentId(msg.channel);
}

function discordComponentType(
  interaction: Interaction,
): 'button' | 'select' | undefined {
  if (interaction.isButton()) return 'button';
  if (interaction.isStringSelectMenu()) return 'select';
  return undefined;
}

function componentValues(interaction: Interaction): string[] {
  if (interaction.isStringSelectMenu()) return interaction.values;
  return [];
}

function commandArgValue(value: unknown): CommandArgValue | undefined {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  return undefined;
}

function commandArgs(
  interaction: ChatInputCommandInteraction,
): Record<string, CommandArgValue> {
  const args: Record<string, CommandArgValue> = {};
  for (const option of interaction.options.data) {
    const value = commandArgValue(option.value ?? null);
    if (value !== undefined) args[option.name] = value;
  }
  return args;
}

function commandScope(testGuildId?: string): CommandRegistrationScope {
  return {
    platformName: 'discord',
    platformType: 'discord',
    nativeScope: testGuildId
      ? { kind: 'guild', guildId: testGuildId }
      : { kind: 'global' },
  };
}

function replyModeCommandNames(
  commandRegistration: DiscordCommandRegistration | undefined,
): Set<string> {
  if (!commandRegistration) {
    return new Set(['reply-mode', 'discord-reply-mode']);
  }
  const names = new Set<string>();
  for (const [name, route] of Object.entries(
    commandRegistration.plan.reverseMap.entries,
  )) {
    if (route.canonicalId === discordReplyModeCommandDescriptor.canonicalId) {
      names.add(name);
    }
  }
  return names;
}

function commandEventFromInteraction(
  interaction: ChatInputCommandInteraction,
  scope: CommandRegistrationScope,
): NormalizedEvent {
  const threadParentChannelId = discordChannelThreadParentId(interaction.channel);
  return {
    eventId: interaction.id,
    platform: 'discord',
    sessionKey: {
      platform: 'discord',
      channelId: interaction.channelId,
      initiatorUserId: interaction.user.id,
    },
    traceId: randomUUID(),
    type: 'command',
    command: {
      name: interaction.commandName,
      args: commandArgs(interaction),
      registrationScope: scope,
    },
    rawPayload: interaction,
    rawContentType: 'discord:interaction',
    receivedAt: new Date(),
    platformTimestamp: interaction.createdAt,
    ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
    initiatorRoleIds: discordInteractionRoleIds(interaction),
    ...(threadParentChannelId ? { threadParentChannelId } : {}),
    initiator: {
      userId: interaction.user.id,
      displayName: interaction.user.username,
      isBot: interaction.user.bot,
    },
  };
}

function componentEventFromInteraction(interaction: Interaction): NormalizedEvent {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) {
    throw new Error('unsupported component interaction');
  }
  const componentType = discordComponentType(interaction);
  if (!componentType) throw new Error('unsupported component interaction');
  const threadParentChannelId = discordChannelThreadParentId(interaction.channel);
  return {
    eventId: interaction.id,
    platform: 'discord',
    sessionKey: {
      platform: 'discord',
      channelId: interaction.channelId,
      initiatorUserId: interaction.user.id,
    },
    traceId: randomUUID(),
    type: 'interaction',
    interaction: {
      componentId: interaction.customId,
      kind: componentType,
      values: componentValues(interaction),
    },
    rawPayload: interaction,
    rawContentType: 'discord:component-interaction',
    receivedAt: new Date(),
    platformTimestamp: interaction.createdAt,
    ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
    initiatorRoleIds: discordInteractionRoleIds(interaction),
    ...(threadParentChannelId ? { threadParentChannelId } : {}),
    initiator: {
      userId: interaction.user.id,
      displayName: interaction.user.username,
      isBot: interaction.user.bot,
    },
  };
}

function modalEventFromInteraction(interaction: Interaction): NormalizedEvent {
  if (!interaction.isModalSubmit()) {
    throw new Error('unsupported modal interaction');
  }
  if (!interaction.channelId) {
    throw new Error('modal interaction missing channel id');
  }
  const threadParentChannelId = discordChannelThreadParentId(interaction.channel);
  const modalFields = interaction.fields.fields as {
    map?: <T>(fn: (field: { customId: string }) => T) => T[];
    values?: () => Iterable<{ customId: string }>;
  };
  const fieldEntries =
    typeof modalFields.map === 'function'
      ? modalFields.map((field) => [
          field.customId,
          interaction.fields.getTextInputValue(field.customId),
        ])
      : [...(modalFields.values?.() ?? [])].map((field) => [
          field.customId,
          interaction.fields.getTextInputValue(field.customId),
        ]);
  return {
    eventId: interaction.id,
    platform: 'discord',
    sessionKey: {
      platform: 'discord',
      channelId: interaction.channelId,
      initiatorUserId: interaction.user.id,
    },
    traceId: randomUUID(),
    type: 'interaction',
    interaction: {
      componentId: interaction.customId,
      kind: 'modal_submit',
      values: fieldEntries.map(([componentId, value]) => `${componentId}=${value}`),
    },
    rawPayload: interaction,
    rawContentType: 'discord:modal-submit',
    receivedAt: new Date(),
    platformTimestamp: interaction.createdAt,
    ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
    initiatorRoleIds: discordInteractionRoleIds(interaction),
    ...(threadParentChannelId ? { threadParentChannelId } : {}),
    initiator: {
      userId: interaction.user.id,
      displayName: interaction.user.username,
      isBot: interaction.user.bot,
    },
  };
}

function discordButtonStyle(
  style: Extract<MessageComponent, { type: 'button' }>['style'],
): number {
  if (style === 'primary') return 1;
  if (style === 'danger') return 4;
  return 2;
}

function discordMessageComponents(
  components: readonly MessageComponent[] | undefined,
): unknown[] | undefined {
  if (!components || components.length === 0) return undefined;
  const rows: unknown[] = [];
  let buttonRow: unknown[] = [];
  const flushButtons = (): void => {
    if (buttonRow.length === 0) return;
    rows.push({ type: 1, components: buttonRow });
    buttonRow = [];
  };
  for (const component of components) {
    if (component.type === 'button') {
      buttonRow.push({
        type: 2,
        custom_id: component.componentId,
        label: component.label,
        style: discordButtonStyle(component.style),
        ...(component.disabled !== undefined
          ? { disabled: component.disabled }
          : {}),
      });
      if (buttonRow.length === 5) flushButtons();
      continue;
    }
    flushButtons();
    rows.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: component.componentId,
          ...(component.placeholder ? { placeholder: component.placeholder } : {}),
          options: component.options.map((option) => ({
            label: option.label,
            value: option.value,
            ...(option.description ? { description: option.description } : {}),
            ...(option.default !== undefined ? { default: option.default } : {}),
          })),
          min_values: component.minValues ?? 1,
          max_values: component.maxValues ?? 1,
          ...(component.disabled !== undefined
            ? { disabled: component.disabled }
            : {}),
        },
      ],
    });
  }
  flushButtons();
  return rows;
}

function discordMessageEmbeds(
  embeds: readonly MessageEmbed[] | undefined,
): MessageEmbed[] | undefined {
  if (embeds === undefined) return undefined;
  return embeds.map((embed) => ({
    ...embed,
    ...(embed.fields
      ? {
          fields: embed.fields.map((field) => ({ ...field })),
        }
      : {}),
    ...(embed.footer ? { footer: { ...embed.footer } } : {}),
  }));
}

function discordMessagePayload(
  content: string,
  embeds: readonly MessageEmbed[] | undefined,
): string | { content: string; embeds: MessageEmbed[] } {
  const discordEmbeds = discordMessageEmbeds(embeds);
  if (discordEmbeds === undefined) return content;
  return { content, embeds: discordEmbeds };
}

function discordModal(response: EventModalResponse): unknown {
  return {
    custom_id: response.modalId,
    title: response.title,
    components: response.inputs.slice(0, 5).map((input) => ({
      type: 1,
      components: [
        {
          type: 4,
          custom_id: input.componentId,
          label: input.label,
          style: input.kind === 'long_text' ? 2 : 1,
          required: input.required ?? true,
          ...(input.placeholder ? { placeholder: input.placeholder } : {}),
          ...(input.value ? { value: input.value } : {}),
        },
      ],
    })),
  };
}

function immediateModalForComponent(
  interaction: Interaction,
): EventModalResponse | undefined {
  if (!interaction.isButton()) return undefined;
  if (interaction.customId === 'nexus:settings:working-dir') {
    return {
      modalId: 'nexus:settings:working-dir-modal',
      title: '设置工作目录 / Set dir',
      inputs: [
        {
          componentId: 'path',
          label: '绝对路径 / Absolute path',
          kind: 'short_text',
          required: true,
        },
      ],
    };
  }
  if (interaction.customId === 'nexus:settings:config-raw') {
    return {
      modalId: 'nexus:settings:config-modal',
      title: '编辑 Nexus 配置 / Edit config',
      inputs: [
        {
          componentId: 'path',
          label: '配置路径 / Config path',
          kind: 'short_text',
          required: true,
          placeholder: 'agents[0].codex.workingDir',
        },
        {
          componentId: 'value',
          label: 'JSON 值 / JSON value',
          kind: 'long_text',
          required: true,
          placeholder: '"/workspace/project"',
        },
      ],
    };
  }
  if (interaction.customId.startsWith('nexus:settings:config-edit:')) {
    const fieldKey = interaction.customId.slice('nexus:settings:config-edit:'.length);
    return {
      modalId: `nexus:settings:config-edit-modal:${fieldKey}`,
      title: '编辑配置值 / Edit value',
      inputs: [
        {
          componentId: 'value',
          label: '新值 / New value',
          kind: 'long_text',
          required: false,
          placeholder: 'compact 或逐行输入 / compact or one per line',
        },
      ],
    };
  }
  if (interaction.customId === 'nexus:queue:insert') {
    return {
      modalId: 'nexus:queue:insert-modal',
      title: 'Insert queued message',
      inputs: [
        {
          componentId: 'text',
          label: 'Message',
          kind: 'long_text',
          required: true,
        },
      ],
    };
  }
  if (interaction.customId.startsWith('nexus:queue:edit:')) {
    const queueItemId = interaction.customId.slice('nexus:queue:edit:'.length);
    return {
      modalId: `nexus:queue:edit-modal:${queueItemId}`,
      title: 'Edit queued message',
      inputs: [
        {
          componentId: 'text',
          label: 'Message',
          kind: 'long_text',
          required: true,
        },
      ],
    };
  }
  return undefined;
}

interface DeferredInteraction {
  id: string;
  commandName?: string;
  customId?: string;
  deleteReply(): Promise<unknown>;
  editReply(message: unknown): Promise<unknown>;
}

async function deferCommandInteraction(
  interaction: ChatInputCommandInteraction,
  logger: Logger,
): Promise<boolean> {
  try {
    await interaction.deferReply({ ephemeral: true });
    return true;
  } catch (err) {
    logger.error(
      { err, interactionId: interaction.id, commandName: interaction.commandName },
      'discord_command_ack_failed',
    );
    return false;
  }
}

async function deleteDeferredCommandReply(
  interaction: DeferredInteraction,
  logger: Logger,
  event: NormalizedEvent,
): Promise<void> {
  try {
    await interaction.deleteReply();
  } catch (err) {
    logger.error(
      {
        err,
        traceId: event.traceId,
        interactionId: interaction.id,
        commandName: interaction.commandName,
        customId: interaction.customId,
      },
      'discord_command_ack_cleanup_failed',
    );
  }
}

async function completeDeferredCommandReply(
  interaction: DeferredInteraction,
  logger: Logger,
  event: NormalizedEvent,
  result: EventHandlerResult | void,
): Promise<void> {
  if (result?.commandResponse) {
    try {
      await interaction.editReply({
        content: result.commandResponse.text,
        ...(result.commandResponse.components
          ? { components: discordMessageComponents(result.commandResponse.components) }
          : {}),
      });
    } catch (err) {
      logger.error(
        {
          err,
          traceId: event.traceId,
          interactionId: interaction.id,
          commandName: interaction.commandName,
          customId: interaction.customId,
        },
        'discord_command_response_update_failed',
      );
    }
    return;
  }
  await deleteDeferredCommandReply(interaction, logger, event);
}

async function markDeferredCommandFailed(
  interaction: DeferredInteraction,
  logger: Logger,
  event: NormalizedEvent,
): Promise<void> {
  try {
    await interaction.editReply({ content: 'Command failed.' });
  } catch (err) {
    logger.error(
      {
        err,
        traceId: event.traceId,
        interactionId: interaction.id,
        commandName: interaction.commandName,
        customId: interaction.customId,
      },
      'discord_command_ack_failure_update_failed',
    );
  }
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
 *   4. 若配置了 allowedUserIds，msg.author.id ∉ allowedUserIds → drop:unauthorized
 *   5. mention 模式且没显式 @ 本机器人 → drop:no-mention
 *   6. 否则剥本机器人 mention，构造事件 → kind:event
 *
 * `allowedUserIds === null` 表示 chat 路径不做 adapter user guard，由 daemon
 * 统一按 platform auth 判定；slash command 路径仍在 reply-mode.ts 内检查
 * DiscordPlatformOptions.allowedUserIds。
 * 这里仅做 chat 路径的 guard；slash command 路径在 reply-mode.ts 内做相同检查。
 *
 * 把 reason 抬到返回值里（而不是让 caller 重做一遍 guard 判断）是为了让
 * "guard 顺序变更" 与 "上层日志策略" 解耦——以后增/调 guard 不会让
 * `discord_inbound_unauthorized` 日志静默漂移。
 */
export function parseInbound(
  msg: Message,
  botUserId: string,
  allowedUserIds: readonly string[] | null,
  replyMode: ReplyMode = 'mention',
): ParsedInbound {
  if (msg.system === true) return { kind: 'drop', reason: 'noise' };
  if (msg.author.bot === true) return { kind: 'drop', reason: 'noise' };
  if (msg.author.id === botUserId) return { kind: 'drop', reason: 'noise' };
  if (allowedUserIds !== null && !allowedUserIds.includes(msg.author.id)) {
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
  const threadParentChannelId = discordMessageThreadParentId(msg);

  const sessionKey: PlatformSessionKey = {
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
    ...(msg.guildId ? { guildId: msg.guildId } : {}),
    initiatorRoleIds: discordMemberRoleIds(msg),
    ...(threadParentChannelId ? { threadParentChannelId } : {}),
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

export function createDiscordPlatform(opts: DiscordPlatformOptions): DiscordPlatformAdapter {
  const {
    token,
    botUserId,
    logger,
    statePath,
    testGuildId,
    commandRegistration,
  } = opts;
  // 可被 updateAuth 热替换；reply-mode ctx 与 inbound guard 每次调用时读取。
  // null 必须保留（语义：chat guard 交给 daemon platform auth）——不能用 ?? 吞掉
  let allowedUserIds = opts.allowedUserIds;
  let inboundAllowedUserIds =
    opts.inboundAllowedUserIds === undefined
      ? opts.allowedUserIds
      : opts.inboundAllowedUserIds;

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
  const replyModeNames = replyModeCommandNames(commandRegistration);
  const editLocks = new WeakMap<MessageRef, Promise<void>>();

  const runSerializedEdit = async (
    ref: MessageRef,
    task: () => Promise<void>,
  ): Promise<void> => {
    const prev = editLocks.get(ref) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    editLocks.set(ref, next);
    try {
      await next;
    } finally {
      if (editLocks.get(ref) === next) {
        editLocks.delete(ref);
      }
    }
  };

  return {
    name() {
      return 'discord';
    },

    capabilities(): CapabilitySet {
      return DISCORD_CAPABILITIES;
    },

    settingsSnapshot(input) {
      return {
        items: [
          {
            key: 'discord.replyMode',
            label: '回复模式 / Reply mode',
            owner: 'platform',
            value: replyMode,
            source: 'discord state',
            durability: 'durable',
            canChange: allowedUserIds.includes(input.userId),
          },
        ],
      };
    },

    async applySettingsAction(input) {
      if (input.action !== 'discord.replyMode') {
        return {
          status: 'unsupported' as const,
          message: 'Discord 不支持这个设置 / This setting is not supported by Discord.',
        };
      }
      if (!allowedUserIds.includes(input.userId)) {
        logger.info({ userId: input.userId }, 'discord_settings_unauthorized');
        return {
          status: 'rejected' as const,
          message: `没有权限 / Permission denied. Your User ID is \`${input.userId}\`; ask the bot operator to add it.`,
        };
      }
      if (input.value !== 'mention' && input.value !== 'all') {
        return {
          status: 'rejected' as const,
          message: `模式无效 / invalid mode: \`${input.value ?? ''}\` (must be \`mention\` or \`all\`)`,
        };
      }
      const from = replyMode;
      const to = input.value;
      if (from === to) {
        logger.info({ mode: to, userId: input.userId }, 'discord_reply_mode_noop');
        return { status: 'handled' as const, message: `已经是 / already in \`${to}\`` };
      }
      await writeReplyModeState(statePath, to);
      replyMode = to;
      logger.info({ from, to, userId: input.userId }, 'discord_reply_mode_changed');
      return {
        status: 'handled' as const,
        message: `回复模式 / reply mode: \`${from}\` -> \`${to}\``,
      };
    },

    updateAuth(update: DiscordAuthUpdate): void {
      allowedUserIds = update.allowedUserIds;
      // 与构造时同语义：undefined → 复用 allowedUserIds；null → chat guard 交给 daemon
      inboundAllowedUserIds =
        update.inboundAllowedUserIds === undefined
          ? update.allowedUserIds
          : update.inboundAllowedUserIds;
      logger.info(
        {
          allowedUserCount: allowedUserIds.length,
          inboundGuardEnabled: inboundAllowedUserIds !== null,
        },
        'discord_auth_updated',
      );
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
        if (commandRegistration) {
          void commandRegistration.apply(
            createDiscordCommandRegistrationPort(client.application?.commands, logger),
            commandRegistration.plan,
          ).then((result) => {
            if (result.status === 'failed') {
              if (result.error.code === 'command_registration_disabled') return;
              logger.error(
                {
                  generation: commandRegistration.plan.generation,
                  errorCode: result.error.code,
                  errorMessage: result.error.message,
                },
                'command_registration_apply_failed',
              );
            }
          }).catch((err) => {
            logger.error(
              { err, generation: commandRegistration.plan.generation },
              'command_registration_apply_failed',
            );
          });
        } else {
          void registerSlashCommands(
            client.application?.commands,
            [
              plannedCommandToSlashCommandSpec({
                commandName: 'discord-reply-mode',
                canonicalId: discordReplyModeCommandDescriptor.canonicalId,
                aliasKind: 'stable',
                descriptor: discordReplyModeCommandDescriptor,
              }),
              plannedCommandToSlashCommandSpec({
                commandName: 'reply-mode',
                canonicalId: discordReplyModeCommandDescriptor.canonicalId,
                aliasKind: 'legacy',
                descriptor: discordReplyModeCommandDescriptor,
              }),
            ],
            logger,
            testGuildId,
          );
        }
      });

      client.on('interactionCreate', async (interaction: Interaction) => {
        if (
          'isModalSubmit' in interaction &&
          typeof interaction.isModalSubmit === 'function' &&
          interaction.isModalSubmit()
        ) {
          try {
            await interaction.deferReply({ ephemeral: true });
          } catch (err) {
            logger.error(
              { err, interactionId: interaction.id },
              'discord_modal_ack_failed',
            );
            return;
          }
          const event = modalEventFromInteraction(interaction);
          try {
            const result = await handler(event);
            await completeDeferredCommandReply(interaction, logger, event, result);
          } catch (err) {
            logger.error(
              { err, traceId: event.traceId, componentId: event.interaction?.componentId },
              'platform_handler_error',
            );
            await markDeferredCommandFailed(interaction, logger, event);
          }
          return;
        }
        if (!interaction.isChatInputCommand()) {
          if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
          const immediateModal = immediateModalForComponent(interaction);
          if (immediateModal) {
            try {
              await interaction.showModal(
                discordModal(immediateModal) as Parameters<
                  typeof interaction.showModal
                >[0],
              );
            } catch (err) {
              logger.error(
                { err, interactionId: interaction.id, customId: interaction.customId },
                'discord_component_modal_ack_failed',
              );
            }
            return;
          }
          try {
            await interaction.deferReply({ ephemeral: true });
          } catch (err) {
            logger.error(
              { err, interactionId: interaction.id },
              'discord_component_ack_failed',
            );
            return;
          }
          const event = componentEventFromInteraction(interaction);
          try {
            const result = await handler(event);
            await completeDeferredCommandReply(interaction, logger, event, result);
          } catch (err) {
            logger.error(
              { err, traceId: event.traceId, componentId: event.interaction?.componentId },
              'platform_handler_error',
            );
            await markDeferredCommandFailed(interaction, logger, event);
          }
          return;
        }
        if (!replyModeNames.has(interaction.commandName)) {
          if (!(await deferCommandInteraction(interaction, logger))) return;
          const event = commandEventFromInteraction(
            interaction,
            commandRegistration?.plan.scope ?? commandScope(testGuildId),
          );
          try {
            const result = await handler(event);
            await completeDeferredCommandReply(interaction, logger, event, result);
          } catch (err) {
            logger.error(
              { err, traceId: event.traceId, commandName: interaction.commandName },
              'platform_handler_error',
            );
            await markDeferredCommandFailed(interaction, logger, event);
          }
          return;
        }
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
          try {
            await interaction.reply({
              content: 'Command failed. Try again later.',
              ephemeral: true,
            });
          } catch (replyErr) {
            logger.error(
              { err: replyErr, commandName: interaction.commandName },
              'discord_interaction_error_reply_failed',
            );
          }
        }
      });

      client.on('messageCreate', async (msg: Message) => {
        const parsed = parseInbound(msg, botUserId, inboundAllowedUserIds, replyMode);
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
        for (const [index, slice] of slices.entries()) {
          const msg = await channel.send(
            discordMessagePayload(
              slice,
              index === 0 ? message.embeds : undefined,
            ),
          );
          sentIds.push(msg.id);
        }
      } catch (err) {
        // 包成 PartialSendError 而不是直接 rethrow：保留已发出的 sentIds，让上层日志
        // 能看到"中断在第几片"。直接 rethrow 时栈帧销毁，daemon 那边只剩孤零零的
        // platform_send_failed，无法重建已落地的消息序列。
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

      // messageIds 列全部切片 id；messageId 指向最后一片（单片场景兼容）
      // → docs/dev/spec/platform-adapter.md §MessageRef
      return {
        platform: 'discord',
        channelId: sessionKey.channelId,
        messageId: lastId,
        messageIds: sentIds,
        sentAt: new Date(),
      };
    },

    async edit(ref: MessageRef, message: OutboundMessage): Promise<void> {
      await runSerializedEdit(ref, async () => {
        const channel = await client.channels.fetch(ref.channelId);
        if (!channel || !channel.isTextBased()) {
          throw new Error(
            `platform-discord: channel ${ref.channelId} is not text-based or not found`,
          );
        }

        const slices = buildSlices(message.text);
        const existingIds = [...ref.messageIds];

        for (let i = 0; i < Math.min(slices.length, existingIds.length); i++) {
          await channel.messages.edit(
            existingIds[i]!,
            discordMessagePayload(
              slices[i]!,
              i === 0 ? message.embeds : undefined,
            ),
          );
        }

        if (slices.length > existingIds.length) {
          if (!channel.isSendable()) {
            throw new Error(
              `platform-discord: channel ${ref.channelId} cannot send extra edit slices`,
            );
          }
          for (const slice of slices.slice(existingIds.length)) {
            const sent = await channel.send(slice);
            ref.messageIds.push(sent.id);
            ref.messageId = sent.id;
          }
        }

        if (existingIds.length > slices.length) {
          for (const id of existingIds.slice(slices.length)) {
            await channel.messages.delete(id);
            const index = ref.messageIds.indexOf(id);
            if (index >= 0) ref.messageIds.splice(index, 1);
          }
        }

        const lastId = ref.messageIds[ref.messageIds.length - 1];
        if (lastId === undefined) {
          throw new Error('platform-discord: edit produced no message refs');
        }
        ref.messageId = lastId;
      });
    },

    async delete(): Promise<void> {
      throw new Error('platform-discord MVP: delete not supported');
    },

    async react(ref: MessageRef, emoji: string): Promise<void> {
      const channel = await client.channels.fetch(ref.channelId);
      if (!channel || !channel.isTextBased()) {
        throw new Error(
          `platform-discord: channel ${ref.channelId} is not text-based or not found`,
        );
      }
      const message = await channel.messages.fetch(ref.messageId);
      await message.react(emoji);
    },

    async createThread(input: CreateThreadInput) {
      const channel = await client.channels.fetch(input.parentChannelId);
      if (!channel || !channel.isTextBased() || !('threads' in channel)) {
        throw new Error(
          `platform-discord: channel ${input.parentChannelId} cannot create threads`,
        );
      }
      const threads = channel.threads as {
        create(options: {
          name: string;
          type: ChannelType.PrivateThread | ChannelType.PublicThread;
          autoArchiveDuration?: number;
          invitable?: boolean;
          reason?: string;
        }): Promise<{
          id: string;
          guildId?: string;
          members: { add(userId: string): Promise<unknown> };
          send(message: unknown): Promise<unknown>;
          delete?(reason?: string): Promise<unknown>;
          setArchived?(archived: boolean, reason?: string): Promise<unknown>;
        }>;
      };
      const thread = await threads.create({
        name: input.title.slice(0, 100),
        type:
          input.visibility === 'private'
            ? ChannelType.PrivateThread
            : ChannelType.PublicThread,
        autoArchiveDuration: input.autoArchiveDurationMinutes,
        invitable: false,
        reason: 'agent-nexus new thread',
      });
      try {
        await thread.members.add(input.initiatorUserId);
      } catch (err) {
        try {
          if (thread.delete) {
            await thread.delete('agent-nexus thread setup failed');
          } else if (thread.setArchived) {
            await thread.setArchived(true, 'agent-nexus thread setup failed');
          }
        } catch (cleanupErr) {
          logger.error(
            {
              traceId: input.traceId,
              threadId: thread.id,
              err: cleanupErr,
            },
            'discord_thread_cleanup_failed',
          );
        }
        throw err;
      }
      const setupWarnings: CreateThreadResult['setupWarnings'] = [];
      if (input.initialMessage) {
        try {
          await thread.send({
            content: input.initialMessage,
            allowedMentions: { parse: [] },
          });
        } catch (err) {
          setupWarnings.push({ code: 'initial_message_failed' });
          logger.error(
            {
              traceId: input.traceId,
              threadId: thread.id,
              err,
            },
            'discord_thread_initial_message_failed',
          );
        }
      }
      return {
        threadId: thread.id,
        parentChannelId: input.parentChannelId,
        ...(setupWarnings.length > 0 ? { setupWarnings } : {}),
        ...(thread.guildId
          ? { url: `https://discord.com/channels/${thread.guildId}/${thread.id}` }
          : {}),
      };
    },

    async updateThread(input: UpdateThreadInput): Promise<void> {
      if (!input.title) return;
      const channel = await client.channels.fetch(input.threadId);
      if (!channel || !('setName' in channel) || typeof channel.setName !== 'function') {
        throw new Error(
          `platform-discord: thread ${input.threadId} is not editable or not found`,
        );
      }
      await channel.setName(input.title.slice(0, 100), 'agent-nexus session title');
    },

    async setTyping(sessionKey: SessionKey): Promise<void> {
      try {
        const channel = await client.channels.fetch(sessionKey.channelId);
        if (!channel || !channel.isTextBased()) {
          logger.debug(
            { channelId: sessionKey.channelId },
            'discord_typing_channel_unavailable',
          );
          return;
        }
        if (!('sendTyping' in channel) || typeof channel.sendTyping !== 'function') {
          logger.debug(
            { channelId: sessionKey.channelId },
            'discord_typing_channel_unavailable',
          );
          return;
        }
        await channel.sendTyping();
      } catch (err) {
        logger.debug(
          { err, channelId: sessionKey.channelId },
          'discord_typing_failed',
        );
      }
    },

    async clearTyping(): Promise<void> {
      // Discord has no explicit clear API; typing expires automatically.
    },
  };
}
