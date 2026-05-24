import type { NormalizedEvent } from '@agent-nexus/protocol';
import type { PlatformAuthConfig } from './config.js';

export type AuthDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'user_not_allowed'
        | 'channel_not_allowed'
        | 'guild_not_allowed'
        | 'dm_not_allowed';
    };

export function checkPlatformAuth(
  auth: PlatformAuthConfig,
  event: NormalizedEvent,
): AuthDecision {
  const { allowlist } = auth;
  if (!event.guildId && !allowlist.allowDM) {
    return { allowed: false, reason: 'dm_not_allowed' };
  }
  if (!event.guildId && allowlist.userIds.length === 0) {
    return { allowed: false, reason: 'user_not_allowed' };
  }
  if (
    event.guildId &&
    allowlist.allowedGuildIds.length > 0 &&
    !allowlist.allowedGuildIds.includes(event.guildId)
  ) {
    return { allowed: false, reason: 'guild_not_allowed' };
  }

  const userId = event.initiator.userId;
  const allowedByUserId = allowlist.userIds.includes(userId);
  const eventRoleIds = event.initiatorRoleIds ?? [];
  const allowedByRoleId = eventRoleIds.some((roleId) =>
    allowlist.roleIds.includes(roleId),
  );
  if (
    (allowlist.userIds.length > 0 || allowlist.roleIds.length > 0) &&
    !allowedByUserId &&
    !allowedByRoleId
  ) {
    return { allowed: false, reason: 'user_not_allowed' };
  }

  const channelId = event.sessionKey.channelId;
  if (
    allowlist.allowedChannelIds.length > 0 &&
    !allowlist.allowedChannelIds.includes(channelId)
  ) {
    return { allowed: false, reason: 'channel_not_allowed' };
  }

  return { allowed: true };
}
