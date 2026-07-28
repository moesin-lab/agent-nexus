import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type ActiveCommandRegistry,
  type EngineAgent,
  type Logger,
} from '@agent-nexus/daemon';
import {
  DISCORD_CAPABILITIES,
  createDiscordPlatform,
} from '@agent-nexus/platform-discord';
import { createLarkPlatformAdapter } from '@agent-nexus/platform-lark';
import type { PlatformAdapter } from '@agent-nexus/protocol';
import { buildCliCommandRegistrationPlan } from './command-registry.js';
import type { AgentNexusConfig, PlatformConfig } from './config.js';

interface CliPlatformDependencies {
  ensureDiscordStateDirectory(statePath: string): Promise<void>;
  buildCommandPlan: typeof buildCliCommandRegistrationPlan;
  createDiscord: typeof createDiscordPlatform;
  createLark: typeof createLarkPlatformAdapter;
  now(): number;
}

interface CreateCliPlatformOptions {
  config: AgentNexusConfig;
  platformConfig: PlatformConfig;
  secret: string;
  agents: readonly EngineAgent[];
  commandRegistry: ActiveCommandRegistry;
  logger: Logger;
  dependencies?: Partial<CliPlatformDependencies>;
}

export interface CreatedCliPlatform {
  platform: PlatformAdapter;
  updateAdapterAuth?: (allowedUserIds: readonly string[]) => void;
}

const DEFAULT_DEPENDENCIES: CliPlatformDependencies = {
  ensureDiscordStateDirectory: async (statePath) => {
    await mkdir(dirname(statePath), {
      recursive: true,
      mode: 0o700,
    });
  },
  buildCommandPlan: buildCliCommandRegistrationPlan,
  createDiscord: createDiscordPlatform,
  createLark: createLarkPlatformAdapter,
  now: Date.now,
};

export async function createCliPlatform(
  options: CreateCliPlatformOptions,
): Promise<CreatedCliPlatform> {
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
  };
  const { config, platformConfig, secret, agents, commandRegistry, logger } =
    options;

  if (platformConfig.type === 'lark') {
    return {
      platform: dependencies.createLark({
        appId: platformConfig.appId,
        appSecret: secret,
        botOpenId: platformConfig.botOpenId,
        platformName: platformConfig.name,
        logger,
      }),
    };
  }

  logger.warn(
    {
      platformName: platformConfig.name,
      authFieldsParsedOnly: ['requireMentionOrSlash'],
      publicChannelMode: platformConfig.publicChannelMode,
      enforcedAtRuntime: [
        'auth.allowlist.userIds',
        'auth.allowlist.roleIds',
        'auth.allowlist.allowedGuildIds',
        'auth.allowlist.allowedChannelIds',
        'auth.allowlist.allowDM',
      ],
    },
    'platform_constraints_partially_enforced_until_auth_layer',
  );
  await dependencies.ensureDiscordStateDirectory(platformConfig.statePath);
  const commandPlan = dependencies.buildCommandPlan({
    config,
    agents,
    platformName: platformConfig.name,
    capabilities: DISCORD_CAPABILITIES,
    generation: `${platformConfig.name}:${dependencies.now()}`,
  });
  const commandRegistrationConfig = config.daemon.commandRegistry.registration;
  const discordPlatform = dependencies.createDiscord({
    token: secret,
    botUserId: platformConfig.botUserId,
    statePath: platformConfig.statePath,
    allowedUserIds: platformConfig.auth.allowlist.userIds,
    inboundAllowedUserIds: null,
    testGuildId: platformConfig.testGuildId,
    logger,
    commandRegistration: {
      plan: commandPlan,
      apply: (port, plan) =>
        commandRegistry.applyRegistrationPlan(plan, {
          port,
          logger,
          activatedAt: new Date(),
          enabled: commandRegistrationConfig.enabled,
          timeoutMs: commandRegistrationConfig.applyTimeoutMs,
          retry: commandRegistrationConfig.retry,
        }),
    },
  });

  return {
    platform: discordPlatform,
    updateAdapterAuth: (allowedUserIds) => {
      discordPlatform.updateAuth({
        allowedUserIds,
        inboundAllowedUserIds: null,
      });
    },
  };
}
