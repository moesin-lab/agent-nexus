import type { Logger } from '@agent-nexus/daemon';
import type {
  CommandRegistrationPlan,
  CommandRegistrationPort,
  CommandRegistrationResult,
  PlannedCommand,
} from '@agent-nexus/protocol';
import {
  ApplicationCommandOptionType,
  type ApplicationCommandDataResolvable,
} from 'discord.js';

/**
 * 一条 slash command 注册描述。`name` 仅用于结构化日志（注册成功/失败时识别）；
 * `data` 是真正传给 Discord 的 payload。
 */
export interface SlashCommandSpec {
  name: string;
  data: ApplicationCommandDataResolvable;
}

function optionType(type: PlannedCommand['descriptor']['options'][number]['type']) {
  if (type === 'string') return ApplicationCommandOptionType.String;
  if (type === 'integer') return ApplicationCommandOptionType.Integer;
  if (type === 'number') return ApplicationCommandOptionType.Number;
  return ApplicationCommandOptionType.Boolean;
}

export function plannedCommandToSlashCommandSpec(
  command: PlannedCommand,
): SlashCommandSpec {
  return {
    name: command.commandName,
    data: {
      name: command.commandName,
      description: command.descriptor.summary,
      options: command.descriptor.options.map((option) => {
        const mapped = {
          type: optionType(option.type),
          name: option.name,
          description: option.description,
          required: option.required,
        };
        if (option.type === 'boolean' || option.choices.length === 0) {
          return mapped;
        }
        return { ...mapped, choices: option.choices };
      }),
    } as ApplicationCommandDataResolvable,
  };
}

/**
 * `client.application?.commands` 的最小子集，便于测试 mock。
 *
 * 用 `set` 提交 registry 管理的期望全集；见
 * docs/dev/spec/command-registry.md §Remote Registration Activation。
 *
 * `guildId` 可选——传则注册到指定 guild（瞬时生效，dev 用），不传则注册为
 * global command（生产用，缓存延迟最长 1 小时）。见 spec §"注册作用域"。
 */
export interface SlashCommandRegistrar {
  set(
    data: readonly ApplicationCommandDataResolvable[],
    guildId?: string,
  ): Promise<unknown>;
}

interface SlashCommandSubmitResult {
  ok: boolean;
  message?: string;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function commandNames(specs: readonly SlashCommandSpec[]): string[] {
  return specs.map((spec) => spec.name);
}

async function submitSlashCommandSet(
  registrar: SlashCommandRegistrar | null | undefined,
  specs: readonly SlashCommandSpec[],
  logger: Logger,
  guildId?: string,
): Promise<SlashCommandSubmitResult> {
  const scope = guildId ? 'guild' : 'global';
  const logFields = {
    commands: commandNames(specs),
    commandCount: specs.length,
    scope,
    guildId: guildId ?? null,
  };

  if (!registrar) {
    logger.error(
      logFields,
      'discord_slash_command_register_skipped_no_application',
    );
    return {
      ok: false,
      message: 'discord application commands are not available',
    };
  }

  try {
    await registrar.set(
      specs.map((spec) => spec.data),
      guildId,
    );
    logger.info(logFields, 'discord_slash_commands_registered');
    return { ok: true };
  } catch (err) {
    logger.error(
      {
        ...logFields,
        error: { name: errorName(err) },
      },
      'discord_slash_command_register_failed',
    );
    return {
      ok: false,
      message: 'discord slash command bulk registration failed',
    };
  }
}

/**
 * 注册一组 slash command。一次性 `set` 为期望全集：
 * - bulk set 失败只打 error 日志，不抛
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
  await submitSlashCommandSet(registrar, specs, logger, guildId);
}

function guildIdForPlan(plan: CommandRegistrationPlan): string | undefined {
  return plan.scope.nativeScope.kind === 'guild'
    ? plan.scope.nativeScope.guildId
    : undefined;
}

export function createDiscordCommandRegistrationPort(
  registrar: SlashCommandRegistrar | null | undefined,
  logger: Logger,
): CommandRegistrationPort {
  return {
    async applyCommandPlan(
      plan: CommandRegistrationPlan,
    ): Promise<CommandRegistrationResult> {
      if (plan.scope.platformType !== 'discord') {
        return {
          status: 'failed',
          error: {
            code: 'command_registration_failed',
            message: 'discord command registrar received a non-discord scope',
          },
        };
      }

      const result = await submitSlashCommandSet(
        registrar,
        plan.commands.map(plannedCommandToSlashCommandSpec),
        logger,
        guildIdForPlan(plan),
      );
      if (!result.ok) {
        return {
          status: 'failed',
          error: {
            code: 'command_registration_failed',
            message:
              result.message ?? 'discord slash command bulk registration failed',
          },
        };
      }
      return { status: 'applied', generation: plan.generation };
    },
  };
}
