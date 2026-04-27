#!/usr/bin/env node
import { createClaudeCodeRuntime, runCompatibilityProbe } from '@agent-nexus/agent-claudecode';
import { Engine, SessionStore, createLogger } from '@agent-nexus/daemon';
import { createDiscordPlatform } from '@agent-nexus/platform-discord';
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

  // CompatibilityProbe step 1+2（spec/agent-backends/claude-code-cli.md §兼容性自检）
  // step 3 stream-json 验证留给后续 PR。
  try {
    await runCompatibilityProbe({ claudeBin: config.claudeCode.bin, logger });
  } catch (err) {
    logger.error({ err }, 'cc_compat_probe_failed');
    process.exit(1);
  }

  if (config.claudeCode.allowedTools.includes('Bash')) {
    // spec/security/tool-boundary.md：危险工具显式启用必须打 warn。
    logger.warn(
      { tools: config.claudeCode.allowedTools },
      'tool_boundary_bash_enabled',
    );
  }

  const agent = createClaudeCodeRuntime({
    claudeBin: config.claudeCode.bin,
    allowedTools: config.claudeCode.allowedTools,
    defaultWorkingDir: config.claudeCode.workingDir,
    logger,
  });

  const platform = createDiscordPlatform({
    token,
    botUserId: config.discord.botUserId,
    logger,
  });

  const sessionStore = new SessionStore();

  const engine = new Engine({
    platform,
    agent,
    logger,
    sessionStore,
    defaultSessionConfig: {
      workingDir: config.claudeCode.workingDir,
      toolWhitelist: config.claudeCode.allowedTools,
      timeoutMs: 60_000,
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
