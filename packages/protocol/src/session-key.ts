/**
 * 入站事件归一化的会话路由 key。
 * 字段定义对齐 docs/dev/spec/message-protocol.md §SessionKey。
 */
export interface SessionKey {
  platform: string;
  channelId: string;
  initiatorUserId: string;
}

/** `<platform>:<channelId>:<initiatorUserId>` —— 序列化形式（日志、持久化、Map key） */
export function serializeSessionKey(key: SessionKey): string {
  return `${key.platform}:${key.channelId}:${key.initiatorUserId}`;
}
