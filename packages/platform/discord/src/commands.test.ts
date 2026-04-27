import { describe, expect, it, vi } from 'vitest';
import {
  registerSlashCommands,
  type SlashCommandRegistrar,
  type SlashCommandSpec,
} from './commands.js';

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

  it('空 specs → 不调 create，不报错', async () => {
    const logger = makeLogger();
    const create = vi.fn(async () => ({}));
    const registrar: SlashCommandRegistrar = { create };
    await registerSlashCommands(registrar, [], logger);
    expect(create).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('单条成功（不传 guildId）→ create(data, undefined) + scope=global', async () => {
    const logger = makeLogger();
    const create = vi.fn(async () => ({}));
    await registerSlashCommands({ create }, [FAKE_SPEC], logger);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(FAKE_SPEC.data, undefined);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'reply-mode',
        scope: 'global',
        guildId: null,
      }),
      'discord_slash_command_registered',
    );
  });

  it('传 guildId → create(data, guildId) + scope=guild + 日志含 guildId', async () => {
    const logger = makeLogger();
    const create = vi.fn(async () => ({}));
    await registerSlashCommands({ create }, [FAKE_SPEC], logger, 'GUILD123');
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(FAKE_SPEC.data, 'GUILD123');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'reply-mode',
        scope: 'guild',
        guildId: 'GUILD123',
      }),
      'discord_slash_command_registered',
    );
  });

  it('传 guildId 但 create reject（如 bot 不在该 guild）→ error 日志含 scope/guildId', async () => {
    const logger = makeLogger();
    const create = vi.fn(async () => {
      throw new Error('Missing Access');
    });
    await registerSlashCommands({ create }, [FAKE_SPEC], logger, 'GUILD_NOT_JOINED');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'reply-mode',
        scope: 'guild',
        guildId: 'GUILD_NOT_JOINED',
      }),
      'discord_slash_command_register_failed',
    );
  });

  it('多条全部成功 → 顺序调用、各打 info', async () => {
    const logger = makeLogger();
    const create = vi.fn(async () => ({}));
    await registerSlashCommands({ create }, [FAKE_SPEC, ANOTHER_SPEC], logger);
    expect(create).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it('某条 create reject → 记 error 但继续后续，整体不抛', async () => {
    const logger = makeLogger();
    const create = vi.fn(async (data: unknown) => {
      if ((data as { name: string }).name === 'reply-mode') {
        throw new Error('discord 5xx');
      }
      return {};
    });
    await expect(
      registerSlashCommands({ create }, [FAKE_SPEC, ANOTHER_SPEC], logger),
    ).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'reply-mode' }),
      'discord_slash_command_register_failed',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'other' }),
      'discord_slash_command_registered',
    );
  });
});
