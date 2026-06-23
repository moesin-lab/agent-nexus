import { randomUUID } from 'node:crypto';
import type { SessionKey } from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';

/**
 * 跨 turn 维护 SessionKey → agentSessionId 的最小内存映射。
 *
 * 列表、绑定、next workingDir 相关方法是 daemon-owned session/thread
 * command 接线的 store 层契约；业务路由保持在 Engine / command handler。
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
  agentSessionId: string;
}

export interface ExternalResumeSessionEntry {
  agentSessionId: string;
  lastTurnAt: Date;
  title?: string;
}

export interface ListSessionsInput {
  platformName: string;
  platform: string;
  initiatorUserId: string;
  limit: number;
}

export interface FindThreadInput {
  platformName: string;
  platform: string;
  channelId: string;
}

export class SessionStore {
  private readonly map = new Map<string, SessionEntry>();
  private readonly sessionIdsByKey = new Map<string, string>();
  private readonly keysBySessionId = new Map<string, SessionKey>();
  private readonly trajectorySequencesBySessionId = new Map<string, number>();
  private readonly threadsByChannel = new Map<string, ThreadRegistryEntry>();
  private readonly workingDirsByChannel = new Map<string, string>();

  get(key: SessionKey): SessionEntry | undefined {
    return this.map.get(serializeSessionKey(key));
  }

  ensureSessionId(key: SessionKey): string {
    const keyStr = serializeSessionKey(key);
    let sessionId = this.sessionIdsByKey.get(keyStr);
    if (!sessionId) {
      sessionId = randomUUID();
      this.sessionIdsByKey.set(keyStr, sessionId);
      this.keysBySessionId.set(sessionId, { ...key });
    }
    return sessionId;
  }

  set(key: SessionKey, entry: SessionEntry): void {
    const keyStr = serializeSessionKey(key);
    this.ensureSessionId(key);
    const existing = this.map.get(keyStr);
    const nextEntry: SessionEntry = { ...entry };
    // set() 只保留/更新 resumable 绑定；显式清除必须走 delete()。
    if (
      nextEntry.agentSessionId === undefined &&
      existing?.agentSessionId !== undefined
    ) {
      nextEntry.agentSessionId = existing.agentSessionId;
    }
    if (nextEntry.title === undefined && existing?.title !== undefined) {
      nextEntry.title = existing.title;
    }
    if (
      nextEntry.nextSession === undefined &&
      existing?.nextSession !== undefined
    ) {
      nextEntry.nextSession = existing.nextSession;
    }
    this.map.set(keyStr, nextEntry);
  }

  nextTrajectorySequence(sessionId: string): number {
    const next = (this.trajectorySequencesBySessionId.get(sessionId) ?? 0) + 1;
    this.trajectorySequencesBySessionId.set(sessionId, next);
    return next;
  }

  delete(key: SessionKey): boolean {
    const keyStr = serializeSessionKey(key);
    const sessionId = this.sessionIdsByKey.get(keyStr);
    if (sessionId) {
      this.sessionIdsByKey.delete(keyStr);
      this.keysBySessionId.delete(sessionId);
      this.trajectorySequencesBySessionId.delete(sessionId);
    }
    return this.map.delete(keyStr);
  }

  clearAll(): void {
    this.map.clear();
    this.sessionIdsByKey.clear();
    this.keysBySessionId.clear();
    this.trajectorySequencesBySessionId.clear();
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
        agentSessionId: entry.agentSessionId,
        lastTurnAt: entry.lastTurnAt,
        title: entry.title,
        nextSession: entry.nextSession ? { ...entry.nextSession } : undefined,
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
    const sourceKeyStr = serializeSessionKey(sourceKey);
    const targetKeyStr = serializeSessionKey(targetKey);
    const source = this.map.get(sourceKeyStr);
    if (!source?.agentSessionId) return undefined;
    const rebound = {
      agentSessionId: source.agentSessionId,
      lastTurnAt: now,
      title: source.title,
      nextSession: source.nextSession,
    };
    if (sourceKeyStr !== targetKeyStr) {
      this.delete(targetKey);
    }
    this.set(targetKey, rebound);
    const stored = this.get(targetKey);
    if (sourceKeyStr !== targetKeyStr) {
      this.delete(sourceKey);
    }
    return stored ? cloneEntry(stored) : undefined;
  }

  bindExternalResumeToKey(
    targetKey: SessionKey,
    entry: ExternalResumeSessionEntry,
  ): SessionEntry {
    this.set(targetKey, entry);
    return cloneEntry(this.get(targetKey)!);
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
  return `${input.platformName}:${input.platform}:${input.channelId}`;
}

function cloneEntry(entry: SessionEntry): SessionEntry {
  const cloned = { ...entry };
  if (entry.nextSession) cloned.nextSession = { ...entry.nextSession };
  return cloned;
}
