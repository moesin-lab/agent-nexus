/**
 * Platform adapter 产出的会话容器 key。
 *
 * Adapter 不知道配置里的 platform instance name；daemon routing 层会在
 * dispatch 时用 withPlatformName 升级为 SessionKey。
 */
export interface PlatformSessionKey {
  platform: string;
  channelId: string;
  initiatorUserId: string;
}

/**
 * daemon/agent 侧使用的完整会话路由 key。
 * 字段定义对齐 docs/dev/spec/message-protocol.md §SessionKey。
 */
export interface SessionKey extends PlatformSessionKey {
  platformName: string;
}

export function withPlatformName(
  key: PlatformSessionKey,
  platformName: string,
): SessionKey {
  return {
    platformName,
    platform: key.platform,
    channelId: key.channelId,
    initiatorUserId: key.initiatorUserId,
  };
}

/**
 * `<platformName>:<platform>:<channelId>:<initiatorUserId>` — 序列化形式
 * （日志、持久化、Map key）。
 */
export function serializeSessionKey(key: SessionKey): string {
  return `${key.platformName}:${key.platform}:${key.channelId}:${key.initiatorUserId}`;
}

/** Adapter 层日志专用；不得用于 daemon session/idempotency 存储 key。 */
export function serializePlatformSessionKey(key: PlatformSessionKey): string {
  return `${key.platform}:${key.channelId}:${key.initiatorUserId}`;
}
