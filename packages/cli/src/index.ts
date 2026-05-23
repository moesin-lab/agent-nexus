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
  loadDiscordToken,
} from './config.js';

async function main(): Promise<void> {
  let config;
  let token: string;
  try {
    config = await loadConfig();
    token = await loadDiscordToken();
  } catch (err) {
    if (err instanceof ConfigError || err instanceof SecretsPermissionError) {
      process.stderr.write(`\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({ level: config.log.level });
  logger.info(
    { source: 'file', secret: 'DISCORD_BOT_TOKEN' },
    'secret_loaded',
  );

  let selectedAgent: SelectedAgent;
  try {
    selectedAgent = await createSelectedAgent(config, logger);
  } catch (err) {
    logger.error(
      {
        agentBackend: config.agent.backend,
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
  await mkdir(dirname(config.discord.statePath), { recursive: true, mode: 0o700 });

  const platform = createDiscordPlatform({
    token,
    botUserId: config.discord.botUserId,
    statePath: config.discord.statePath,
    allowedUserIds: config.discord.allowedUserIds,
    testGuildId: config.discord.testGuildId,
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
