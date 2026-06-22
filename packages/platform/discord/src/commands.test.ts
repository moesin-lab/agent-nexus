import { describe, expect, it, vi } from 'vitest';
import {
  createDiscordCommandRegistrationPort,
  plannedCommandToSlashCommandSpec,
  registerSlashCommands,
  type SlashCommandRegistrar,
  type SlashCommandSpec,
} from './commands.js';
import { discordReplyModeCommandDescriptor } from './reply-mode.js';
import type { CommandRegistrationPlan } from '@agent-nexus/protocol';

function makeLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

const FAKE_SPEC: SlashCommandSpec = {
  name: 'reply-mode',
  data: { name: 'reply-mode', description: 'd', options: [] } as never,
};

const ANOTHER_SPEC: SlashCommandSpec = {
  name: 'other',
  data: { name: 'other', description: 'o', options: [] } as never,
};

describe('registerSlashCommands', () => {
  it('registrar null → 整体 skip + error 日志，不抛', async () => {
    const logger = makeLogger();
    await expect(
      registerSlashCommands(null, [FAKE_SPEC], logger),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(Object),
      'discord_slash_command_register_skipped_no_application',
    );
  });

  it('registrar undefined → 同上', async () => {
    const logger = makeLogger();
    await registerSlashCommands(undefined, [FAKE_SPEC], logger);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(Object),
      'discord_slash_command_register_skipped_no_application',
    );
  });

  it('空 specs → bulk set 空数组，清理 registry 管理的远端命令', async () => {
    const logger = makeLogger();
    const set = vi.fn(async () => ({}));
    const registrar: SlashCommandRegistrar = { set };
    await registerSlashCommands(registrar, [], logger);
    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith([], undefined);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('单条成功（不传 guildId）→ set([data], undefined) + scope=global', async () => {
    const logger = makeLogger();
    const set = vi.fn(async () => ({}));
    await registerSlashCommands({ set }, [FAKE_SPEC], logger);
    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith([FAKE_SPEC.data], undefined);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ['reply-mode'],
        commandCount: 1,
        scope: 'global',
        guildId: null,
      }),
      'discord_slash_commands_registered',
    );
  });

  it('传 guildId → set([data], guildId) + scope=guild + 日志含 guildId', async () => {
    const logger = makeLogger();
    const set = vi.fn(async () => ({}));
    await registerSlashCommands({ set }, [FAKE_SPEC], logger, 'GUILD123');
    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith([FAKE_SPEC.data], 'GUILD123');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ['reply-mode'],
        commandCount: 1,
        scope: 'guild',
        guildId: 'GUILD123',
      }),
      'discord_slash_commands_registered',
    );
  });

  it('传 guildId 但 bulk set reject（如 bot 不在该 guild）→ error 日志含 scope/guildId', async () => {
    const logger = makeLogger();
    const set = vi.fn(async () => {
      throw new Error('Missing Access');
    });
    await registerSlashCommands({ set }, [FAKE_SPEC], logger, 'GUILD_NOT_JOINED');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ['reply-mode'],
        commandCount: 1,
        scope: 'guild',
        guildId: 'GUILD_NOT_JOINED',
      }),
      'discord_slash_command_register_failed',
    );
  });

  it('多条全部成功 → 单次 bulk set，打一条批量成功日志', async () => {
    const logger = makeLogger();
    const set = vi.fn(async () => ({}));
    await registerSlashCommands({ set }, [FAKE_SPEC, ANOTHER_SPEC], logger);
    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      [FAKE_SPEC.data, ANOTHER_SPEC.data],
      undefined,
    );
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ['reply-mode', 'other'],
        commandCount: 2,
      }),
      'discord_slash_commands_registered',
    );
  });

  it('bulk set reject → 记 error、整体不抛且不记录原始错误内容', async () => {
    const logger = makeLogger();
    const set = vi.fn(async () => {
      throw new Error('SECRET_PAYLOAD discord 5xx');
    });
    await expect(
      registerSlashCommands({ set }, [FAKE_SPEC, ANOTHER_SPEC], logger),
    ).resolves.toBeUndefined();
    expect(set).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ['reply-mode', 'other'],
        commandCount: 2,
      }),
      'discord_slash_command_register_failed',
    );
    expect(JSON.stringify(logger.error.mock.calls[0]![0])).not.toContain(
      'SECRET_PAYLOAD',
    );
  });
});

describe('createDiscordCommandRegistrationPort', () => {
  it('maps a daemon registration plan to one Discord bulk replacement and returns applied generation', async () => {
    const logger = makeLogger();
    const set = vi.fn(async () => ({}));
    const plan: CommandRegistrationPlan = {
      scope: {
        platformName: 'discord-main',
        platformType: 'discord',
        nativeScope: { kind: 'guild', guildId: 'GUILD123' },
      },
      commands: [
        {
          commandName: 'discord-reply-mode',
          canonicalId: 'platform:discord:reply-mode',
          aliasKind: 'stable',
          descriptor: discordReplyModeCommandDescriptor,
        },
        {
          commandName: 'reply-mode',
          canonicalId: 'platform:discord:reply-mode',
          aliasKind: 'legacy',
          descriptor: discordReplyModeCommandDescriptor,
        },
      ],
      reverseMap: { entries: {} },
      generation: 'generation-1',
    };

    const port = createDiscordCommandRegistrationPort({ set }, logger);
    const result = await port.applyCommandPlan(plan);

    expect(result).toEqual({ status: 'applied', generation: 'generation-1' });
    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0]![0]).toMatchObject([
      { name: 'discord-reply-mode' },
      { name: 'reply-mode' },
    ]);
    expect(set.mock.calls[0]![1]).toBe('GUILD123');
  });

  it('returns failed result when Discord bulk replacement fails', async () => {
    const logger = makeLogger();
    const set = vi.fn(async () => {
      throw new Error('SECRET_PAYLOAD missing access');
    });
    const plan: CommandRegistrationPlan = {
      scope: {
        platformName: 'discord-main',
        platformType: 'discord',
        nativeScope: { kind: 'global' },
      },
      commands: [],
      reverseMap: { entries: {} },
      generation: 'generation-2',
    };

    const port = createDiscordCommandRegistrationPort({ set }, logger);
    const result = await port.applyCommandPlan(plan);

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'command_registration_failed',
        message: 'discord slash command bulk registration failed',
      },
    });
    if (result.status === 'failed') {
      expect(result.error).not.toHaveProperty('cause');
    }
    expect(JSON.stringify(logger.error.mock.calls[0]![0])).not.toContain(
      'SECRET_PAYLOAD',
    );
  });

  it('rejects non-discord scopes without calling Discord bulk replacement', async () => {
    const logger = makeLogger();
    const set = vi.fn(async () => ({}));
    const plan: CommandRegistrationPlan = {
      scope: {
        platformName: 'chat-main',
        platformType: 'telegram',
        nativeScope: { kind: 'global' },
      },
      commands: [],
      reverseMap: { entries: {} },
      generation: 'generation-3',
    };

    const port = createDiscordCommandRegistrationPort({ set }, logger);
    const result = await port.applyCommandPlan(plan);

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'command_registration_failed',
        message: 'discord command registrar received a non-discord scope',
      },
    });
    expect(set).not.toHaveBeenCalled();
  });
});

describe('plannedCommandToSlashCommandSpec', () => {
  it('maps stable descriptor commands to Discord slash command payloads', () => {
    const spec = plannedCommandToSlashCommandSpec({
      commandName: 'discord-reply-mode',
      canonicalId: 'platform:discord:reply-mode',
      aliasKind: 'stable',
      descriptor: discordReplyModeCommandDescriptor,
    });

    expect(spec.name).toBe('discord-reply-mode');
    expect(spec.data).toMatchObject({
      name: 'discord-reply-mode',
      description: 'Query or switch the bot reply trigger mode',
      options: [
        expect.objectContaining({
          name: 'mode',
          required: false,
          choices: [
            { name: 'mention', value: 'mention' },
            { name: 'all', value: 'all' },
          ],
        }),
      ],
    });
  });

  it('maps the legacy /reply-mode alias to the same handler descriptor payload', () => {
    const spec = plannedCommandToSlashCommandSpec({
      commandName: 'reply-mode',
      canonicalId: 'platform:discord:reply-mode',
      aliasKind: 'legacy',
      descriptor: discordReplyModeCommandDescriptor,
    });

    expect(spec.name).toBe('reply-mode');
    expect(spec.data).toMatchObject({
      name: 'reply-mode',
      description: 'Query or switch the bot reply trigger mode',
    });
  });

  it('omits empty choices so Discord does not reject boolean or empty-choice options', () => {
    const spec = plannedCommandToSlashCommandSpec({
      commandName: 'nexus-status',
      canonicalId: 'daemon:status',
      aliasKind: 'stable',
      descriptor: {
        canonicalId: 'daemon:status',
        owner: { type: 'daemon' },
        localName: 'status',
        summary: 'Show daemon status',
        options: [
          {
            name: 'verbose',
            type: 'boolean',
            required: false,
            description: 'Show verbose status',
            choices: [],
          },
        ],
        handlerKey: 'status',
        applicability: {
          platformTypes: ['discord'],
          requiredCapabilities: ['slash-command-registration'],
        },
        legacyNames: [],
      },
    });

    expect(spec.data).toMatchObject({
      options: [expect.not.objectContaining({ choices: expect.any(Array) })],
    });
  });
});
