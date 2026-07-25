import { describe, expect, it, vi } from 'vitest';
import {
  ActiveCommandRegistry,
  DEFAULT_DAEMON_RUNTIME_CONFIG,
  type Logger,
} from '@agent-nexus/daemon';
import type { PlatformAdapter } from '@agent-nexus/protocol';
import type { AgentNexusConfig, PlatformConfig } from './config.js';
import { createCliPlatform } from './platform-factory.js';

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as Logger;
}

function fakePlatform(): PlatformAdapter {
  return {} as PlatformAdapter;
}

const AUTH = {
  allowlist: {
    userIds: ['U1'],
    roleIds: [],
    allowedGuildIds: [],
    allowedChannelIds: [],
    allowDM: true,
    requireMentionOrSlash: true,
  },
};

const discordConfig: PlatformConfig = {
  name: 'discord-main',
  type: 'discord',
  botUserId: 'discord-bot',
  tokenRef: 'DISCORD_TOKEN',
  statePath: '/state/discord-main.json',
  publicChannelMode: 'thread',
  auth: AUTH,
};

const larkConfig: PlatformConfig = {
  name: 'lark-main',
  type: 'lark',
  appId: 'cli_0123456789abcdef',
  appSecretRef: 'LARK_APP_SECRET',
  botOpenId: 'ou_bot_open_id',
  auth: {
    allowlist: {
      ...AUTH.allowlist,
      userIds: ['ou_user_open_id'],
    },
  },
};

const config: AgentNexusConfig = {
  platforms: [discordConfig, larkConfig],
  agents: [
    {
      name: 'codex-dev',
      backend: 'codex',
      codex: {
        bin: 'codex',
        workingDir: '/workspace',
        sandbox: 'read-only',
        addDirs: [],
        loadUserConfig: false,
        loadRules: false,
      },
    },
  ],
  bindings: [
    {
      name: 'discord-codex',
      platformName: 'discord-main',
      agentName: 'codex-dev',
      match: { discord: { channelIds: ['C1'] } },
    },
    {
      name: 'lark-codex',
      platformName: 'lark-main',
      agentName: 'codex-dev',
      match: { lark: { chatIds: ['oc_chat_1'] } },
    },
  ],
  daemon: structuredClone(DEFAULT_DAEMON_RUNTIME_CONFIG),
  ui: { toolMessages: 'append' },
  log: { level: 'info' },
};

describe('createCliPlatform', () => {
  it('混合配置只把各自 secret 和资源交给对应平台 factory', async () => {
    const logger = makeLogger();
    const ensureDiscordStateDirectory = vi.fn(async () => {});
    const buildCommandPlan = vi.fn(() => ({ commands: [] }));
    const discordPlatform = fakePlatform();
    const larkPlatform = fakePlatform();
    const createDiscord = vi.fn(() => discordPlatform);
    const createLark = vi.fn(() => larkPlatform);
    const common = {
      config,
      agents: [],
      commandRegistry: new ActiveCommandRegistry(),
      logger,
      dependencies: {
        ensureDiscordStateDirectory,
        buildCommandPlan,
        createDiscord,
        createLark,
        now: () => 123,
      },
    };

    const discord = await createCliPlatform({
      ...common,
      platformConfig: discordConfig,
      secret: 'discord-secret',
    });
    const lark = await createCliPlatform({
      ...common,
      platformConfig: larkConfig,
      secret: 'lark-secret',
    });

    expect(discord.platform).toBe(discordPlatform);
    expect(lark.platform).toBe(larkPlatform);
    expect(ensureDiscordStateDirectory).toHaveBeenCalledTimes(1);
    expect(buildCommandPlan).toHaveBeenCalledTimes(1);
    expect(createDiscord).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'discord-secret' }),
    );
    expect(createLark).toHaveBeenCalledWith({
      appId: 'cli_0123456789abcdef',
      appSecret: 'lark-secret',
      botOpenId: 'ou_bot_open_id',
      platformName: 'lark-main',
      logger,
    });
    expect(discord.updateAdapterAuth).toEqual(expect.any(Function));
    expect(lark.updateAdapterAuth).toBeUndefined();
  });
});
