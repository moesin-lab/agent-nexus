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
 */
export interface SlashCommandRegistrar {
  create(data: ApplicationCommandDataResolvable): Promise<unknown>;
}

/**
 * 注册一组 slash command。逐条 `create` upsert：
 * - 单条失败只打 error 日志，不抛、不影响其它条目
 * - registrar 为 null/undefined（client.application 还没就绪）→ 整体 skip + error 日志
 *
 * 注册失败不阻断 adapter 启动：平台核心是消息收发，控制面板缺失只影响切换能力。
 */
export async function registerSlashCommands(
  registrar: SlashCommandRegistrar | null | undefined,
  specs: readonly SlashCommandSpec[],
  logger: Logger,
): Promise<void> {
  if (!registrar) {
    logger.error({}, 'discord_slash_command_register_skipped_no_application');
    return;
  }
  for (const spec of specs) {
    try {
      await registrar.create(spec.data);
      logger.info({ command: spec.name }, 'discord_slash_command_registered');
    } catch (err) {
      logger.error(
        { err, command: spec.name },
        'discord_slash_command_register_failed',
      );
    }
  }
}
