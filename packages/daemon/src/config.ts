export const TOOL_MESSAGE_MODES = ['append', 'compact'] as const;
export type ToolMessageMode = (typeof TOOL_MESSAGE_MODES)[number];

export interface DaemonConfig {
  toolMessages: ToolMessageMode;
}

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
