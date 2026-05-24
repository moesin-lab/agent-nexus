#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Engine, SessionStore, createLogger } from '@agent-nexus/daemon';
import { createDiscordPlatform } from '@agent-nexus/platform-discord';
import { createSelectedAgent, type SelectedAgent } from './agent.js';
import {
  ConfigError,
  SecretsPermissionError,
  loadConfig,
  loadSecret,
} from './config.js';

async function main(): Promise<void> {
  let config;
  let token: string;
  try {
    config = await loadConfig();
    const [firstPlatform] = config.platforms;
    if (!firstPlatform) {
      throw new ConfigError('platforms[] 不能是空数组');
    }
    token = await loadSecret(firstPlatform.tokenRef);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof SecretsPermissionError) {
      process.stderr.write(`\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({ level: config.log.level });
  const [platformConfig] = config.platforms;
  if (!platformConfig) {
    throw new ConfigError('platforms[] 不能是空数组');
  }
  logger.info(
    { source: 'file', secret: platformConfig.tokenRef },
    'secret_loaded',
  );
  logger.warn(
    {
      platformName: platformConfig.name,
      bindingChannelIds: platformConfig.bindings.map((binding) => binding.channelIds),
      authFieldsParsedOnly: [
        'roleIds',
        'allowedGuildIds',
        'allowedChannelIds',
        'allowDM',
        'requireMentionOrSlash',
      ],
      publicChannelMode: platformConfig.publicChannelMode,
      enforcedInP9: ['auth.allowlist.userIds'],
      plannedPhase: 'P10',
    },
    'p9_platform_constraints_not_enforced_until_router',
  );

  let selectedAgent: SelectedAgent;
  try {
    selectedAgent = await createSelectedAgent(config, logger);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n`);
      process.exit(1);
    }
    logger.error(
      {
        agentNames: config.agents.map((agent) => agent.name),
        errorKind: 'agent',
        code: 'compat_probe_failed',
        cause: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'agent_compat_probe_failed',
    );
    process.exit(1);
  }

  // state 目录与 secrets 目录同级，权限 0700 与 secrets 一致
  // → spec/platform-adapter.md §"运行时状态持久化"
  await mkdir(dirname(platformConfig.statePath), { recursive: true, mode: 0o700 });

  const platform = createDiscordPlatform({
    token,
    botUserId: platformConfig.botUserId,
    statePath: platformConfig.statePath,
    allowedUserIds: platformConfig.auth.allowlist.userIds,
    testGuildId: platformConfig.testGuildId,
    logger,
  });

  const sessionStore = new SessionStore();

  const engine = new Engine({
    platform,
    agent: selectedAgent.agent,
    logger,
    sessionStore,
    defaultSessionConfig: selectedAgent.defaultSessionConfig,
    toolMessages: {
      mode: config.ui.toolMessages,
    },
  });

  await engine.start();
  logger.info({}, 'engine_started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown_signal');
    try {
      await engine.stop();
    } catch (err) {
      logger.error({ err }, 'shutdown_error');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
