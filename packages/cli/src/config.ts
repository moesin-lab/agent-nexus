import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  parseDiscordPlatformConfig,
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
  parseDaemonConfig,
  parsePlatformAuthConfig,
  type DaemonConfig,
  type PlatformAuthConfig,
  DaemonConfigError,
} from '@agent-nexus/daemon';

export type {
  ClaudeCodeConfig,
  CodexConfig,
  DiscordPlatformConfig,
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
  ui: DaemonConfig;
  log: {
    level: LogLevel;
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

export function configRoot(): string {
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
请编辑其中的 platforms[].botUserId、platforms[].auth.allowlist、platforms[].bindings[].channelIds 和 agents[].workingDir，然后确认权限：
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
      },
      "bindings": [
        {
          "agentName": "codex-dev",
          "channelIds": []
        }
      ]
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
      '请迁移为 platforms[] / agents[]：platforms[].name/type/auth/bindings/tokenRef，' +
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

function assertSinglePlatformTypeUntilP10(platforms: PlatformConfig[]): void {
  const seen = new Set<string>();
  for (const platform of platforms) {
    if (seen.has(platform.type)) {
      throw new ConfigError(
        'platforms[].type 暂不允许配置多个同 type platform；' +
          'P10 完成 platformName session 隔离后再放开。',
      );
    }
    seen.add(platform.type);
  }
}

function assertBindingReferences(
  platforms: PlatformConfig[],
  agents: AgentConfig[],
): void {
  const agentNames = new Set(agents.map((agent) => agent.name));
  for (const [platformIndex, platform] of platforms.entries()) {
    for (const [bindingIndex, binding] of platform.bindings.entries()) {
      if (!agentNames.has(binding.agentName)) {
        throw new ConfigError(
          `字段 platforms[${platformIndex}].bindings[${bindingIndex}].agentName ` +
            `引用了不存在的 agent "${binding.agentName}"`,
        );
      }
    }
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
  assertNoUnknownKeys(parsed, ['platforms', 'agents', 'log', 'ui'], path);

  const platformsRaw = assertArray(parsed, 'platforms', path);
  const agentsRaw = assertArray(parsed, 'agents', path);

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
  assertSinglePlatformTypeUntilP10(platforms);
  assertBindingReferences(platforms, agents);

  let ui: DaemonConfig;
  try {
    ui = parseDaemonConfig(parsed['ui']);
  } catch (err) {
    if (err instanceof DaemonConfigError) {
      throw new ConfigError(`${path} ${err.message}`);
    }
    throw err;
  }

  return {
    platforms,
    agents,
    ui,
    log: parseLog(parsed['log']),
  };
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
