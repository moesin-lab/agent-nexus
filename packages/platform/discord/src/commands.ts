import type { Logger } from '@agent-nexus/daemon';
import type { ApplicationCommandDataResolvable } from 'discord.js';

/**
 * 一条 slash command 注册描述。`name` 仅用于结构化日志（注册成功/失败时识别）；
 * `data` 是真正传给 Discord 的 payload。
 */
export interface SlashCommandSpec {
  name: string;
  data: ApplicationCommandDataResolvable;
}

/**
 * `client.application?.commands` 的最小子集，便于测试 mock。
 *
 * 用 `create`（按 name upsert）而不是 `set`（用整数组覆盖全部全局命令）——
 * 见 spec/platform-adapter.md §"Discord Trigger 策略 / 切换面板"，
 * 避免误删同一 application 下手动注册或未来新增的其它 slash command。
 *
 * `guildId` 可选——传则注册到指定 guild（瞬时生效，dev 用），不传则注册为
 * global command（生产用，缓存延迟最长 1 小时）。见 spec §"注册作用域"。
 */
export interface SlashCommandRegistrar {
  create(
    data: ApplicationCommandDataResolvable,
    guildId?: string,
  ): Promise<unknown>;
}

/**
 * 注册一组 slash command。逐条 `create` upsert：
 * - 单条失败只打 error 日志，不抛、不影响其它条目
 * - registrar 为 null/undefined（client.application 还没就绪）→ 整体 skip + error 日志
 * - `guildId` 非空 → 注册到指定 guild（dev / 测试，瞬时生效）；空/缺省 → global
 *
 * 注册失败不阻断 adapter 启动：平台核心是消息收发，控制面板缺失只影响切换能力。
 */
export async function registerSlashCommands(
  registrar: SlashCommandRegistrar | null | undefined,
  specs: readonly SlashCommandSpec[],
  logger: Logger,
  guildId?: string,
): Promise<void> {
  if (!registrar) {
    logger.error({}, 'discord_slash_command_register_skipped_no_application');
    return;
  }
  const scope = guildId ? 'guild' : 'global';
  for (const spec of specs) {
    try {
      await registrar.create(spec.data, guildId);
      logger.info(
        { command: spec.name, scope, guildId: guildId ?? null },
        'discord_slash_command_registered',
      );
    } catch (err) {
      logger.error(
        { err, command: spec.name, scope, guildId: guildId ?? null },
        'discord_slash_command_register_failed',
      );
    }
  }
}
