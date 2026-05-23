import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  parseDiscordConfig,
  type DiscordConfig,
  DiscordConfigError,
} from '@agent-nexus/platform-discord';
import {
  parseClaudeCodeConfig,
  type ClaudeCodeConfig,
  ClaudeCodeConfigError,
} from '@agent-nexus/agent-claudecode';
import {
  parseDaemonConfig,
  type DaemonConfig,
  DaemonConfigError,
} from '@agent-nexus/daemon';

export type { DiscordConfig, ClaudeCodeConfig };

export interface AgentNexusConfig {
  discord: DiscordConfig;
  claudeCode: ClaudeCodeConfig;
  ui: DaemonConfig;
  log: {
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
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

export function configRoot(): string {
  return join(homedir(), '.agent-nexus');
}

export function configPath(): string {
  return join(configRoot(), 'config.json');
}

export function discordTokenPath(): string {
  return join(configRoot(), 'secrets', 'DISCORD_BOT_TOKEN');
}

export function defaultDiscordStatePath(): string {
  return join(configRoot(), 'state', 'discord.json');
}

const CONFIG_HINT = (path: string) => `\
agent-nexus 配置模板已创建：${path}
请编辑其中的 botUserId、allowedUserIds 和 workingDir，然后确认权限：
  chmod 600 ${path}
`;

const TOKEN_HINT = (path: string) => `\
DISCORD_BOT_TOKEN 文件已创建：${path}
请写入 token（权限必须 0600）：
  echo -n '<your-token>' > ${path}
  chmod 600 ${path}
`;

const DEFAULT_CONFIG_TEMPLATE = `\
{
  "discord": {
    "botUserId": "",
    "allowedUserIds": []
  },
  "claudeCode": {
    "workingDir": "",
    "bin": "claude",
    "_permissionLevelComment": "allowed: default, acceptEdits, auto, bypassPermissions, dontAsk, plan",
    "permissionLevel": "default",
    "allowedTools": ["Read", "Grep", "Glob", "Edit", "Write"]
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

function cloneJsonObject(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function applyMissingFields(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): boolean {
  let changed = false;
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!(key in target)) {
      target[key] = cloneJsonObject(defaultValue);
      changed = true;
      continue;
    }
    if (isRecord(target[key]) && isRecord(defaultValue)) {
      changed = applyMissingFields(target[key], defaultValue) || changed;
    }
  }
  return changed;
}

async function writeNormalizedConfigIfNeeded(
  path: string,
  obj: Record<string, unknown>,
): Promise<void> {
  const defaults = JSON.parse(DEFAULT_CONFIG_TEMPLATE) as Record<string, unknown>;
  if (!applyMissingFields(obj, defaults)) return;
  await writeFile(path, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function ensureConfigDirs(): Promise<void> {
  const root = configRoot();
  const secrets = join(root, 'secrets');
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(secrets, 0o700);
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

  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigError(`${path} 顶层必须是对象`);
  }
  const obj = parsed as Record<string, unknown>;
  try {
    await writeNormalizedConfigIfNeeded(path, obj);
  } catch (err) {
    throw new ConfigError(`补齐 ${path} 缺失字段失败：${(err as Error).message}`);
  }

  let discord: DiscordConfig;
  try {
    discord = parseDiscordConfig(obj['discord'], {
      defaultStatePath: defaultDiscordStatePath(),
    });
  } catch (err) {
    if (err instanceof DiscordConfigError) {
      throw new ConfigError(`${path} ${err.message}`);
    }
    throw err;
  }

  let claudeCode: ClaudeCodeConfig;
  try {
    claudeCode = parseClaudeCodeConfig(obj['claudeCode']);
  } catch (err) {
    if (err instanceof ClaudeCodeConfigError) {
      throw new ConfigError(`${path} ${err.message}`);
    }
    throw err;
  }

  let ui: DaemonConfig;
  try {
    ui = parseDaemonConfig(obj['ui']);
  } catch (err) {
    if (err instanceof DaemonConfigError) {
      throw new ConfigError(`${path} ${err.message}`);
    }
    throw err;
  }

  const log = (obj['log'] as Record<string, unknown> | undefined) ?? {};
  const levelRaw = log['level'];
  const level: AgentNexusConfig['log']['level'] =
    typeof levelRaw === 'string' &&
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(levelRaw)
      ? (levelRaw as AgentNexusConfig['log']['level'])
      : DEFAULT_LOG_LEVEL;

  return {
    discord,
    claudeCode,
    ui,
    log: { level },
  };
}

export async function loadDiscordToken(): Promise<string> {
  let scaffold;
  try {
    scaffold = await ensureConfigScaffold();
  } catch (err) {
    throw new SecretsPermissionError(`初始化 secrets 文件失败：${(err as Error).message}`);
  }
  if (scaffold.tokenCreated) {
    throw new SecretsPermissionError(TOKEN_HINT(discordTokenPath()));
  }

  const path = discordTokenPath();
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

  const raw = await readFile(path, 'utf8');
  const token = raw.trim();
  if (token.length === 0) {
    throw new SecretsPermissionError(`${path} 为空`);
  }
  return token;
}
