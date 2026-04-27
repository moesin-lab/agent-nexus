import type { Logger } from '@agent-nexus/daemon';
import { ApplicationCommandOptionType } from 'discord.js';
import type { ReplyMode } from './state.js';

export interface ReplyModeContext {
  ownerUserIds: readonly string[];
  getMode(): ReplyMode;
  setMode(mode: ReplyMode): void | Promise<void>;
  logger: Logger;
}

/**
 * 抽象 discord.js ChatInputCommandInteraction 里我们实际依赖的最小子集。
 * 抽口契约——便于在测试里用普通对象 mock，不必构造完整 interaction。
 */
export interface ReplyModeInteractionLike {
  commandName: string;
  user: { id: string };
  options: { getString(name: string): string | null };
  reply(opts: { content: string; ephemeral: boolean }): Promise<unknown>;
}

/**
 * Slash command 注册描述。formatted as ApplicationCommandData (discord.js 接受 plain JSON)。
 */
export function replyModeCommandDefinition() {
  return {
    name: 'reply-mode',
    description: 'Query or switch the bot reply trigger mode',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'mode',
        description: 'New mode (omit to query current)',
        required: false,
        choices: [
          { name: 'mention', value: 'mention' },
          { name: 'all', value: 'all' },
        ],
      },
    ],
  } as const;
}

/**
 * 处理 /reply-mode interaction。
 *
 * 授权策略见 spec/platform-adapter.md §"Discord Trigger 策略 / 授权"：
 * unauthorized → 不 ack（调用方看 "interaction failed"）+ info 日志（仅 user id）。
 */
export async function handleReplyModeInteraction(
  interaction: ReplyModeInteractionLike,
  ctx: ReplyModeContext,
): Promise<void> {
  const userId = interaction.user.id;

  if (!ctx.ownerUserIds.includes(userId)) {
    ctx.logger.info({ userId }, 'discord_reply_mode_unauthorized');
    return;
  }

  const requested = interaction.options.getString('mode');
  if (requested === null) {
    await interaction.reply({
      content: `current reply mode: \`${ctx.getMode()}\``,
      ephemeral: true,
    });
    return;
  }

  if (requested !== 'mention' && requested !== 'all') {
    // Discord 端 choices 限制理论上拦住了，但接 stringly-typed 输入仍做一道兜底
    await interaction.reply({
      content: `invalid mode: \`${requested}\` (must be \`mention\` or \`all\`)`,
      ephemeral: true,
    });
    return;
  }

  const from = ctx.getMode();
  const to: ReplyMode = requested;
  await ctx.setMode(to);
  ctx.logger.info({ from, to, userId }, 'discord_reply_mode_changed');

  await interaction.reply({
    content: `reply mode: \`${from}\` → \`${to}\``,
    ephemeral: true,
  });
}

/**
 * Ready 回调里比较 client.user.id 与 config 的 botUserId。
 * 漂移时 warn（不 throw，允许 dev 临时同 token 跑多配置）。
 *
 * 在 replyMode='all' 下这道检查从纵深防御升级为关键路径——
 * 见 spec/platform-adapter.md §"Bot 身份自检"。
 */
export function assertBotUserIdMatch(args: {
  actualId: string | undefined;
  configId: string;
  tag: string | undefined;
  logger: Logger;
}): void {
  const { actualId, configId, tag, logger } = args;
  if (actualId !== configId) {
    logger.warn(
      { configBotUserId: configId, actualUserId: actualId, tag },
      'discord_bot_user_id_mismatch',
    );
  }
  logger.info({ user: tag }, 'discord_ready');
}
