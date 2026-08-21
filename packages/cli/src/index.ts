#!/usr/bin/env node
import { join } from 'node:path';
import {
  ActiveCommandRegistry,
  Engine,
  ExternalSessionImportService,
  InMemoryIdempotencyStore,
  ProviderCaptureService,
  SessionStore,
  SqliteTrajectoryStore,
  createLogger,
  daemonCommandDescriptors,
  type RoutingEntry,
} from '@agent-nexus/daemon';
import { createAgentRegistry } from './agent.js';
import {
  createConfigEditor,
  createConfigFieldsProvider,
  createConfigPreviewer,
  createConfigReloader,
  type ConfigReloadTarget,
} from './config-reload.js';
import {
  applyConfigHomeArgv,
  ConfigError,
  SecretsPermissionError,
  buildRoutingTable,
  configRoot,
  editConfigFile,
  loadConfig,
  loadSecret,
  previewConfigFileEdit,
} from './config.js';
import { createCliPlatform } from './platform-factory.js';
import { startEnginesWithSignalShutdown, stopRuntimeEngines } from './startup.js';
import { runPackedCodexTurnVerification } from './packed-codex-verification.js';

const PROVIDER_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  if (process.argv.slice(2).includes('--verify-packed-codex-turn')) {
    if (
      process.argv.slice(2).length !== 1 ||
      process.env['AGENT_NEXUS_RUN_PACKED_CODEX_E2E'] !== '1'
    ) {
      throw new Error('packed Codex verification requires its explicit release gate');
    }
    await runPackedCodexTurnVerification();
    process.stdout.write('packed Codex app-server process lifecycle verified\n');
    return;
  }
  let config;
  const secretsByRef = new Map<string, string>();
  try {
    applyConfigHomeArgv(process.argv.slice(2));
    config = await loadConfig();
    for (const platform of config.platforms) {
      const secretRef =
        platform.type === 'discord' ? platform.tokenRef : platform.appSecretRef;
      if (!secretsByRef.has(secretRef)) {
        secretsByRef.set(secretRef, await loadSecret(secretRef));
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
  const idempotencyStore = new InMemoryIdempotencyStore();
  let trajectoryStore: SqliteTrajectoryStore | undefined;
  if (config.daemon.trajectory.enabled) {
    const trajectoryDbPath = join(configRoot(), 'state.db');
    try {
      trajectoryStore = new SqliteTrajectoryStore({ path: trajectoryDbPath });
    } catch (err) {
      logger.error(
        { err, path: trajectoryDbPath },
        'trajectory_store_open_failed',
      );
    }
  }
  const trajectoryWriteEnabled =
    config.daemon.trajectory.enabled && trajectoryStore !== undefined;
  const externalSessionImporter = trajectoryStore
    ? new ExternalSessionImportService({
        config: config.daemon.trajectory.externalImport,
        store: trajectoryStore,
        sessionStore,
        contentStorageRoot: configRoot(),
      })
    : undefined;
  const providerCaptureService = trajectoryStore
    ? new ProviderCaptureService({
        config: config.daemon.trajectory.providerCapture,
        store: trajectoryStore,
        contentStorageRoot: configRoot(),
      })
    : undefined;
  const providerCapture = config.daemon.trajectory.providerCapture.enabled
    ? providerCaptureService
    : undefined;
  let providerRetentionSweep: { stop(): void } | undefined;
  if (providerCapture) {
    applyProviderRetention(providerCapture);
    providerRetentionSweep = providerCapture.startRetentionSweep({
      intervalMs: PROVIDER_RETENTION_SWEEP_INTERVAL_MS,
      onApplied: logProviderRetention,
      onError: (err) => logger.error({ err }, 'provider_capture_retention_failed'),
    });
  }
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
  const configEditor = createConfigEditor({
    edit: editConfigFile,
    reload: configReloader,
    logger,
  });
  const configFields = createConfigFieldsProvider({
    load: loadConfig,
  });
  const configPreviewer = createConfigPreviewer({
    preview: previewConfigFileEdit,
  });

  for (const platformConfig of config.platforms) {
    const secretRef =
      platformConfig.type === 'discord'
        ? platformConfig.tokenRef
        : platformConfig.appSecretRef;
    logger.info(
      {
        platformName: platformConfig.name,
        source: 'file',
        secret: secretRef,
      },
      'secret_loaded',
    );
    const secret = secretsByRef.get(secretRef);
    if (!secret) {
      throw new ConfigError(`secret ref "${secretRef}" 未加载`);
    }

    const { platform, updateAdapterAuth } = await createCliPlatform({
      config,
      platformConfig,
      secret,
      agents,
      commandRegistry,
      logger,
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
      configFields,
      configPreviewer,
      configEditor,
      agents,
      routingTable,
      idempotencyStore,
      logger,
      sessionStore,
      toolMessages: {
        mode: config.ui.toolMessages,
      },
      textPrefixes: {
        newSession: config.daemon.commandRegistry.textPrefixes.newSession,
      },
      trajectory: {
        enabled: trajectoryWriteEnabled,
        store: trajectoryStore,
      },
      externalSessionImporter,
      providerCapture,
    });
    engines.push(engine);
    configReloadTargets.push({
      platformName: platformConfig.name,
      platformType: platformConfig.type,
      applyRuntimeUpdate: (update) => {
        engine.applyRuntimeUpdate(update);
        // adapter 内部命令（/discord-reply-mode）授权跟随热替换；
        // chat 授权由 daemon platform auth 全维度判定（null = inbound guard 关闭，与启动语义一致）
        updateAdapterAuth?.(update.platformAuth.allowlist.userIds);
      },
    });
  }

  const started = await startEnginesWithSignalShutdown({
    engines,
    signals: process,
    logger,
    exit: (code) => process.exit(code),
    shutdown: async () => {
      try {
        providerRetentionSweep?.stop();
        await stopRuntimeEngines(engines);
      } finally {
        trajectoryStore?.close();
      }
    },
  });
  if (!started) return;
  logger.info({ engines: engines.length }, 'engine_started');

  function applyProviderRetention(provider: ProviderCaptureService): void {
    try {
      logProviderRetention(provider.applyRetention());
    } catch (err) {
      logger.error({ err }, 'provider_capture_retention_failed');
    }
  }

  function logProviderRetention(retention: { deletedObservations: number }): void {
    if (retention.deletedObservations > 0) {
      logger.info(
        { deletedObservations: retention.deletedObservations },
        'provider_capture_retention_applied',
      );
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
