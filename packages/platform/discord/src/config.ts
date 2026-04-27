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

export class DiscordConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordConfigError';
  }
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
