import type { SessionKey } from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';

/**
 * 跨 turn 维护 SessionKey → ccSessionID 的最小内存映射。
 *
 * MVP 仅在进程内存活；进程重启即清空。持久化、状态机、TTL、并发竞态
 * 处理留给后续 PR——TODO docs/dev/architecture/session-model.md。
 */
export interface SessionEntry {
  ccSessionID: string;
  lastTurnAt: Date;
}

export class SessionStore {
  private readonly map = new Map<string, SessionEntry>();

  get(key: SessionKey): SessionEntry | undefined {
    return this.map.get(serializeSessionKey(key));
  }

  set(key: SessionKey, entry: SessionEntry): void {
    this.map.set(serializeSessionKey(key), entry);
  }

  delete(key: SessionKey): boolean {
    return this.map.delete(serializeSessionKey(key));
  }

  clearAll(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
