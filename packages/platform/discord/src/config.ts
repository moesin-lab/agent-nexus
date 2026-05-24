export interface DiscordConfig {
  botUserId: string;
  /**
   * 用户白名单——同时控制 inbound chat 与 /reply-mode slash command。
   * fail-closed：缺字段 / 空数组都 throw；不允许"漏配 = 放行所有"。
   * 见 spec/platform-adapter.md §"用户白名单"。
   */
  allowedUserIds: string[];
  /** reply-mode 持久化文件路径。 */
  statePath: string;
  /**
   * 可选：把 slash command 限定注册到该 guild（dev / 测试瞬时生效）。
   * 缺省 → 全局注册（生产形态，最长 1 小时缓存延迟）。
   * 见 spec/platform-adapter.md §"注册作用域"。
   */
  testGuildId?: string;
}

export type DiscordPublicChannelMode = 'disabled' | 'thread' | 'public';

export interface DiscordBindingMatchConfig {
  channelIds: string[];
}

export interface DiscordPlatformConfig {
  name: string;
  type: 'discord';
  botUserId: string;
  tokenRef: string;
  statePath: string;
  testGuildId?: string;
  publicChannelMode: DiscordPublicChannelMode;
}

export class DiscordConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordConfigError';
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
      throw new DiscordConfigError(`未知字段 ${path}.${key}`);
    }
  }
}

function requireString(raw: Record<string, unknown>, key: string, path: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new DiscordConfigError(`缺字段 ${path}.${key}（非空字符串）`);
  }
  return value;
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new DiscordConfigError(`字段 ${path}.${key} 必须是非空字符串`);
  }
  return value;
}

function assertValidSecretRef(value: string, path: string): void {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)) {
    throw new DiscordConfigError(`字段 ${path} 必须是 secret ref 名称，不能包含路径分隔符`);
  }
}

export function parseDiscordBindingMatchConfig(
  raw: unknown,
  ctx: { path: string },
): DiscordBindingMatchConfig {
  const path = ctx.path;
  if (!isRecord(raw)) {
    throw new DiscordConfigError(`字段 ${path} 必须是对象`);
  }
  assertNoUnknownKeys(raw, ['channelIds'], path);

  const channelIdsRaw = raw['channelIds'];
  if (!Array.isArray(channelIdsRaw)) {
    throw new DiscordConfigError(`字段 ${path}.channelIds 必须是非空字符串数组`);
  }
  if (channelIdsRaw.length === 0) {
    throw new DiscordConfigError(`字段 ${path}.channelIds 不能是空数组`);
  }
  for (const channelId of channelIdsRaw) {
    if (typeof channelId !== 'string' || channelId.length === 0) {
      throw new DiscordConfigError(`字段 ${path}.channelIds 必须是非空字符串数组`);
    }
  }

  return { channelIds: [...channelIdsRaw] };
}

export function parseDiscordPlatformConfig(
  raw: unknown,
  ctx: { path: string; defaultStatePath: string },
): DiscordPlatformConfig {
  if (!isRecord(raw)) {
    throw new DiscordConfigError(`字段 ${ctx.path} 必须是对象`);
  }
  assertNoUnknownKeys(
    raw,
    [
      'name',
      'type',
      'botUserId',
      'tokenRef',
      'auth',
      'statePath',
      'testGuildId',
      'publicChannelMode',
    ],
    ctx.path,
  );

  const name = requireString(raw, 'name', ctx.path);
  const type = requireString(raw, 'type', ctx.path);
  if (type !== 'discord') {
    throw new DiscordConfigError(`字段 ${ctx.path}.type 必须是 "discord"`);
  }
  const botUserId = requireString(raw, 'botUserId', ctx.path);
  const tokenRef = requireString(raw, 'tokenRef', ctx.path);
  assertValidSecretRef(tokenRef, `${ctx.path}.tokenRef`);

  const statePath = optionalString(raw, 'statePath', ctx.path) ?? ctx.defaultStatePath;
  const testGuildId = optionalString(raw, 'testGuildId', ctx.path);
  const publicChannelModeRaw = raw['publicChannelMode'];
  if (
    publicChannelModeRaw !== undefined &&
    !['disabled', 'thread', 'public'].includes(
      publicChannelModeRaw as DiscordPublicChannelMode,
    )
  ) {
    throw new DiscordConfigError(
      `字段 ${ctx.path}.publicChannelMode 必须是 "disabled" / "thread" / "public"`,
    );
  }
  const publicChannelMode =
    (publicChannelModeRaw as DiscordPublicChannelMode | undefined) ?? 'thread';

  return {
    name,
    type: 'discord',
    botUserId,
    tokenRef,
    statePath,
    ...(testGuildId === undefined ? {} : { testGuildId }),
    publicChannelMode,
  };
}

export function parseDiscordConfig(
  raw: unknown,
  ctx: { defaultStatePath: string },
): DiscordConfig {
  const discord = (raw as Record<string, unknown> | undefined) ?? {};

  const botUserId = discord['botUserId'];
  if (typeof botUserId !== 'string' || botUserId.length === 0) {
    throw new DiscordConfigError('缺字段 discord.botUserId（非空字符串）');
  }

  // allowedUserIds 必填且不允许空数组——fail-closed 安全默认
  const allowedUserIdsRaw = discord['allowedUserIds'];
  if (allowedUserIdsRaw === undefined) {
    throw new DiscordConfigError(
      '缺字段 discord.allowedUserIds（必填，非空字符串数组）。\n' +
        '该列表同时控制谁能跟 bot 聊天与谁能用 /reply-mode；空 / 缺省 = 拒绝所有。\n' +
        '填上你自己的 Discord User ID 即可：{ "discord": { ..., "allowedUserIds": ["<your-id>"] } }',
    );
  }
  if (!Array.isArray(allowedUserIdsRaw)) {
    throw new DiscordConfigError('字段 discord.allowedUserIds 必须是字符串数组');
  }
  if (allowedUserIdsRaw.length === 0) {
    throw new DiscordConfigError(
      '字段 discord.allowedUserIds 不能是空数组——空数组 = 没人能用 bot。\n' +
        '至少加一个 user id，否则 bot 启动了也没法响应任何人。',
    );
  }
  for (const v of allowedUserIdsRaw) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new DiscordConfigError('字段 discord.allowedUserIds 必须是非空字符串数组');
    }
  }
  const allowedUserIds: string[] = [...allowedUserIdsRaw];

  const statePathRaw = discord['statePath'];
  if (statePathRaw !== undefined && (typeof statePathRaw !== 'string' || statePathRaw.length === 0)) {
    throw new DiscordConfigError('字段 discord.statePath 必须是非空字符串');
  }
  const statePath = typeof statePathRaw === 'string' ? statePathRaw : ctx.defaultStatePath;

  const testGuildIdRaw = discord['testGuildId'];
  if (testGuildIdRaw !== undefined && (typeof testGuildIdRaw !== 'string' || testGuildIdRaw.length === 0)) {
    throw new DiscordConfigError('字段 discord.testGuildId 必须是非空字符串');
  }
  const testGuildId = typeof testGuildIdRaw === 'string' ? testGuildIdRaw : undefined;

  return { botUserId, allowedUserIds, statePath, testGuildId };
}
