import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentNexusConfig {
  discord: {
    botUserId: string;
    /** 允许执行 /reply-mode slash command 的 user id 列表；空 = 没人能切。 */
    ownerUserIds: string[];
    /** reply-mode 持久化文件路径；默认 ~/.agent-nexus/state/discord.json。 */
    statePath: string;
  };
  claudeCode: {
    bin: string;
    workingDir: string;
    allowedTools: string[];
  };
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

// spec/security/tool-boundary.md：默认集 Read/Grep/Glob/Edit/Write；Bash 必须显式启用
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write'];
const DEFAULT_BIN = 'claude';
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
agent-nexus 配置缺失：${path}
请创建：
  mkdir -p ${join(configRoot(), 'secrets')}
  chmod 700 ${configRoot()} ${join(configRoot(), 'secrets')}
  cat > ${path} <<'JSON'
  {
    "discord": { "botUserId": "<your-bot-user-id>" },
    "claudeCode": { "workingDir": "/path/to/working/dir" }
  }
  JSON
  chmod 600 ${path}
`;

const TOKEN_HINT = (path: string) => `\
DISCORD_BOT_TOKEN 缺失或权限不对：${path}
请创建（权限必须 0600）：
  echo -n '<your-token>' > ${path}
  chmod 600 ${path}
`;

export async function loadConfig(): Promise<AgentNexusConfig> {
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

  const discord = obj['discord'] as Record<string, unknown> | undefined;
  const botUserId = discord?.['botUserId'];
  if (typeof botUserId !== 'string' || botUserId.length === 0) {
    throw new ConfigError(`${path} 缺字段 discord.botUserId（非空字符串）`);
  }

  const ownerUserIdsRaw = discord?.['ownerUserIds'];
  let ownerUserIds: string[] = [];
  if (ownerUserIdsRaw !== undefined) {
    if (!Array.isArray(ownerUserIdsRaw)) {
      throw new ConfigError(`${path} 字段 discord.ownerUserIds 必须是字符串数组`);
    }
    for (const v of ownerUserIdsRaw) {
      if (typeof v !== 'string' || v.length === 0) {
        throw new ConfigError(`${path} 字段 discord.ownerUserIds 必须是非空字符串数组`);
      }
    }
    ownerUserIds = [...ownerUserIdsRaw];
  }

  const statePathRaw = discord?.['statePath'];
  if (statePathRaw !== undefined && (typeof statePathRaw !== 'string' || statePathRaw.length === 0)) {
    throw new ConfigError(`${path} 字段 discord.statePath 必须是非空字符串`);
  }
  const statePath = (statePathRaw as string | undefined) ?? defaultDiscordStatePath();

  const cc = (obj['claudeCode'] as Record<string, unknown> | undefined) ?? {};
  const workingDir = cc['workingDir'];
  if (typeof workingDir !== 'string' || workingDir.length === 0) {
    throw new ConfigError(`${path} 缺字段 claudeCode.workingDir（非空字符串）`);
  }

  const bin = typeof cc['bin'] === 'string' ? (cc['bin'] as string) : DEFAULT_BIN;
  const allowedToolsRaw = cc['allowedTools'];
  const allowedTools = Array.isArray(allowedToolsRaw)
    ? allowedToolsRaw.filter((s): s is string => typeof s === 'string')
    : DEFAULT_ALLOWED_TOOLS;

  const log = (obj['log'] as Record<string, unknown> | undefined) ?? {};
  const levelRaw = log['level'];
  const level: AgentNexusConfig['log']['level'] =
    typeof levelRaw === 'string' &&
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(levelRaw)
      ? (levelRaw as AgentNexusConfig['log']['level'])
      : DEFAULT_LOG_LEVEL;

  return {
    discord: { botUserId, ownerUserIds, statePath },
    claudeCode: { bin, workingDir, allowedTools },
    log: { level },
  };
}

export async function loadDiscordToken(): Promise<string> {
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
