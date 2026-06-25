import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseDiscordBindingMatchConfig,
  parseDiscordPlatformConfig,
  type DiscordBindingMatchConfig,
  type DiscordPlatformConfig,
  DiscordConfigError,
} from '@agent-nexus/platform-discord';
import {
  parseClaudeCodeConfig,
  type ClaudeCodeConfig,
  ClaudeCodeConfigError,
} from '@agent-nexus/agent-claudecode';
import {
  parseCodexConfig,
  type CodexConfig,
  CodexConfigError,
} from '@agent-nexus/agent-codex';
import {
  DEFAULT_DAEMON_RUNTIME_CONFIG,
  parseDaemonConfig,
  parseDaemonRuntimeConfig,
  parsePlatformAuthConfig,
  type DaemonConfig,
  type DaemonRuntimeConfig,
  type PlatformAuthConfig,
  type RoutingEntry,
  DaemonConfigError,
} from '@agent-nexus/daemon';

export type {
  ClaudeCodeConfig,
  CodexConfig,
  DiscordPlatformConfig,
  DiscordBindingMatchConfig,
  PlatformAuthConfig,
};

export type AgentBackend = 'claudecode' | 'codex';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type PlatformConfig = DiscordPlatformConfig & {
  auth: PlatformAuthConfig;
};

export type AgentConfig =
  | {
      name: string;
      backend: 'claudecode';
      claudeCode: ClaudeCodeConfig;
    }
  | {
      name: string;
      backend: 'codex';
      codex: CodexConfig;
    };

export interface AgentNexusConfig {
  platforms: PlatformConfig[];
  agents: AgentConfig[];
  bindings: BindingConfig[];
  daemon: DaemonRuntimeConfig;
  ui: DaemonConfig;
  log: {
    level: LogLevel;
  };
}

export interface BindingConfig {
  name: string;
  platformName: string;
  agentName: string;
  match: {
    discord: DiscordBindingMatchConfig;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class SecretsPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsPermissionError';
  }
}

const DEFAULT_LOG_LEVEL = 'info' as const;
const BACKENDS = ['claudecode', 'codex'] as const;
const PLATFORM_TYPES = ['discord'] as const;
const LEGACY_TOP_LEVEL_KEYS = ['discord', 'agent', 'claudeCode', 'codex'] as const;
export const AGENT_NEXUS_HOME_ENV = 'AGENT_NEXUS_HOME' as const;

function expandHomePath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function normalizeConfigRoot(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new ConfigError(`${AGENT_NEXUS_HOME_ENV} / --home 不能是空路径`);
  }
  return resolve(expandHomePath(trimmed));
}

export function applyConfigHomeArgv(args: readonly string[]): void {
  let home: string | undefined;
  // Only extract config home in this pre-pass; later CLI/help/harness handling owns other args.
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') {
      break;
    }
    if (arg === '--home') {
      if (home !== undefined) {
        throw new ConfigError('参数 --home 只能指定一次');
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new ConfigError('参数 --home 需要一个路径');
      }
      home = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--home=')) {
      if (home !== undefined) {
        throw new ConfigError('参数 --home 只能指定一次');
      }
      home = arg.slice('--home='.length);
      continue;
    }
  }
  if (home !== undefined) {
    process.env[AGENT_NEXUS_HOME_ENV] = normalizeConfigRoot(home);
  }
}

export function configRoot(): string {
  const configuredRoot = process.env[AGENT_NEXUS_HOME_ENV];
  if (configuredRoot !== undefined) {
    return normalizeConfigRoot(configuredRoot);
  }
  return join(homedir(), '.agent-nexus');
}

export function configPath(): string {
  return join(configRoot(), 'config.json');
}

export function secretPath(name: string): string {
  return join(configRoot(), 'secrets', name);
}

export function discordTokenPath(): string {
  return secretPath('DISCORD_BOT_TOKEN');
}

export function defaultDiscordStatePath(name: string): string {
  return join(configRoot(), 'state', `discord-${encodeURIComponent(name)}.json`);
}

const CONFIG_HINT = (path: string) => `\
agent-nexus 配置模板已创建：${path}
请编辑其中的 platforms[].botUserId、platforms[].auth.allowlist、bindings[].match.discord.channelIds 和 agents[].workingDir，然后确认权限：
  chmod 600 ${path}
`;

const TOKEN_HINT = (path: string) => `\
secret 文件已创建或缺失：${path}
请写入 token（权限必须 0600）：
  echo -n '<your-token>' > ${path}
  chmod 600 ${path}
`;

const DEFAULT_CONFIG_TEMPLATE = `\
{
  "platforms": [
    {
      "name": "discord-main",
      "type": "discord",
      "botUserId": "",
      "tokenRef": "DISCORD_BOT_TOKEN",
      "publicChannelMode": "thread",
      "auth": {
        "allowlist": {
          "userIds": [],
          "roleIds": [],
          "allowedGuildIds": [],
          "allowedChannelIds": [],
          "allowDM": true,
          "requireMentionOrSlash": true
        }
      }
    }
  ],
  "agents": [
    {
      "name": "codex-dev",
      "backend": "codex",
      "codex": {
        "workingDir": "",
        "bin": "codex",
        "_sandboxComment": "allowed: read-only, workspace-write",
        "sandbox": "read-only",
        "addDirs": [],
        "loadUserConfig": false,
        "loadRules": false
      }
    },
    {
      "name": "claude-prod",
      "backend": "claudecode",
      "claudeCode": {
        "workingDir": "",
        "bin": "claude",
        "_permissionLevelComment": "allowed: default, acceptEdits, auto, bypassPermissions, dontAsk, plan",
        "permissionLevel": "default",
        "allowedTools": ["Read", "Grep", "Glob", "Edit", "Write"]
      }
    }
  ],
  "bindings": [
    {
      "name": "discord-main-codex-dev",
      "platformName": "discord-main",
      "agentName": "codex-dev",
      "match": {
        "discord": {
          "channelIds": []
        }
      }
    }
  ],
  "daemon": {
    "commandRegistry": {
      "registration": {
        "enabled": true,
        "applyTimeoutMs": 30000,
        "retry": {
          "maxAttempts": 3,
          "backoffMs": 1000
        }
      },
      "aliases": {
        "singleAgent": {
          "enabled": true
        },
        "legacy": {
          "replyMode": true
        }
      },
      "textPrefixes": {
        "newSession": true
      }
    },
    "trajectory": {
      "enabled": true,
      "externalImport": {
        "enabled": false,
        "sources": [],
        "metadataOnlyDiscovery": true,
        "importContent": false,
        "maxFileBytes": 10485760,
        "maxRecordsPerSession": 20000,
        "maxAgeDays": null
      },
      "providerCapture": {
        "enabled": false,
        "mode": "transcript-only",
        "bindHost": "127.0.0.1",
        "port": null,
        "storeRawStreams": false,
        "maxRequestBytes": 1048576,
        "maxResponseBytes": 4194304,
        "retentionDays": 30
      }
    }
  },
  "log": {
    "_levelComment": "allowed: trace, debug, info, warn, error, fatal",
    "level": "info"
  },
  "ui": {
    "_toolMessagesComment": "allowed: append, compact",
    "toolMessages": "append"
  }
}
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${path}.${key} 必须是非空字符串`);
  }
  return value;
}

function duplicateNames(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const name of items) {
    if (seen.has(name)) dup.add(name);
    seen.add(name);
  }
  return [...dup];
}

function assertNoUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`未知字段 ${path}.${key}`);
    }
  }
}

function cloneDefaultDaemonConfig(): DaemonRuntimeConfig {
  return JSON.parse(JSON.stringify(DEFAULT_DAEMON_RUNTIME_CONFIG)) as DaemonRuntimeConfig;
}

function mergeMissingObjectFields(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): boolean {
  let changed = false;
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!(key in target)) {
      target[key] = defaultValue;
      changed = true;
      continue;
    }
    if (isRecord(target[key]) && isRecord(defaultValue)) {
      changed = mergeMissingObjectFields(
        target[key] as Record<string, unknown>,
        defaultValue,
      ) || changed;
    }
  }
  return changed;
}

function applyTemplateDefaultsIfMissing(
  parsed: Record<string, unknown>,
): boolean {
  return mergeMissingObjectFields(parsed, {
    daemon: cloneDefaultDaemonConfig(),
  });
}

async function persistConfig(path: string, parsed: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
  await chmod(path, 0o600);
}

async function createFileIfMissing(
  path: string,
  content: string,
  mode: number,
): Promise<boolean> {
  try {
    await writeFile(path, content, { mode, flag: 'wx' });
    await chmod(path, mode);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

export async function ensureConfigDirs(): Promise<void> {
  const root = configRoot();
  const secrets = join(root, 'secrets');
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(secrets, 0o700);
}

export async function ensureConfigScaffold(): Promise<{
  configCreated: boolean;
  tokenCreated: boolean;
}> {
  await ensureConfigDirs();
  const configCreated = await createFileIfMissing(
    configPath(),
    DEFAULT_CONFIG_TEMPLATE,
    0o600,
  );
  const tokenCreated = await createFileIfMissing(discordTokenPath(), '', 0o600);
  return { configCreated, tokenCreated };
}

function assertArray(raw: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = raw[key];
  if (!Array.isArray(value)) {
    throw new ConfigError(`${path}.${key} 必须是非空数组`);
  }
  if (value.length === 0) {
    throw new ConfigError(`${path}.${key} 不能是空数组`);
  }
  return value;
}

function rejectLegacyTopLevel(path: string, obj: Record<string, unknown>): void {
  const legacyKeys = LEGACY_TOP_LEVEL_KEYS.filter((key) => key in obj);
  if (legacyKeys.length === 0) return;
  throw new ConfigError(
    `${path} 是 legacy 配置形态（顶层 ${legacyKeys.join(', ')}）。` +
      '请迁移为 platforms[] / agents[] / bindings[]：platforms[].name/type/auth/tokenRef，' +
      'agents[].name/backend/(claudeCode|codex)。loader 不做自动迁移。',
  );
}

function parseAgent(raw: unknown, index: number): AgentConfig {
  const path = `agents[${index}]`;
  if (!isRecord(raw)) {
    throw new ConfigError(`字段 ${path} 必须是对象`);
  }
  assertNoUnknownKeys(raw, ['name', 'backend', 'claudeCode', 'codex'], path);
  const name = requireNonEmptyString(raw, 'name', path);
  const backendRaw = raw['backend'];
  if (!BACKENDS.includes(backendRaw as AgentBackend)) {
    throw new ConfigError(
      `字段 ${path}.backend 必须是 ${BACKENDS.map((v) => `"${v}"`).join(' / ')}`,
    );
  }
  const backend = backendRaw as AgentBackend;

  if (backend === 'codex') {
    if ('claudeCode' in raw) {
      throw new ConfigError(`字段 ${path}.claudeCode 不允许出现在 backend="codex" 的 agent 中`);
    }
    if (!('codex' in raw)) {
      throw new ConfigError(`缺字段 ${path}.codex`);
    }
    try {
      return { name, backend, codex: parseCodexConfig(raw['codex']) };
    } catch (err) {
      if (err instanceof CodexConfigError) {
        throw new ConfigError(`${path}.codex ${err.message}`);
      }
      throw err;
    }
  }

  if ('codex' in raw) {
    throw new ConfigError(`字段 ${path}.codex 不允许出现在 backend="claudecode" 的 agent 中`);
  }
  if (!('claudeCode' in raw)) {
    throw new ConfigError(`缺字段 ${path}.claudeCode`);
  }
  try {
    return { name, backend, claudeCode: parseClaudeCodeConfig(raw['claudeCode']) };
  } catch (err) {
    if (err instanceof ClaudeCodeConfigError) {
      throw new ConfigError(`${path}.claudeCode ${err.message}`);
    }
    throw err;
  }
}

function rejectEmbeddedPlatformBindings(platformsRaw: unknown[]): void {
  for (const [index, raw] of platformsRaw.entries()) {
    if (isRecord(raw) && 'bindings' in raw) {
      throw new ConfigError(
        `字段 platforms[${index}].bindings 已迁移到顶层 bindings[]；` +
          '请把每条 binding 提升为 { name, platformName, agentName, match }',
      );
    }
  }
}

function parseBinding(
  raw: unknown,
  index: number,
  platformsByName: ReadonlyMap<string, PlatformConfig>,
): BindingConfig {
  const path = `bindings[${index}]`;
  if (!isRecord(raw)) {
    throw new ConfigError(`字段 ${path} 必须是对象`);
  }
  assertNoUnknownKeys(raw, ['name', 'platformName', 'agentName', 'match'], path);

  const name = requireNonEmptyString(raw, 'name', path);
  const platformName = requireNonEmptyString(raw, 'platformName', path);
  const agentName = requireNonEmptyString(raw, 'agentName', path);
  const platform = platformsByName.get(platformName);
  if (!platform) {
    throw new ConfigError(`字段 ${path}.platformName 引用了不存在的 platform "${platformName}"`);
  }
  if (!isRecord(raw['match'])) {
    throw new ConfigError(`字段 ${path}.match 必须是对象`);
  }

  if (platform.type === 'discord') {
    assertNoUnknownKeys(raw['match'], ['discord'], `${path}.match`);
    if (!('discord' in raw['match'])) {
      throw new ConfigError(`缺字段 ${path}.match.discord`);
    }
    try {
      return {
        name,
        platformName,
        agentName,
        match: {
          discord: parseDiscordBindingMatchConfig(raw['match']['discord'], {
            path: `${path}.match.discord`,
          }),
        },
      };
    } catch (err) {
      if (err instanceof DiscordConfigError) {
        throw new ConfigError(`${configPath()} ${err.message}`);
      }
      throw err;
    }
  }

  throw new ConfigError(`字段 ${path}.platformName 引用了暂不支持的 platform type "${platform.type}"`);
}

function parsePlatform(raw: unknown, index: number): PlatformConfig {
  const path = `platforms[${index}]`;
  if (!isRecord(raw)) {
    throw new ConfigError(`字段 ${path} 必须是对象`);
  }
  const typeRaw = raw['type'];
  if (!PLATFORM_TYPES.includes(typeRaw as 'discord')) {
    throw new ConfigError(
      `字段 ${path}.type 必须是 ${PLATFORM_TYPES.map((v) => `"${v}"`).join(' / ')}`,
    );
  }
  const name = requireNonEmptyString(raw, 'name', path);

  let auth: PlatformAuthConfig;
  try {
    auth = parsePlatformAuthConfig(raw['auth'], { path: `${path}.auth` });
  } catch (err) {
    if (err instanceof DaemonConfigError) {
      throw new ConfigError(`${configPath()} ${err.message}`);
    }
    throw err;
  }

  try {
    const platform = parseDiscordPlatformConfig(raw, {
      path,
      defaultStatePath: defaultDiscordStatePath(name),
    });
    return { ...platform, auth };
  } catch (err) {
    if (err instanceof DiscordConfigError) {
      throw new ConfigError(`${configPath()} ${err.message}`);
    }
    throw err;
  }
}

function assertAgentReferences(
  bindings: BindingConfig[],
  agents: AgentConfig[],
): void {
  const agentNames = new Set(agents.map((agent) => agent.name));
  for (const [bindingIndex, binding] of bindings.entries()) {
    if (!agentNames.has(binding.agentName)) {
      throw new ConfigError(
        `字段 bindings[${bindingIndex}].agentName 引用了不存在的 agent "${binding.agentName}"`,
      );
    }
  }
}

function assertUniquePlatformStatePaths(platforms: PlatformConfig[]): void {
  const duplicateStatePaths = duplicateNames(
    platforms.map((platform) => platform.statePath),
  );
  if (duplicateStatePaths.length > 0) {
    throw new ConfigError(
      `platforms[].statePath 重复：${duplicateStatePaths.join(', ')}`,
    );
  }
}

function parseLog(raw: unknown): { level: LogLevel } {
  const log = isRecord(raw) ? raw : {};
  const levelRaw = log['level'];
  if (
    levelRaw !== undefined &&
    !['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(
      levelRaw as LogLevel,
    )
  ) {
    throw new ConfigError(
      '字段 log.level 必须是 "trace" / "debug" / "info" / "warn" / "error" / "fatal"',
    );
  }
  return { level: (levelRaw as LogLevel | undefined) ?? DEFAULT_LOG_LEVEL };
}

export async function loadConfig(): Promise<AgentNexusConfig> {
  let scaffold;
  try {
    scaffold = await ensureConfigScaffold();
  } catch (err) {
    throw new ConfigError(`初始化配置文件失败：${(err as Error).message}`);
  }
  if (scaffold.configCreated) {
    throw new ConfigError(CONFIG_HINT(configPath()));
  }

  const path = configPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(CONFIG_HINT(path));
    }
    throw new ConfigError(`读取 ${path} 失败：${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${path} 不是合法 JSON：${(err as Error).message}`);
  }

  if (!isRecord(parsed)) {
    throw new ConfigError(`${path} 顶层必须是对象`);
  }
  rejectLegacyTopLevel(path, parsed);
  assertNoUnknownKeys(parsed, ['platforms', 'agents', 'bindings', 'daemon', 'log', 'ui'], path);
  const templateDefaultsChanged = applyTemplateDefaultsIfMissing(parsed);

  const platformsRaw = assertArray(parsed, 'platforms', path);
  const agentsRaw = assertArray(parsed, 'agents', path);
  const bindingsRaw = assertArray(parsed, 'bindings', path);
  rejectEmbeddedPlatformBindings(platformsRaw);

  const agents = agentsRaw.map((agent, index) => parseAgent(agent, index));
  const duplicateAgentNames = duplicateNames(agents.map((agent) => agent.name));
  if (duplicateAgentNames.length > 0) {
    throw new ConfigError(`agents[].name 重复：${duplicateAgentNames.join(', ')}`);
  }

  const platforms = platformsRaw.map((platform, index) =>
    parsePlatform(platform, index),
  );
  const duplicatePlatformNames = duplicateNames(
    platforms.map((platform) => platform.name),
  );
  if (duplicatePlatformNames.length > 0) {
    throw new ConfigError(
      `platforms[].name 重复：${duplicatePlatformNames.join(', ')}`,
    );
  }
  assertUniquePlatformStatePaths(platforms);
  const platformsByName = new Map(
    platforms.map((platform) => [platform.name, platform]),
  );

  const bindings = bindingsRaw.map((binding, index) =>
    parseBinding(binding, index, platformsByName),
  );
  const duplicateBindingNames = duplicateNames(
    bindings.map((binding) => binding.name),
  );
  if (duplicateBindingNames.length > 0) {
    throw new ConfigError(
      `bindings[].name 重复：${duplicateBindingNames.join(', ')}`,
    );
  }
  assertAgentReferences(bindings, agents);

  let ui: DaemonConfig;
  let daemon: DaemonRuntimeConfig;
  try {
    ui = parseDaemonConfig(parsed['ui']);
    daemon = parseDaemonRuntimeConfig(parsed['daemon']);
  } catch (err) {
    if (err instanceof DaemonConfigError) {
      throw new ConfigError(`${path} ${err.message}`);
    }
    throw err;
  }

  if (templateDefaultsChanged) {
    try {
      await persistConfig(path, parsed);
    } catch {
      // Parsed defaults are already applied in memory; a read-only config file
      // must not make an otherwise valid legacy config fail to start.
    }
  }

  return {
    platforms,
    agents,
    bindings,
    daemon,
    ui,
    log: parseLog(parsed['log']),
  };
}

export function buildRoutingTable(config: AgentNexusConfig): RoutingEntry[] {
  const platformsByName = new Map(
    config.platforms.map((platform) => [platform.name, platform]),
  );
  return config.bindings.map((binding) => {
    const platform = platformsByName.get(binding.platformName);
    if (!platform) {
      throw new ConfigError(
        `binding "${binding.name}" 引用了不存在的 platform "${binding.platformName}"`,
      );
    }
    return {
      bindingName: binding.name,
      platformName: binding.platformName,
      platformType: platform.type,
      agentName: binding.agentName,
      match: binding.match,
    };
  });
}

function assertValidSecretName(name: string): void {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) {
    throw new SecretsPermissionError(`secret ref "${name}" 不是合法名称`);
  }
}

export async function loadSecret(name: string): Promise<string> {
  assertValidSecretName(name);
  let scaffold;
  try {
    scaffold = await ensureConfigScaffold();
  } catch (err) {
    throw new SecretsPermissionError(`初始化 secrets 文件失败：${(err as Error).message}`);
  }
  if (scaffold.tokenCreated && name === 'DISCORD_BOT_TOKEN') {
    throw new SecretsPermissionError(TOKEN_HINT(secretPath(name)));
  }

  const path = secretPath(name);
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SecretsPermissionError(TOKEN_HINT(path));
    }
    throw new SecretsPermissionError(`读取 ${path} 失败：${(err as Error).message}`);
  }

  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new SecretsPermissionError(
      `${path} 权限必须 0600（当前 0${mode.toString(8)}）。\n  chmod 600 ${path}`,
    );
  }

  const token = (await readFile(path, 'utf8')).trim();
  if (token.length === 0) {
    throw new SecretsPermissionError(`${path} 为空`);
  }
  return token;
}

export async function loadDiscordToken(): Promise<string> {
  return loadSecret('DISCORD_BOT_TOKEN');
}
