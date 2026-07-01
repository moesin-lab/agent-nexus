import type {
  DaemonConfigEditableField,
  DaemonConfigFieldsProvider,
  DaemonConfigPreviewer,
  DaemonConfigEditor,
  DaemonConfigReloader,
  DaemonConfigReloadResult,
  DaemonConfigEditEffect,
  DaemonConfigEditRisk,
  DaemonConfigValueKind,
  EngineRuntimeUpdate,
  Logger,
} from '@agent-nexus/daemon';
import { agentOwnersForPlatform } from './command-registry.js';
import {
  buildRoutingTable,
  type AgentNexusConfig,
  type AgentConfig,
  type ConfigFileEditInput,
  type ConfigFileEditPreviewInput,
  type ConfigFileEditPreviewResult,
  type ConfigFileEditResult,
  type BindingConfig,
  type PlatformConfig,
} from './config.js';

/** reload 时被热替换的 engine 目标；语义见 docs/dev/spec/config-routing.md §配置热重载 */
export interface ConfigReloadTarget {
  platformName: string;
  applyRuntimeUpdate(update: EngineRuntimeUpdate): void;
}

export interface CreateConfigReloaderOptions {
  initialConfig: AgentNexusConfig;
  load: () => Promise<AgentNexusConfig>;
  /** call 时读取，允许调用方在 engine 逐个创建期间填充 */
  targets: readonly ConfigReloadTarget[];
  runningAgentNames: readonly string[];
  logger: Logger;
}

export interface CreateConfigEditorOptions {
  edit(input: ConfigFileEditInput): Promise<ConfigFileEditResult>;
  reload: DaemonConfigReloader;
  logger: Logger;
}

export interface CreateConfigFieldsProviderOptions {
  load: () => Promise<AgentNexusConfig>;
}

export interface CreateConfigPreviewerOptions {
  preview(input: ConfigFileEditPreviewInput): Promise<ConfigFileEditPreviewResult>;
}

function failed(reason: string): DaemonConfigReloadResult {
  return {
    status: 'failed',
    message: `[config reload failed] previous config kept:\n${reason}`,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function configValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '[missing]';
  return JSON.stringify(value);
}

function effectForPath(path: string): DaemonConfigEditEffect {
  if (
    path === 'ui.toolMessages' ||
    path === 'daemon.commandRegistry.textPrefixes.newSession' ||
    /^platforms\[\d+\]\.auth(?:\.|$)/.test(path)
  ) {
    return 'hot';
  }
  if (/^bindings\[\d+\]\./.test(path)) {
    return 'conditional-hot';
  }
  return 'restart';
}

function riskForPath(path: string): DaemonConfigEditRisk {
  if (
    /^platforms\[\d+\]\.auth(?:\.|$)/.test(path) ||
    path.includes('.auth.') ||
    path.endsWith('.sandbox') ||
    path.endsWith('.addDirs') ||
    path.endsWith('.loadUserConfig') ||
    path.endsWith('.loadRules') ||
    path.endsWith('.allowedTools') ||
    path.endsWith('.permissionLevel') ||
    path.endsWith('.bin') ||
    path.endsWith('.tokenRef') ||
    path.endsWith('.statePath') ||
    path.includes('.externalImport') ||
    path.includes('.providerCapture')
  ) {
    return 'high';
  }
  return 'normal';
}

function field(
  input: Omit<DaemonConfigEditableField, 'effect' | 'risk' | 'value'> & {
    value: unknown;
  },
): DaemonConfigEditableField {
  return {
    ...input,
    value: configValue(input.value),
    effect: effectForPath(input.path),
    risk: riskForPath(input.path),
  };
}

function platformFields(platform: PlatformConfig, index: number): DaemonConfigEditableField[] {
  const base = `platforms[${index}]`;
  const category = `Platform ${platform.name}`;
  const allowlist = platform.auth.allowlist;
  return [
    field({
      key: `${base}.botUserId`,
      label: `${platform.name} bot user ID`,
      category,
      path: `${base}.botUserId`,
      value: platform.botUserId,
      valueKind: 'string',
    }),
    field({
      key: `${base}.tokenRef`,
      label: `${platform.name} token ref`,
      category,
      path: `${base}.tokenRef`,
      value: platform.tokenRef,
      valueKind: 'string',
    }),
    field({
      key: `${base}.statePath`,
      label: `${platform.name} state path`,
      category,
      path: `${base}.statePath`,
      value: platform.statePath,
      valueKind: 'string',
    }),
    field({
      key: `${base}.testGuildId`,
      label: `${platform.name} test guild`,
      category,
      path: `${base}.testGuildId`,
      value: platform.testGuildId ?? '',
      valueKind: 'string',
    }),
    field({
      key: `${base}.publicChannelMode`,
      label: `${platform.name} public channel mode`,
      category,
      path: `${base}.publicChannelMode`,
      value: platform.publicChannelMode,
      valueKind: 'enum',
      options: ['disabled', 'thread', 'public'],
    }),
    field({
      key: `${base}.auth.allowlist.userIds`,
      label: `${platform.name} allowed users`,
      category,
      path: `${base}.auth.allowlist.userIds`,
      value: allowlist.userIds,
      valueKind: 'string-list',
    }),
    field({
      key: `${base}.auth.allowlist.roleIds`,
      label: `${platform.name} allowed roles`,
      category,
      path: `${base}.auth.allowlist.roleIds`,
      value: allowlist.roleIds,
      valueKind: 'string-list',
    }),
    field({
      key: `${base}.auth.allowlist.allowedGuildIds`,
      label: `${platform.name} allowed guilds`,
      category,
      path: `${base}.auth.allowlist.allowedGuildIds`,
      value: allowlist.allowedGuildIds,
      valueKind: 'string-list',
    }),
    field({
      key: `${base}.auth.allowlist.allowedChannelIds`,
      label: `${platform.name} allowed channels`,
      category,
      path: `${base}.auth.allowlist.allowedChannelIds`,
      value: allowlist.allowedChannelIds,
      valueKind: 'string-list',
    }),
    field({
      key: `${base}.auth.allowlist.allowDM`,
      label: `${platform.name} allow DM`,
      category,
      path: `${base}.auth.allowlist.allowDM`,
      value: allowlist.allowDM,
      valueKind: 'boolean',
    }),
    field({
      key: `${base}.auth.allowlist.requireMentionOrSlash`,
      label: `${platform.name} require mention or slash`,
      category,
      path: `${base}.auth.allowlist.requireMentionOrSlash`,
      value: allowlist.requireMentionOrSlash,
      valueKind: 'boolean',
    }),
  ];
}

function agentFields(agent: AgentConfig, index: number): DaemonConfigEditableField[] {
  const base = `agents[${index}]`;
  const common = [
    field({
      key: `${base}.timeoutMs`,
      label: `${agent.name} timeout`,
      category: `Agent ${agent.name}`,
      path: `${base}.timeoutMs`,
      value: agent.timeoutMs,
      valueKind: 'number',
    }),
  ];
  if (agent.backend === 'codex') {
    return [
      ...common,
      field({
        key: `${base}.codex.workingDir`,
        label: `${agent.name} workingDir`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.workingDir`,
        value: agent.codex.workingDir,
        valueKind: 'string',
      }),
      field({
        key: `${base}.codex.bin`,
        label: `${agent.name} codex bin`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.bin`,
        value: agent.codex.bin,
        valueKind: 'string',
      }),
      field({
        key: `${base}.codex.model`,
        label: `${agent.name} model`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.model`,
        value: agent.codex.model ?? '',
        valueKind: 'string',
      }),
      field({
        key: `${base}.codex.sandbox`,
        label: `${agent.name} sandbox`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.sandbox`,
        value: agent.codex.sandbox,
        valueKind: 'enum',
        options: ['read-only', 'workspace-write', 'danger-full-access'],
      }),
      field({
        key: `${base}.codex.addDirs`,
        label: `${agent.name} addDirs`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.addDirs`,
        value: agent.codex.addDirs,
        valueKind: 'string-list',
      }),
      field({
        key: `${base}.codex.loadUserConfig`,
        label: `${agent.name} load user config`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.loadUserConfig`,
        value: agent.codex.loadUserConfig,
        valueKind: 'boolean',
      }),
      field({
        key: `${base}.codex.loadRules`,
        label: `${agent.name} load rules`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.loadRules`,
        value: agent.codex.loadRules,
        valueKind: 'boolean',
      }),
    ];
  }
  return [
    ...common,
    field({
      key: `${base}.claudeCode.workingDir`,
      label: `${agent.name} workingDir`,
      category: `Agent ${agent.name}`,
      path: `${base}.claudeCode.workingDir`,
      value: agent.claudeCode.workingDir,
      valueKind: 'string',
    }),
    field({
      key: `${base}.claudeCode.bin`,
      label: `${agent.name} Claude bin`,
      category: `Agent ${agent.name}`,
      path: `${base}.claudeCode.bin`,
      value: agent.claudeCode.bin,
      valueKind: 'string',
    }),
    field({
      key: `${base}.claudeCode.allowedTools`,
      label: `${agent.name} allowed tools`,
      category: `Agent ${agent.name}`,
      path: `${base}.claudeCode.allowedTools`,
      value: agent.claudeCode.allowedTools,
      valueKind: 'string-list',
    }),
    field({
      key: `${base}.claudeCode.permissionLevel`,
      label: `${agent.name} permission level`,
      category: `Agent ${agent.name}`,
      path: `${base}.claudeCode.permissionLevel`,
      value: agent.claudeCode.permissionLevel,
      valueKind: 'enum',
      options: ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
    }),
  ];
}

function bindingFields(
  binding: BindingConfig,
  index: number,
  config: AgentNexusConfig,
): DaemonConfigEditableField[] {
  const base = `bindings[${index}]`;
  const category = `Binding ${binding.name}`;
  return [
    field({
      key: `${base}.name`,
      label: `${binding.name} name`,
      category,
      path: `${base}.name`,
      value: binding.name,
      valueKind: 'string',
    }),
    field({
      key: `${base}.platformName`,
      label: `${binding.name} platform`,
      category,
      path: `${base}.platformName`,
      value: binding.platformName,
      valueKind: 'enum',
      options: config.platforms.map((platform) => platform.name),
    }),
    field({
      key: `${base}.agentName`,
      label: `${binding.name} agent`,
      category,
      path: `${base}.agentName`,
      value: binding.agentName,
      valueKind: 'enum',
      options: config.agents.map((agent) => agent.name),
    }),
    field({
      key: `${base}.match.discord.channelIds`,
      label: `${binding.name} channel IDs`,
      category,
      path: `${base}.match.discord.channelIds`,
      value: binding.match.discord.channelIds,
      valueKind: 'string-list',
    }),
  ];
}

function daemonCommandFields(config: AgentNexusConfig): DaemonConfigEditableField[] {
  const commandRegistry = config.daemon.commandRegistry;
  const category = 'Daemon command registry';
  return [
    field({
      key: 'daemon.commandRegistry.registration.enabled',
      label: 'Command registration enabled',
      category,
      path: 'daemon.commandRegistry.registration.enabled',
      value: commandRegistry.registration.enabled,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.commandRegistry.registration.applyTimeoutMs',
      label: 'Command registration timeout',
      category,
      path: 'daemon.commandRegistry.registration.applyTimeoutMs',
      value: commandRegistry.registration.applyTimeoutMs,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.commandRegistry.registration.retry.maxAttempts',
      label: 'Command registration retry attempts',
      category,
      path: 'daemon.commandRegistry.registration.retry.maxAttempts',
      value: commandRegistry.registration.retry.maxAttempts,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.commandRegistry.registration.retry.backoffMs',
      label: 'Command registration retry backoff',
      category,
      path: 'daemon.commandRegistry.registration.retry.backoffMs',
      value: commandRegistry.registration.retry.backoffMs,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.commandRegistry.aliases.singleAgent.enabled',
      label: 'Single-agent bare aliases',
      category,
      path: 'daemon.commandRegistry.aliases.singleAgent.enabled',
      value: commandRegistry.aliases.singleAgent.enabled,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.commandRegistry.aliases.legacy.replyMode',
      label: 'Legacy reply-mode alias',
      category,
      path: 'daemon.commandRegistry.aliases.legacy.replyMode',
      value: commandRegistry.aliases.legacy.replyMode,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.commandRegistry.textPrefixes.newSession',
      label: 'Text prefix /new',
      category,
      path: 'daemon.commandRegistry.textPrefixes.newSession',
      value: commandRegistry.textPrefixes.newSession,
      valueKind: 'boolean',
    }),
  ];
}

function trajectoryFields(config: AgentNexusConfig): DaemonConfigEditableField[] {
  const trajectory = config.daemon.trajectory;
  const externalImport = trajectory.externalImport;
  const providerCapture = trajectory.providerCapture;
  const category = 'Daemon trajectory';
  return [
    field({
      key: 'daemon.trajectory.enabled',
      label: 'Trajectory enabled',
      category,
      path: 'daemon.trajectory.enabled',
      value: trajectory.enabled,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.trajectory.externalImport.enabled',
      label: 'External import enabled',
      category,
      path: 'daemon.trajectory.externalImport.enabled',
      value: externalImport.enabled,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.trajectory.externalImport.sources',
      label: 'External import sources',
      category,
      path: 'daemon.trajectory.externalImport.sources',
      value: externalImport.sources,
      valueKind: 'json',
    }),
    field({
      key: 'daemon.trajectory.externalImport.metadataOnlyDiscovery',
      label: 'Metadata-only discovery',
      category,
      path: 'daemon.trajectory.externalImport.metadataOnlyDiscovery',
      value: externalImport.metadataOnlyDiscovery,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.trajectory.externalImport.importContent',
      label: 'External import content',
      category,
      path: 'daemon.trajectory.externalImport.importContent',
      value: externalImport.importContent,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.trajectory.externalImport.maxFileBytes',
      label: 'External import max file bytes',
      category,
      path: 'daemon.trajectory.externalImport.maxFileBytes',
      value: externalImport.maxFileBytes,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.trajectory.externalImport.maxRecordsPerSession',
      label: 'External import max records',
      category,
      path: 'daemon.trajectory.externalImport.maxRecordsPerSession',
      value: externalImport.maxRecordsPerSession,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.trajectory.externalImport.maxAgeDays',
      label: 'External import max age days',
      category,
      path: 'daemon.trajectory.externalImport.maxAgeDays',
      value: externalImport.maxAgeDays,
      valueKind: 'json',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.enabled',
      label: 'Provider capture enabled',
      category,
      path: 'daemon.trajectory.providerCapture.enabled',
      value: providerCapture.enabled,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.mode',
      label: 'Provider capture mode',
      category,
      path: 'daemon.trajectory.providerCapture.mode',
      value: providerCapture.mode,
      valueKind: 'enum',
      options: ['reverse-proxy', 'forward-proxy', 'transcript-only'],
    }),
    field({
      key: 'daemon.trajectory.providerCapture.bindHost',
      label: 'Provider capture bind host',
      category,
      path: 'daemon.trajectory.providerCapture.bindHost',
      value: providerCapture.bindHost,
      valueKind: 'string',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.port',
      label: 'Provider capture port',
      category,
      path: 'daemon.trajectory.providerCapture.port',
      value: providerCapture.port,
      valueKind: 'json',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.storeRawStreams',
      label: 'Provider capture raw streams',
      category,
      path: 'daemon.trajectory.providerCapture.storeRawStreams',
      value: providerCapture.storeRawStreams,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.maxRequestBytes',
      label: 'Provider capture max request bytes',
      category,
      path: 'daemon.trajectory.providerCapture.maxRequestBytes',
      value: providerCapture.maxRequestBytes,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.maxResponseBytes',
      label: 'Provider capture max response bytes',
      category,
      path: 'daemon.trajectory.providerCapture.maxResponseBytes',
      value: providerCapture.maxResponseBytes,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.retentionDays',
      label: 'Provider capture retention days',
      category,
      path: 'daemon.trajectory.providerCapture.retentionDays',
      value: providerCapture.retentionDays,
      valueKind: 'number',
    }),
  ];
}

function configEditableFields(config: AgentNexusConfig): DaemonConfigEditableField[] {
  return [
    field({
      key: 'ui.toolMessages',
      label: 'UI tool messages',
      category: 'Hot behavior',
      path: 'ui.toolMessages',
      value: config.ui.toolMessages,
      valueKind: 'enum',
      options: ['append', 'compact'],
    }),
    ...daemonCommandFields(config),
    ...trajectoryFields(config),
    ...config.bindings.flatMap((binding, index) =>
      bindingFields(binding, index, config),
    ),
    ...config.platforms.flatMap((platform, index) => platformFields(platform, index)),
    ...config.agents.flatMap((agent, index) => agentFields(agent, index)),
    field({
      key: 'log.level',
      label: 'Log level',
      category: 'Process',
      path: 'log.level',
      value: config.log.level,
      valueKind: 'enum',
      options: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
    }),
  ];
}

function previewWarnings(path: string, newValue: unknown): string[] {
  const warnings: string[] = [];
  if (riskForPath(path) === 'high') {
    warnings.push('high-risk config boundary; review before applying');
  }
  if (path.endsWith('.sandbox') && newValue === 'danger-full-access') {
    warnings.push('danger-full-access removes filesystem sandbox protection');
  }
  if (path.endsWith('.permissionLevel') && newValue !== 'default') {
    warnings.push('non-default Claude Code permission level weakens tool isolation');
  }
  if (/^bindings\[\d+\]\.(agentName|platformName)$/.test(path)) {
    warnings.push('binding target changes may save but require restart if the agent owner set changes');
  }
  return warnings;
}

function reloadFailedAfterEditMessage(
  editResult: ConfigFileEditResult,
  reloadResult: DaemonConfigReloadResult,
): string {
  const previousConfigKeptPrefix = '[config reload failed] previous config kept:\n';
  const reason = reloadResult.message.startsWith(previousConfigKeptPrefix)
    ? reloadResult.message.slice(previousConfigKeptPrefix.length)
    : reloadResult.message;
  return (
    `${editResult.message}\n` +
    `[config reload failed] config saved; running config kept:\n${reason}`
  );
}

export function createConfigEditor(
  opts: CreateConfigEditorOptions,
): DaemonConfigEditor {
  return async (input) => {
    let editResult: ConfigFileEditResult;
    try {
      editResult = await opts.edit({
        path: input.path,
        value: input.value,
      });
    } catch (err) {
      const reason = errorMessage(err);
      opts.logger.warn(
        { err, path: input.path, userId: input.userId, channelId: input.channelId },
        'config_edit_rejected',
      );
      return {
        status: 'rejected',
        message: `[config edit rejected]\n${reason}`,
      };
    }

    try {
      const reloadResult = await opts.reload();
      if (reloadResult.status === 'failed') {
        return {
          status: 'edited',
          message: reloadFailedAfterEditMessage(editResult, reloadResult),
        };
      }
      return {
        status: 'edited',
        message: `${editResult.message}\n${reloadResult.message}`,
      };
    } catch (err) {
      const reason = errorMessage(err);
      opts.logger.error({ err, path: input.path }, 'config_edit_reload_failed');
      return {
        status: 'edited',
        message:
          `${editResult.message}\n` +
          `[config reload failed] config saved; running config kept:\n${reason}`,
      };
    }
  };
}

export function createConfigFieldsProvider(
  opts: CreateConfigFieldsProviderOptions,
): DaemonConfigFieldsProvider {
  return async () => ({
    fields: configEditableFields(await opts.load()),
  });
}

export function createConfigPreviewer(
  opts: CreateConfigPreviewerOptions,
): DaemonConfigPreviewer {
  return async (input) => {
    const preview = await opts.preview({
      path: input.path,
      value: input.value,
      platformName: input.platformName,
      platform: input.platform,
      userId: input.userId,
      channelId: input.channelId,
      ...(input.guildId ? { guildId: input.guildId } : {}),
      ...(input.initiatorRoleIds ? { initiatorRoleIds: input.initiatorRoleIds } : {}),
      ...(input.threadParentChannelId
        ? { threadParentChannelId: input.threadParentChannelId }
        : {}),
    });
    return {
      ...preview,
      effect: effectForPath(preview.path),
      warnings: previewWarnings(preview.path, preview.newValue),
    };
  };
}

/** 仅重启生效 section 的变更检测；热生效字段（auth / textPrefixes）剔除后再比较 */
function restartOnlyChanges(
  prev: AgentNexusConfig,
  next: AgentNexusConfig,
): string[] {
  const platformsSansAuth = (config: AgentNexusConfig) =>
    config.platforms.map(({ auth: _auth, ...rest }) => rest);
  const daemonSansTextPrefixes = (config: AgentNexusConfig) => ({
    ...config.daemon,
    commandRegistry: {
      ...config.daemon.commandRegistry,
      textPrefixes: {
        ...config.daemon.commandRegistry.textPrefixes,
        newSession: undefined,
      },
    },
  });
  const sections: string[] = [];
  if (
    JSON.stringify(platformsSansAuth(prev)) !==
    JSON.stringify(platformsSansAuth(next))
  ) {
    sections.push('platforms');
  }
  if (JSON.stringify(prev.agents) !== JSON.stringify(next.agents)) {
    sections.push('agents');
  }
  if (
    JSON.stringify(daemonSansTextPrefixes(prev)) !==
    JSON.stringify(daemonSansTextPrefixes(next))
  ) {
    sections.push('daemon');
  }
  if (JSON.stringify(prev.log) !== JSON.stringify(next.log)) {
    sections.push('log');
  }
  return sections;
}

export function createConfigReloader(
  opts: CreateConfigReloaderOptions,
): DaemonConfigReloader {
  let current = opts.initialConfig;
  return async (): Promise<DaemonConfigReloadResult> => {
    let next: AgentNexusConfig;
    try {
      next = await opts.load();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      opts.logger.error({ err }, 'config_reload_failed');
      return failed(reason);
    }

    const running = new Set(opts.runningAgentNames);
    const missingAgents = [
      ...new Set(
        next.bindings
          .filter((binding) => !running.has(binding.agentName))
          .map((binding) => binding.agentName),
      ),
    ];
    if (missingAgents.length > 0) {
      return failed(
        `bindings 引用了未运行的 agent：${missingAgents.join(', ')}（agents[] 变更需重启生效）`,
      );
    }

    const platformNames = new Set(next.platforms.map((platform) => platform.name));
    const missingPlatforms = opts.targets
      .filter((target) => !platformNames.has(target.platformName))
      .map((target) => target.platformName);
    if (missingPlatforms.length > 0) {
      return failed(
        `新配置缺少运行中的 platform：${missingPlatforms.join(', ')}（platforms[] 变更需重启生效）`,
      );
    }

    // slash command 注册集按启动时各 platform 的 agent owner 集合生成，
    // 不在 reload 事务内；owner 集合变化会让已注册命令与路由失配，按失败处理
    const ownerSet = (config: AgentNexusConfig, platformName: string) =>
      [...agentOwnersForPlatform(config, platformName)].sort().join(',');
    const ownerChangedPlatforms = opts.targets
      .map((target) => target.platformName)
      .filter((name) => ownerSet(current, name) !== ownerSet(next, name));
    if (ownerChangedPlatforms.length > 0) {
      return failed(
        `bindings 变更改变了 platform 的 agent owner 集合：${ownerChangedPlatforms.join(', ')}；` +
          'slash command 注册集不在 reload 事务内，需重启生效',
      );
    }

    const routingTable = buildRoutingTable(next);
    const authByPlatform = new Map(
      next.platforms.map((platform) => [platform.name, platform.auth]),
    );
    for (const target of opts.targets) {
      const platformAuth = authByPlatform.get(target.platformName);
      if (!platformAuth) continue; // missingPlatforms 已兜住；保留给类型收窄
      target.applyRuntimeUpdate({
        routingTable,
        platformAuth,
        toolMessageMode: next.ui.toolMessages,
        newSessionTextPrefix: next.daemon.commandRegistry.textPrefixes.newSession,
      });
    }

    const restartSections = restartOnlyChanges(current, next);
    current = next;
    opts.logger.info(
      { targets: opts.targets.length, restartSections },
      'config_reloaded',
    );
    const restartNote =
      restartSections.length > 0
        ? `\nrestart required for: ${restartSections.join(', ')}`
        : '';
    return {
      status: 'reloaded',
      message: `[config reloaded] applied: bindings, auth, ui, text prefixes${restartNote}`,
    };
  };
}
