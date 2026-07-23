import { randomUUID } from 'node:crypto';
import type { SessionKey } from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';

/**
 * 跨 turn 维护 SessionKey → 当前 agentSessionId，并保留可恢复历史的最小内存映射。
 *
 * 列表、绑定、next workingDir 相关方法是 daemon-owned session/thread
 * command 接线的 store 层契约；业务路由保持在 Engine / command handler。
 *
 * MVP 仅在进程内存活；进程重启即清空。持久化、状态机、TTL、并发竞态
 * 处理留给后续 PR——TODO docs/dev/architecture/session-model.md。
 */
export interface SessionEntry {
  agentSessionId?: string;
  agentOwner?: string;
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
  agentOwner?: string;
  lastTurnAt: Date;
  title?: string;
}

export interface ListSessionsInput {
  platformName: string;
  platform: string;
  initiatorUserId: string;
  agentOwner?: string;
  limit: number;
}

export interface FindThreadInput {
  platformName: string;
  platform: string;
  channelId: string;
}

interface StoredSessionRecord {
  key: SessionKey;
  entry: SessionEntry;
}

export interface SessionStoreOptions {
  maxEntries?: number;
}

const DEFAULT_MAX_SESSION_ENTRIES = 100;

export class SessionStore {
  private readonly map = new Map<string, SessionEntry>();
  private readonly sessionIdsByKey = new Map<string, string>();
  private readonly keysBySessionId = new Map<string, SessionKey>();
  private readonly sessionsBySessionId = new Map<string, StoredSessionRecord>();
  private readonly trajectorySequencesBySessionId = new Map<string, number>();
  private readonly threadsByChannel = new Map<string, ThreadRegistryEntry>();
  private readonly workingDirsByChannel = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(options: SessionStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_SESSION_ENTRIES;
  }

  get(key: SessionKey): SessionEntry | undefined {
    const entry = this.map.get(serializeSessionKey(key));
    return entry ? cloneEntry(entry) : undefined;
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

  createSessionId(): string {
    let sessionId = randomUUID();
    while (this.keysBySessionId.has(sessionId)) {
      sessionId = randomUUID();
    }
    return sessionId;
  }

  set(key: SessionKey, entry: SessionEntry): void {
    const keyStr = serializeSessionKey(key);
    const sessionId = this.ensureSessionId(key);
    const existing = this.map.get(keyStr);
    const nextEntry = cloneEntry(entry);
    // set() 只保留/更新 resumable 绑定；解除当前绑定走 archiveCurrent()，
    // 硬删除历史才走 delete()。
    if (
      nextEntry.agentSessionId === undefined &&
      existing?.agentSessionId !== undefined
    ) {
      nextEntry.agentSessionId = existing.agentSessionId;
    }
    if (nextEntry.agentOwner === undefined && existing?.agentOwner !== undefined) {
      nextEntry.agentOwner = existing.agentOwner;
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
    this.keysBySessionId.set(sessionId, { ...key });
    this.sessionsBySessionId.set(sessionId, {
      key: { ...key },
      entry: cloneEntry(nextEntry),
    });
    this.evictOverflow();
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
      this.sessionsBySessionId.delete(sessionId);
      this.trajectorySequencesBySessionId.delete(sessionId);
    }
    return this.map.delete(keyStr);
  }

  archiveCurrent(key: SessionKey): boolean {
    const keyStr = serializeSessionKey(key);
    const sessionId = this.sessionIdsByKey.get(keyStr);
    if (!sessionId) return false;
    const record = this.sessionsBySessionId.get(sessionId);
    this.sessionIdsByKey.delete(keyStr);
    const hadCurrent = this.map.delete(keyStr);
    if (!record?.entry.agentSessionId) {
      this.hardDeleteSession(sessionId);
      return hadCurrent;
    }
    this.evictOverflow();
    return hadCurrent;
  }

  clearAll(): void {
    this.map.clear();
    this.sessionIdsByKey.clear();
    this.keysBySessionId.clear();
    this.sessionsBySessionId.clear();
    this.trajectorySequencesBySessionId.clear();
    this.threadsByChannel.clear();
    this.workingDirsByChannel.clear();
  }

  get size(): number {
    return this.map.size;
  }

  listForUser(input: ListSessionsInput): ListedSessionEntry[] {
    const entries: ListedSessionEntry[] = [];
    for (const [sessionId, record] of this.sessionsBySessionId.entries()) {
      const { key, entry } = record;
      if (!entry.agentSessionId) continue;
      if (key.platformName !== input.platformName) continue;
      if (key.platform !== input.platform) continue;
      if (key.initiatorUserId !== input.initiatorUserId) continue;
      if (input.agentOwner && entry.agentOwner !== input.agentOwner) {
        continue;
      }
      entries.push({
        sessionId,
        key: { ...key },
        agentSessionId: entry.agentSessionId,
        agentOwner: entry.agentOwner,
        lastTurnAt: new Date(entry.lastTurnAt),
        title: entry.title,
        nextSession: entry.nextSession ? { ...entry.nextSession } : undefined,
      });
    }
    return entries
      .sort((a, b) => b.lastTurnAt.getTime() - a.lastTurnAt.getTime())
      .slice(0, input.limit);
  }

  touch(key: SessionKey, now: Date): boolean {
    const keyStr = serializeSessionKey(key);
    const existing = this.map.get(keyStr);
    const sessionId = this.sessionIdsByKey.get(keyStr);
    if (!existing || !sessionId) return false;
    const updated = cloneEntry({
      ...existing,
      lastTurnAt: now,
    });
    this.map.set(keyStr, updated);
    const record = this.sessionsBySessionId.get(sessionId);
    if (record) {
      this.sessionsBySessionId.set(sessionId, {
        key: { ...record.key },
        entry: cloneEntry(updated),
      });
    }
    return true;
  }

  activeKeyForSessionId(sessionId: string): SessionKey | undefined {
    const key = this.keysBySessionId.get(sessionId);
    if (!key) return undefined;
    const keyStr = serializeSessionKey(key);
    if (this.sessionIdsByKey.get(keyStr) !== sessionId) return undefined;
    return { ...key };
  }

  bindExistingToKey(
    targetKey: SessionKey,
    sessionId: string,
    now: Date,
    agentOwner?: string,
  ): SessionEntry | undefined {
    const sourceRecord = this.sessionsBySessionId.get(sessionId);
    const sourceKey = sourceRecord?.key ?? this.keysBySessionId.get(sessionId);
    if (!sourceKey || !sourceRecord) return undefined;
    const sourceKeyStr = serializeSessionKey(sourceKey);
    const targetKeyStr = serializeSessionKey(targetKey);
    const source = sourceRecord.entry;
    if (!source?.agentSessionId) return undefined;
    if (agentOwner && source.agentOwner !== agentOwner) {
      return undefined;
    }
    const rebound: SessionEntry = {
      agentSessionId: source.agentSessionId,
      agentOwner: source.agentOwner,
      lastTurnAt: now,
      title: source.title,
    };
    if (source.nextSession) rebound.nextSession = { ...source.nextSession };
    const targetSessionId = this.sessionIdsByKey.get(targetKeyStr);
    if (targetSessionId && targetSessionId !== sessionId) {
      this.archiveCurrent(targetKey);
    }
    if (
      sourceKeyStr !== targetKeyStr &&
      this.sessionIdsByKey.get(sourceKeyStr) === sessionId
    ) {
      this.sessionIdsByKey.delete(sourceKeyStr);
      this.map.delete(sourceKeyStr);
    }
    this.sessionIdsByKey.set(targetKeyStr, sessionId);
    this.keysBySessionId.set(sessionId, { ...targetKey });
    this.map.set(targetKeyStr, cloneEntry(rebound));
    this.sessionsBySessionId.set(sessionId, {
      key: { ...targetKey },
      entry: cloneEntry(rebound),
    });
    this.evictOverflow();
    return cloneEntry(rebound);
  }

  bindExternalResumeToKey(
    targetKey: SessionKey,
    entry: ExternalResumeSessionEntry,
    sessionId?: string,
  ): SessionEntry {
    if (sessionId) {
      if (this.keysBySessionId.has(sessionId)) {
        throw new Error(`Session id is already in use: ${sessionId}`);
      }
      this.archiveCurrent(targetKey);
      const keyStr = serializeSessionKey(targetKey);
      const stored = cloneEntry(entry);
      this.sessionIdsByKey.set(keyStr, sessionId);
      this.keysBySessionId.set(sessionId, { ...targetKey });
      this.map.set(keyStr, stored);
      this.sessionsBySessionId.set(sessionId, {
        key: { ...targetKey },
        entry: cloneEntry(stored),
      });
      this.evictOverflow();
      return cloneEntry(stored);
    }
    if (this.get(targetKey)) this.archiveCurrent(targetKey);
    this.set(targetKey, entry);
    return cloneEntry(this.get(targetKey)!);
  }

  private evictOverflow(): void {
    if (this.sessionsBySessionId.size <= this.maxEntries) return;
    const activeSessionIds = new Set(this.sessionIdsByKey.values());
    const candidates = [...this.sessionsBySessionId.entries()]
      .filter(([sessionId]) => !activeSessionIds.has(sessionId))
      .map(([sessionId, record]) => ({
        sessionId,
        lastTurnAt: record.entry.lastTurnAt.getTime(),
      }))
      .sort((a, b) => a.lastTurnAt - b.lastTurnAt);
    for (const candidate of candidates) {
      if (this.sessionsBySessionId.size <= this.maxEntries) break;
      this.hardDeleteSession(candidate.sessionId);
    }
  }

  private hardDeleteSession(sessionId: string): void {
    this.sessionsBySessionId.delete(sessionId);
    this.keysBySessionId.delete(sessionId);
    this.trajectorySequencesBySessionId.delete(sessionId);
    for (const [keyStr, currentSessionId] of this.sessionIdsByKey.entries()) {
      if (currentSessionId !== sessionId) continue;
      this.sessionIdsByKey.delete(keyStr);
      this.map.delete(keyStr);
    }
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
    const sessionId = this.sessionIdsByKey.get(keyStr);
    const record = sessionId
      ? this.sessionsBySessionId.get(sessionId)
      : undefined;
    if (sessionId && record) {
      this.sessionsBySessionId.set(sessionId, {
        key: { ...record.key },
        entry: cloneEntry(rest),
      });
    }
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
  const cloned = {
    ...entry,
    lastTurnAt: new Date(entry.lastTurnAt),
  };
  if (entry.nextSession) cloned.nextSession = { ...entry.nextSession };
  return cloned;
}
