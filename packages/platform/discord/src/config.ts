export interface DiscordConfig {
  botUserId: string;
  /** 允许执行 /reply-mode slash command 的 user id 列表；空 = 没人能切。 */
  ownerUserIds: string[];
  /** reply-mode 持久化文件路径。 */
  statePath: string;
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

  const ownerUserIdsRaw = discord['ownerUserIds'];
  let ownerUserIds: string[] = [];
  if (ownerUserIdsRaw !== undefined) {
    if (!Array.isArray(ownerUserIdsRaw)) {
      throw new DiscordConfigError('字段 discord.ownerUserIds 必须是字符串数组');
    }
    for (const v of ownerUserIdsRaw) {
      if (typeof v !== 'string' || v.length === 0) {
        throw new DiscordConfigError('字段 discord.ownerUserIds 必须是非空字符串数组');
      }
    }
    ownerUserIds = [...ownerUserIdsRaw];
  }

  const statePathRaw = discord['statePath'];
  if (statePathRaw !== undefined && (typeof statePathRaw !== 'string' || statePathRaw.length === 0)) {
    throw new DiscordConfigError('字段 discord.statePath 必须是非空字符串');
  }
  const statePath = (statePathRaw as string | undefined) ?? ctx.defaultStatePath;

  return { botUserId, ownerUserIds, statePath };
}
