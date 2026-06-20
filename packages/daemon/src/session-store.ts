import type { SessionKey } from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';

/**
 * 跨 turn 维护 SessionKey → agentSessionId 的最小内存映射。
 *
 * MVP 仅在进程内存活；进程重启即清空。持久化、状态机、TTL、并发竞态
 * 处理留给后续 PR——TODO docs/dev/architecture/session-model.md。
 */
export interface SessionEntry {
  agentSessionId?: string;
  lastTurnAt: Date;
  title?: string;
  nextSession?: {
    workingDir?: string;
  };
}

export interface ThreadRegistryEntry {
  parentChannelId: string;
  ownerUserId: string;
  autoArchiveDurationMinutes: 60 | 1440 | 4320 | 10080;
  renameOnFirstPrompt?: boolean;
}

export interface ListedSessionEntry extends Omit<SessionEntry, 'agentSessionId'> {
  sessionId: string;
  key: SessionKey;
  platformName?: string;
  platform: string;
  channelId: string;
  initiatorUserId: string;
  agentSessionId: string;
}

export interface ListSessionsInput {
  platformName?: string;
  platform: string;
  initiatorUserId: string;
  limit: number;
}

export interface FindThreadInput {
  platformName?: string;
  platform: string;
  channelId: string;
}

export class SessionStore {
  private readonly map = new Map<string, SessionEntry>();
  private readonly sessionIdsByKey = new Map<string, string>();
  private readonly keysBySessionId = new Map<string, SessionKey>();
  private readonly threadsByChannel = new Map<string, ThreadRegistryEntry>();
  private readonly workingDirsByChannel = new Map<string, string>();
  private nextSessionSeq = 1;

  get(key: SessionKey): SessionEntry | undefined {
    return this.map.get(serializeSessionKey(key));
  }

  set(key: SessionKey, entry: SessionEntry): void {
    const keyStr = serializeSessionKey(key);
    if (!this.sessionIdsByKey.has(keyStr)) {
      const sessionId = `mem-${this.nextSessionSeq}`;
      this.nextSessionSeq += 1;
      this.sessionIdsByKey.set(keyStr, sessionId);
      this.keysBySessionId.set(sessionId, { ...key });
    }
    const existing = this.map.get(keyStr);
    this.map.set(keyStr, {
      ...entry,
      title: entry.title ?? existing?.title,
      nextSession: entry.nextSession ?? existing?.nextSession,
    });
  }

  delete(key: SessionKey): boolean {
    const keyStr = serializeSessionKey(key);
    const sessionId = this.sessionIdsByKey.get(keyStr);
    if (sessionId) {
      this.sessionIdsByKey.delete(keyStr);
      this.keysBySessionId.delete(sessionId);
    }
    return this.map.delete(keyStr);
  }

  clearAll(): void {
    this.map.clear();
    this.sessionIdsByKey.clear();
    this.keysBySessionId.clear();
    this.threadsByChannel.clear();
    this.workingDirsByChannel.clear();
  }

  get size(): number {
    return this.map.size;
  }

  listForUser(input: ListSessionsInput): ListedSessionEntry[] {
    const entries: ListedSessionEntry[] = [];
    for (const [keyStr, entry] of this.map.entries()) {
      if (!entry.agentSessionId) continue;
      const sessionId = this.sessionIdsByKey.get(keyStr);
      const key = sessionId ? this.keysBySessionId.get(sessionId) : undefined;
      if (!sessionId || !key) continue;
      if (key.platformName !== input.platformName) continue;
      if (key.platform !== input.platform) continue;
      if (key.initiatorUserId !== input.initiatorUserId) continue;
      entries.push({
        sessionId,
        key: { ...key },
        platformName: key.platformName,
        platform: key.platform,
        channelId: key.channelId,
        initiatorUserId: key.initiatorUserId,
        agentSessionId: entry.agentSessionId,
        lastTurnAt: entry.lastTurnAt,
        title: entry.title,
        nextSession: entry.nextSession,
      });
    }
    return entries
      .sort((a, b) => b.lastTurnAt.getTime() - a.lastTurnAt.getTime())
      .slice(0, input.limit);
  }

  bindExistingToKey(
    targetKey: SessionKey,
    sessionId: string,
    now: Date,
  ): SessionEntry | undefined {
    const sourceKey = this.keysBySessionId.get(sessionId);
    if (!sourceKey) return undefined;
    const source = this.map.get(serializeSessionKey(sourceKey));
    if (!source?.agentSessionId) return undefined;
    const rebound = {
      agentSessionId: source.agentSessionId,
      lastTurnAt: now,
      title: source.title,
    };
    this.set(targetKey, rebound);
    return rebound;
  }

  findThreadByChannelId(input: FindThreadInput): ThreadRegistryEntry | undefined {
    const thread = this.threadsByChannel.get(threadRegistryKey(input));
    return thread ? { ...thread } : undefined;
  }

  setNextWorkingDir(key: SessionKey, workingDir: string, now: Date): void {
    const existing = this.get(key);
    this.set(key, {
      ...(existing ?? {}),
      lastTurnAt: existing?.lastTurnAt ?? now,
      nextSession: { workingDir },
    });
  }

  consumeNextWorkingDir(key: SessionKey): string | undefined {
    const keyStr = serializeSessionKey(key);
    const existing = this.map.get(keyStr);
    const workingDir = existing?.nextSession?.workingDir;
    if (!existing?.nextSession) return undefined;
    const { nextSession: _nextSession, ...rest } = existing;
    this.map.set(keyStr, rest);
    return workingDir;
  }

  registerThread(key: SessionKey, thread: ThreadRegistryEntry): void {
    this.threadsByChannel.set(
      threadRegistryKey({
        platformName: key.platformName,
        platform: key.platform,
        channelId: key.channelId,
      }),
      { ...thread },
    );
  }

  setChannelWorkingDir(
    input: FindThreadInput,
    workingDir: string,
  ): void {
    this.workingDirsByChannel.set(threadRegistryKey(input), workingDir);
  }

  getChannelWorkingDir(input: FindThreadInput): string | undefined {
    return this.workingDirsByChannel.get(threadRegistryKey(input));
  }
}

function threadRegistryKey(input: FindThreadInput): string {
  return `${input.platformName ?? ''}:${input.platform}:${input.channelId}`;
}
