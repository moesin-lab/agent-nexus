export const TOOL_MESSAGE_MODES = ['append', 'compact'] as const;
export type ToolMessageMode = (typeof TOOL_MESSAGE_MODES)[number];

export interface DaemonConfig {
  toolMessages: ToolMessageMode;
}

export interface DaemonRegistrationRetryConfig {
  maxAttempts: number;
  backoffMs: number;
}

export interface DaemonCommandRegistryConfig {
  registration: {
    enabled: boolean;
    applyTimeoutMs: number;
    retry: DaemonRegistrationRetryConfig;
  };
  aliases: {
    singleAgent: {
      enabled: boolean;
    };
    legacy: {
      replyMode: boolean;
    };
  };
  textPrefixes: {
    newSession: boolean;
  };
}

export const TRAJECTORY_SOURCE_ADAPTERS = [
  'codex-cli-jsonl',
  'codex-app-jsonl',
  'claude-code-jsonl',
] as const;
export type TrajectorySourceAdapter =
  (typeof TRAJECTORY_SOURCE_ADAPTERS)[number];

export const PROVIDER_CAPTURE_MODES = [
  'reverse-proxy',
  'forward-proxy',
  'transcript-only',
] as const;
export type ProviderCaptureMode = (typeof PROVIDER_CAPTURE_MODES)[number];

export interface ExternalImportSourceConfig {
  adapter: TrajectorySourceAdapter;
  root: string;
  projectPathAllowlist: string[];
}

export interface ExternalImportConfig {
  enabled: boolean;
  sources: ExternalImportSourceConfig[];
  metadataOnlyDiscovery: boolean;
  importContent: boolean;
  maxFileBytes: number;
  maxRecordsPerSession: number;
  maxAgeDays: number | null;
}

export interface ProviderCaptureConfig {
  enabled: boolean;
  mode: ProviderCaptureMode;
  bindHost: string;
  port: number | null;
  storeRawStreams: boolean;
  maxRequestBytes: number;
  maxResponseBytes: number;
  retentionDays: number;
}

export interface TrajectoryObservabilityConfig {
  enabled: boolean;
  externalImport: ExternalImportConfig;
  providerCapture: ProviderCaptureConfig;
}

export interface DaemonRuntimeConfig {
  commandRegistry: DaemonCommandRegistryConfig;
  trajectory: TrajectoryObservabilityConfig;
}

export const DEFAULT_DAEMON_RUNTIME_CONFIG: DaemonRuntimeConfig = {
  commandRegistry: {
    registration: {
      enabled: true,
      applyTimeoutMs: 30000,
      retry: {
        maxAttempts: 3,
        backoffMs: 1000,
      },
    },
    aliases: {
      singleAgent: {
        enabled: true,
      },
      legacy: {
        replyMode: true,
      },
    },
    textPrefixes: {
      newSession: true,
    },
  },
  trajectory: {
    enabled: true,
    externalImport: {
      enabled: false,
      sources: [],
      metadataOnlyDiscovery: true,
      importContent: false,
      maxFileBytes: 10485760,
      maxRecordsPerSession: 20000,
      maxAgeDays: null,
    },
    providerCapture: {
      enabled: false,
      mode: 'transcript-only',
      bindHost: '127.0.0.1',
      port: null,
      storeRawStreams: false,
      maxRequestBytes: 1048576,
      maxResponseBytes: 4194304,
      retentionDays: 30,
    },
  },
};

export interface AllowlistConfig {
  userIds: string[];
  roleIds: string[];
  allowedGuildIds: string[];
  allowedChannelIds: string[];
  allowDM: boolean;
  requireMentionOrSlash: boolean;
}

export interface PlatformAuthConfig {
  allowlist: AllowlistConfig;
}

export class DaemonConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertNoUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new DaemonConfigError(`未知字段 ${path}.${key}`);
    }
  }
}

function parseStringArray(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): string[] {
  const value = raw[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DaemonConfigError(`字段 ${path}.${key} 必须是字符串数组`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new DaemonConfigError(`字段 ${path}.${key} 必须是非空字符串数组`);
    }
  }
  return [...value];
}

function parseNonEmptyString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  defaultValue?: string,
): string {
  const value = raw[key];
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof value !== 'string' || value.length === 0) {
    throw new DaemonConfigError(`字段 ${path}.${key} 必须是非空字符串`);
  }
  return value;
}

function parseBoolean(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  defaultValue: boolean,
): boolean {
  const value = raw[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new DaemonConfigError(`字段 ${path}.${key} 必须是布尔值`);
  }
  return value;
}

function parseInteger(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  defaultValue: number,
  min: number,
): number {
  const value = raw[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new DaemonConfigError(`字段 ${path}.${key} 必须是 >= ${min} 的整数`);
  }
  return value;
}

function parseNullableInteger(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  defaultValue: number | null,
  min: number,
): number | null {
  const value = raw[key];
  if (value === undefined) return defaultValue;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new DaemonConfigError(`字段 ${path}.${key} 必须是 null 或 >= ${min} 的整数`);
  }
  return value;
}

function parseEnum<T extends readonly string[]>(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  allowed: T,
  defaultValue: T[number],
): T[number] {
  const value = raw[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new DaemonConfigError(
      `字段 ${path}.${key} 必须是 ${allowed.map((v) => `"${v}"`).join(' / ')}`,
    );
  }
  return value;
}

function parseRequiredEnum<T extends readonly string[]>(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  allowed: T,
): T[number] {
  const value = raw[key];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new DaemonConfigError(
      `字段 ${path}.${key} 必须是 ${allowed.map((v) => `"${v}"`).join(' / ')}`,
    );
  }
  return value;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export function parsePlatformAuthConfig(
  raw: unknown,
  ctx: { path: string } = { path: 'auth' },
): PlatformAuthConfig {
  if (!isRecord(raw)) {
    throw new DaemonConfigError(`字段 ${ctx.path} 必须是对象`);
  }
  assertNoUnknownKeys(raw, ['allowlist'], ctx.path);

  const allowlistPath = `${ctx.path}.allowlist`;
  if (!isRecord(raw['allowlist'])) {
    throw new DaemonConfigError(`字段 ${allowlistPath} 必须是对象`);
  }
  const allowlist = raw['allowlist'];
  assertNoUnknownKeys(
    allowlist,
    [
      'userIds',
      'roleIds',
      'allowedGuildIds',
      'allowedChannelIds',
      'allowDM',
      'requireMentionOrSlash',
    ],
    allowlistPath,
  );

  const parsed: AllowlistConfig = {
    userIds: parseStringArray(allowlist, 'userIds', allowlistPath),
    roleIds: parseStringArray(allowlist, 'roleIds', allowlistPath),
    allowedGuildIds: parseStringArray(
      allowlist,
      'allowedGuildIds',
      allowlistPath,
    ),
    allowedChannelIds: parseStringArray(
      allowlist,
      'allowedChannelIds',
      allowlistPath,
    ),
    allowDM: parseBoolean(allowlist, 'allowDM', allowlistPath, true),
    requireMentionOrSlash: parseBoolean(
      allowlist,
      'requireMentionOrSlash',
      allowlistPath,
      true,
    ),
  };
  if (
    parsed.userIds.length === 0 &&
    parsed.roleIds.length === 0 &&
    parsed.allowedGuildIds.length === 0 &&
    parsed.allowedChannelIds.length === 0
  ) {
    throw new DaemonConfigError(
      `字段 ${allowlistPath} 至少需要一个非空 ID 列表`,
    );
  }

  return { allowlist: parsed };
}

export function parseDaemonConfig(raw: unknown): DaemonConfig {
  const ui = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const toolMessagesRaw = ui['toolMessages'];
  if (
    toolMessagesRaw !== undefined &&
    !TOOL_MESSAGE_MODES.includes(toolMessagesRaw as ToolMessageMode)
  ) {
    throw new DaemonConfigError(
      `字段 ui.toolMessages 必须是 ${TOOL_MESSAGE_MODES.map((v) => `"${v}"`).join(' / ')}`,
    );
  }
  return {
    toolMessages: (toolMessagesRaw as ToolMessageMode | undefined) ?? 'append',
  };
}

function parseExternalImportSource(
  raw: unknown,
  index: number,
): ExternalImportSourceConfig {
  const path = `daemon.trajectory.externalImport.sources[${index}]`;
  if (!isRecord(raw)) {
    throw new DaemonConfigError(`字段 ${path} 必须是对象`);
  }
  assertNoUnknownKeys(raw, ['adapter', 'root', 'projectPathAllowlist'], path);
  return {
    adapter: parseRequiredEnum(
      raw,
      'adapter',
      path,
      TRAJECTORY_SOURCE_ADAPTERS,
    ),
    root: parseNonEmptyString(raw, 'root', path),
    projectPathAllowlist: parseStringArray(
      raw,
      'projectPathAllowlist',
      path,
    ),
  };
}

function parseExternalImportConfig(raw: unknown): ExternalImportConfig {
  const path = 'daemon.trajectory.externalImport';
  if (raw !== undefined && !isRecord(raw)) {
    throw new DaemonConfigError(`字段 ${path} 必须是对象`);
  }
  const externalImport = (raw ?? {}) as Record<string, unknown>;
  assertNoUnknownKeys(
    externalImport,
    [
      'enabled',
      'sources',
      'metadataOnlyDiscovery',
      'importContent',
      'maxFileBytes',
      'maxRecordsPerSession',
      'maxAgeDays',
    ],
    path,
  );

  const sourcesRaw = externalImport['sources'];
  if (sourcesRaw !== undefined && !Array.isArray(sourcesRaw)) {
    throw new DaemonConfigError(`字段 ${path}.sources 必须是对象数组`);
  }

  return {
    enabled: parseBoolean(
      externalImport,
      'enabled',
      path,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.externalImport.enabled,
    ),
    sources: (sourcesRaw ?? []).map((source, index) =>
      parseExternalImportSource(source, index),
    ),
    metadataOnlyDiscovery: parseBoolean(
      externalImport,
      'metadataOnlyDiscovery',
      path,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.externalImport.metadataOnlyDiscovery,
    ),
    importContent: parseBoolean(
      externalImport,
      'importContent',
      path,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.externalImport.importContent,
    ),
    maxFileBytes: parseInteger(
      externalImport,
      'maxFileBytes',
      path,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.externalImport.maxFileBytes,
      1,
    ),
    maxRecordsPerSession: parseInteger(
      externalImport,
      'maxRecordsPerSession',
      path,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.externalImport.maxRecordsPerSession,
      1,
    ),
    maxAgeDays: parseNullableInteger(
      externalImport,
      'maxAgeDays',
      path,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.externalImport.maxAgeDays,
      1,
    ),
  };
}

function parseProviderCaptureConfig(raw: unknown): ProviderCaptureConfig {
  const path = 'daemon.trajectory.providerCapture';
  if (raw !== undefined && !isRecord(raw)) {
    throw new DaemonConfigError(`字段 ${path} 必须是对象`);
  }
  const providerCapture = (raw ?? {}) as Record<string, unknown>;
  assertNoUnknownKeys(
    providerCapture,
    [
      'enabled',
      'mode',
      'bindHost',
      'port',
      'storeRawStreams',
      'maxRequestBytes',
      'maxResponseBytes',
      'retentionDays',
    ],
    path,
  );

  const bindHost = parseNonEmptyString(
    providerCapture,
    'bindHost',
    path,
    DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.providerCapture.bindHost,
  );
  if (!isLoopbackHost(bindHost)) {
    throw new DaemonConfigError(`字段 ${path}.bindHost 必须是 loopback host`);
  }
  const port = parseNullableInteger(
    providerCapture,
    'port',
    path,
    DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.providerCapture.port,
    1,
  );
  if (port !== null && port > 65535) {
    throw new DaemonConfigError(`字段 ${path}.port 必须是 null 或 1..65535 的整数`);
  }

  return {
    enabled: parseBoolean(
      providerCapture,
      'enabled',
      path,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.providerCapture.enabled,
    ),
    mode: parseEnum(
      providerCapture,
      'mode',
      path,
      PROVIDER_CAPTURE_MODES,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.providerCapture.mode,
    ),
    bindHost,
    port,
    storeRawStreams: parseBoolean(
      providerCapture,
      'storeRawStreams',
      path,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.providerCapture.storeRawStreams,
    ),
    maxRequestBytes: parseInteger(
      providerCapture,
      'maxRequestBytes',
      path,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.providerCapture.maxRequestBytes,
      1,
    ),
    maxResponseBytes: parseInteger(
      providerCapture,
      'maxResponseBytes',
      path,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.providerCapture.maxResponseBytes,
      1,
    ),
    retentionDays: parseInteger(
      providerCapture,
      'retentionDays',
      path,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.providerCapture.retentionDays,
      1,
    ),
  };
}

function parseTrajectoryObservabilityConfig(
  raw: unknown,
): TrajectoryObservabilityConfig {
  const path = 'daemon.trajectory';
  if (raw !== undefined && !isRecord(raw)) {
    throw new DaemonConfigError(`字段 ${path} 必须是对象`);
  }
  const trajectory = (raw ?? {}) as Record<string, unknown>;
  assertNoUnknownKeys(
    trajectory,
    ['enabled', 'externalImport', 'providerCapture'],
    path,
  );
  return {
    enabled: parseBoolean(
      trajectory,
      'enabled',
      path,
      DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.enabled,
    ),
    externalImport: parseExternalImportConfig(trajectory['externalImport']),
    providerCapture: parseProviderCaptureConfig(trajectory['providerCapture']),
  };
}

export function parseDaemonRuntimeConfig(raw: unknown): DaemonRuntimeConfig {
  const path = 'daemon';
  if (raw !== undefined && !isRecord(raw)) {
    throw new DaemonConfigError(`字段 ${path} 必须是对象`);
  }
  const daemon = (raw ?? {}) as Record<string, unknown>;
  assertNoUnknownKeys(daemon, ['commandRegistry', 'trajectory'], path);

  const commandRegistryPath = `${path}.commandRegistry`;
  const commandRegistry = isRecord(daemon['commandRegistry'])
    ? daemon['commandRegistry']
    : {};
  if (
    daemon['commandRegistry'] !== undefined &&
    !isRecord(daemon['commandRegistry'])
  ) {
    throw new DaemonConfigError(`字段 ${commandRegistryPath} 必须是对象`);
  }
  assertNoUnknownKeys(
    commandRegistry,
    ['registration', 'aliases', 'textPrefixes'],
    commandRegistryPath,
  );

  const registrationPath = `${commandRegistryPath}.registration`;
  const registration = isRecord(commandRegistry['registration'])
    ? commandRegistry['registration']
    : {};
  if (
    commandRegistry['registration'] !== undefined &&
    !isRecord(commandRegistry['registration'])
  ) {
    throw new DaemonConfigError(`字段 ${registrationPath} 必须是对象`);
  }
  assertNoUnknownKeys(
    registration,
    ['enabled', 'applyTimeoutMs', 'retry'],
    registrationPath,
  );

  const retryPath = `${registrationPath}.retry`;
  const retry = isRecord(registration['retry']) ? registration['retry'] : {};
  if (registration['retry'] !== undefined && !isRecord(registration['retry'])) {
    throw new DaemonConfigError(`字段 ${retryPath} 必须是对象`);
  }
  assertNoUnknownKeys(retry, ['maxAttempts', 'backoffMs'], retryPath);

  const aliasesPath = `${commandRegistryPath}.aliases`;
  const aliases = isRecord(commandRegistry['aliases'])
    ? commandRegistry['aliases']
    : {};
  if (commandRegistry['aliases'] !== undefined && !isRecord(commandRegistry['aliases'])) {
    throw new DaemonConfigError(`字段 ${aliasesPath} 必须是对象`);
  }
  assertNoUnknownKeys(aliases, ['singleAgent', 'legacy'], aliasesPath);

  const singleAgentPath = `${aliasesPath}.singleAgent`;
  const singleAgent = isRecord(aliases['singleAgent'])
    ? aliases['singleAgent']
    : {};
  if (aliases['singleAgent'] !== undefined && !isRecord(aliases['singleAgent'])) {
    throw new DaemonConfigError(`字段 ${singleAgentPath} 必须是对象`);
  }
  assertNoUnknownKeys(singleAgent, ['enabled'], singleAgentPath);

  const legacyPath = `${aliasesPath}.legacy`;
  const legacy = isRecord(aliases['legacy']) ? aliases['legacy'] : {};
  if (aliases['legacy'] !== undefined && !isRecord(aliases['legacy'])) {
    throw new DaemonConfigError(`字段 ${legacyPath} 必须是对象`);
  }
  assertNoUnknownKeys(legacy, ['replyMode'], legacyPath);

  const textPrefixesPath = `${commandRegistryPath}.textPrefixes`;
  const textPrefixes = isRecord(commandRegistry['textPrefixes'])
    ? commandRegistry['textPrefixes']
    : {};
  if (
    commandRegistry['textPrefixes'] !== undefined &&
    !isRecord(commandRegistry['textPrefixes'])
  ) {
    throw new DaemonConfigError(`字段 ${textPrefixesPath} 必须是对象`);
  }
  assertNoUnknownKeys(textPrefixes, ['newSession'], textPrefixesPath);

  return {
    commandRegistry: {
      registration: {
        enabled: parseBoolean(
          registration,
          'enabled',
          registrationPath,
          DEFAULT_DAEMON_RUNTIME_CONFIG.commandRegistry.registration.enabled,
        ),
        applyTimeoutMs: parseInteger(
          registration,
          'applyTimeoutMs',
          registrationPath,
          DEFAULT_DAEMON_RUNTIME_CONFIG.commandRegistry.registration.applyTimeoutMs,
          1,
        ),
        retry: {
          maxAttempts: parseInteger(
            retry,
            'maxAttempts',
            retryPath,
            DEFAULT_DAEMON_RUNTIME_CONFIG.commandRegistry.registration.retry.maxAttempts,
            1,
          ),
          backoffMs: parseInteger(
            retry,
            'backoffMs',
            retryPath,
            DEFAULT_DAEMON_RUNTIME_CONFIG.commandRegistry.registration.retry.backoffMs,
            0,
          ),
        },
      },
      aliases: {
        singleAgent: {
          enabled: parseBoolean(
            singleAgent,
            'enabled',
            singleAgentPath,
            DEFAULT_DAEMON_RUNTIME_CONFIG.commandRegistry.aliases.singleAgent.enabled,
          ),
        },
        legacy: {
          replyMode: parseBoolean(
            legacy,
            'replyMode',
            legacyPath,
            DEFAULT_DAEMON_RUNTIME_CONFIG.commandRegistry.aliases.legacy.replyMode,
          ),
        },
      },
      textPrefixes: {
        newSession: parseBoolean(
          textPrefixes,
          'newSession',
          textPrefixesPath,
          DEFAULT_DAEMON_RUNTIME_CONFIG.commandRegistry.textPrefixes.newSession,
        ),
      },
    },
    trajectory: parseTrajectoryObservabilityConfig(daemon['trajectory']),
  };
}
