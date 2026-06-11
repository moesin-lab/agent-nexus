#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ActiveCommandRegistry,
  Engine,
  SessionStore,
  createLogger,
  daemonCommandDescriptors,
  type RoutingEntry,
} from '@agent-nexus/daemon';
import {
  DISCORD_CAPABILITIES,
  createDiscordPlatform,
} from '@agent-nexus/platform-discord';
import { createAgentRegistry } from './agent.js';
import { buildCliCommandRegistrationPlan } from './command-registry.js';
import {
  createConfigReloader,
  type ConfigReloadTarget,
} from './config-reload.js';
import {
  ConfigError,
  SecretsPermissionError,
  buildRoutingTable,
  loadConfig,
  loadSecret,
} from './config.js';

async function main(): Promise<void> {
  let config;
  const tokensByRef = new Map<string, string>();
  try {
    config = await loadConfig();
    for (const platform of config.platforms) {
      if (!tokensByRef.has(platform.tokenRef)) {
        tokensByRef.set(platform.tokenRef, await loadSecret(platform.tokenRef));
      }
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof SecretsPermissionError) {
      process.stderr.write(`\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({ level: config.log.level });

  let agents;
  try {
    agents = await createAgentRegistry(config, logger);
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

  const routingTable: RoutingEntry[] = buildRoutingTable(config);
  logger.info(
    {
      platforms: config.platforms.map((platform) => platform.name),
      agents: agents.map((agent) => agent.agentName),
      bindings: routingTable.map((entry) => entry.bindingName),
    },
    'routing_table_loaded',
  );

  const sessionStore = new SessionStore();
  const commandRegistry = new ActiveCommandRegistry();
  const engines: Engine[] = [];
  // targets 在下面循环里随 engine 创建逐个填充；reloader 调用时才读取
  const configReloadTargets: ConfigReloadTarget[] = [];
  const configReloader = createConfigReloader({
    initialConfig: config,
    load: loadConfig,
    targets: configReloadTargets,
    runningAgentNames: agents.map((agent) => agent.agentName),
    logger,
  });

  for (const platformConfig of config.platforms) {
    logger.info(
      {
        platformName: platformConfig.name,
        source: 'file',
        secret: platformConfig.tokenRef,
      },
      'secret_loaded',
    );
    logger.warn(
      {
        platformName: platformConfig.name,
        authFieldsParsedOnly: [
          'requireMentionOrSlash',
        ],
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

    // state 目录与 secrets 目录同级，权限 0700 与 secrets 一致
    // → spec/platform-adapter.md §"运行时状态持久化"
    await mkdir(dirname(platformConfig.statePath), { recursive: true, mode: 0o700 });

    const token = tokensByRef.get(platformConfig.tokenRef);
    if (!token) {
      throw new ConfigError(`secret ref "${platformConfig.tokenRef}" 未加载`);
    }
    const commandPlan = buildCliCommandRegistrationPlan({
      config,
      agents,
      platformName: platformConfig.name,
      capabilities: DISCORD_CAPABILITIES,
      generation: `${platformConfig.name}:${Date.now()}`,
    });
    const commandRegistrationConfig = config.daemon.commandRegistry.registration;
    const platform = createDiscordPlatform({
      token,
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

    const engine = new Engine({
      platform,
      platformName: platformConfig.name,
      platformType: platformConfig.type,
      platformAuth: platformConfig.auth,
      commandRegistry,
      daemonCommandHandlerKeys: daemonCommandDescriptors.map(
        (descriptor) => descriptor.handlerKey,
      ),
      configReloader,
      agents,
      routingTable,
      logger,
      sessionStore,
      toolMessages: {
        mode: config.ui.toolMessages,
      },
      textPrefixes: {
        newSession: config.daemon.commandRegistry.textPrefixes.newSession,
      },
    });
    engines.push(engine);
    configReloadTargets.push({
      platformName: platformConfig.name,
      applyRuntimeUpdate: (update) => {
        engine.applyRuntimeUpdate(update);
        // adapter 内部命令（/discord-reply-mode）授权跟随热替换；
        // chat 授权由 daemon platform auth 全维度判定（null = inbound guard 关闭，与启动语义一致）
        platform.updateAuth({
          allowedUserIds: update.platformAuth.allowlist.userIds,
          inboundAllowedUserIds: null,
        });
      },
    });
  }

  await Promise.all(engines.map((engine) => engine.start()));
  logger.info({ engines: engines.length }, 'engine_started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown_signal');
    try {
      await Promise.all(engines.map((engine) => engine.stop()));
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
