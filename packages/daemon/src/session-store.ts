import { randomUUID } from 'node:crypto';
import type { SessionContainerRef, SessionKey } from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';

/**
 * 跨 turn 维护 SessionKey → 当前 agentSessionId，并保留可恢复历史的最小内存映射。
 *
 * 列表、绑定、next workingDir 相关方法是 daemon-owned session/thread
 * command 接线的 store 层契约；业务路由保持在 Engine / command handler。
 *
 * 默认可作为纯内存 store；production 通过 SessionStorePersistence 同步落盘。
 * runtime handle 与 queue 不属于本 store，不会进入 snapshot。
 */
export interface SessionEntry {
  agentSessionId?: string;
  agentOwner?: string;
  lastTurnAt: Date;
  title?: string;
  workingDir?: string;
  nextSession?: {
    workingDir?: string;
  };
}

export interface ThreadRegistryEntry {
  kind?: 'thread';
  parentChannelId: string;
  ownerUserId: string;
  autoArchiveDurationMinutes?: 60 | 1440 | 4320 | 10080;
  renameOnFirstPrompt?: boolean;
  bindingMode?: SessionContainerRef['bindingMode'];
  rootMessageId?: string;
  url?: string;
  parentUrl?: string;
  agentName?: string;
  agentOwner?: string;
}

export interface ListedSessionEntry extends Omit<SessionEntry, 'agentSessionId'> {
  sessionId: string;
  key: SessionKey;
  agentSessionId: string;
  sessionContainer?: SessionContainerRef;
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
  generation: number;
  createdAt: Date;
  archivedAt?: Date;
  trajectorySequence: number;
}

export interface SessionStoreOptions {
  maxEntries?: number;
  persistence?: SessionStorePersistence;
}

export interface SessionStoreSnapshot {
  sessions: Array<{
    sessionId: string;
    key: SessionKey;
    entry: SessionEntry;
    generation: number;
    createdAt: Date;
    archivedAt?: Date;
    trajectorySequence: number;
    current: boolean;
  }>;
  threads: Array<{
    key: FindThreadInput;
    entry: ThreadRegistryEntry;
  }>;
}

export interface SessionStorePersistence {
  load(): SessionStoreSnapshot | undefined;
  save(
    snapshot: SessionStoreSnapshot,
    options?: { restoring?: boolean },
  ): void;
  close(): void;
}

const DEFAULT_MAX_SESSION_ENTRIES = 100;

export class SessionStore {
  private readonly map = new Map<string, SessionEntry>();
  private readonly sessionIdsByKey = new Map<string, string>();
  private readonly keysBySessionId = new Map<string, SessionKey>();
  private readonly sessionsBySessionId = new Map<string, StoredSessionRecord>();
  private readonly trajectorySequencesBySessionId = new Map<string, number>();
  private readonly threadsByChannel = new Map<string, ThreadRegistryEntry>();
  private readonly threadKeysByChannel = new Map<string, FindThreadInput>();
  private readonly workingDirsByChannel = new Map<string, string>();
  private readonly maxEntries: number;
  private readonly persistence: SessionStorePersistence | undefined;
  private committedSnapshot: SessionStoreSnapshot = emptySnapshot();
  private persistenceTransactionActive = false;

  constructor(options: SessionStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_SESSION_ENTRIES;
    this.persistence = options.persistence;
    const snapshot = this.persistence?.load();
    if (!snapshot) return;
    const evicted = this.hydrate(snapshot);
    const restored = this.snapshot();
    if (evicted) this.persistence?.save(restored, { restoring: true });
    this.committedSnapshot = cloneSnapshot(restored);
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
      nextEntry.workingDir === undefined &&
      existing?.workingDir !== undefined
    ) {
      nextEntry.workingDir = existing.workingDir;
    }
    if (
      nextEntry.nextSession === undefined &&
      existing?.nextSession !== undefined
    ) {
      nextEntry.nextSession = existing.nextSession;
    }
    this.map.set(keyStr, nextEntry);
    this.keysBySessionId.set(sessionId, { ...key });
    const existingRecord = this.sessionsBySessionId.get(sessionId);
    this.sessionsBySessionId.set(sessionId, {
      key: { ...key },
      entry: cloneEntry(nextEntry),
      generation:
        existingRecord?.generation ?? this.nextGenerationForKey(key, sessionId),
      createdAt:
        existingRecord?.createdAt ?? new Date(nextEntry.lastTurnAt),
      trajectorySequence:
        this.trajectorySequencesBySessionId.get(sessionId) ??
        existingRecord?.trajectorySequence ??
        0,
    });
    this.evictOverflow();
    this.persist();
  }

  nextTrajectorySequence(sessionId: string): number {
    const next = (this.trajectorySequencesBySessionId.get(sessionId) ?? 0) + 1;
    this.trajectorySequencesBySessionId.set(sessionId, next);
    const record = this.sessionsBySessionId.get(sessionId);
    if (record) {
      this.sessionsBySessionId.set(sessionId, {
        ...record,
        trajectorySequence: next,
      });
      this.persist();
    }
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
    const deleted = this.map.delete(keyStr);
    if (sessionId || deleted) this.persist();
    return deleted;
  }

  archiveCurrent(key: SessionKey): boolean {
    const hadCurrent = this.archiveCurrentInMemory(key);
    if (hadCurrent === undefined) return false;
    this.evictOverflow();
    this.persist();
    return hadCurrent;
  }

  private archiveCurrentInMemory(key: SessionKey): boolean | undefined {
    const keyStr = serializeSessionKey(key);
    const sessionId = this.sessionIdsByKey.get(keyStr);
    if (!sessionId) return undefined;
    const record = this.sessionsBySessionId.get(sessionId);
    this.sessionIdsByKey.delete(keyStr);
    const hadCurrent = this.map.delete(keyStr);
    if (!record?.entry.agentSessionId) {
      this.hardDeleteSession(sessionId);
      return hadCurrent;
    }
    this.sessionsBySessionId.set(sessionId, {
      ...record,
      archivedAt: new Date(),
    });
    return hadCurrent;
  }

  clearAll(): void {
    this.map.clear();
    this.sessionIdsByKey.clear();
    this.keysBySessionId.clear();
    this.sessionsBySessionId.clear();
    this.trajectorySequencesBySessionId.clear();
    this.threadsByChannel.clear();
    this.threadKeysByChannel.clear();
    this.workingDirsByChannel.clear();
    this.persist();
  }

  close(): void {
    this.persistence?.close();
  }

  runInPersistenceTransaction<T>(
    transaction: (action: () => T) => T,
    action: () => T,
  ): T {
    if (this.persistenceTransactionActive) {
      throw new Error('Nested SessionStore persistence transaction is unsupported');
    }
    const memoryBefore = this.snapshot();
    const committedBefore = cloneSnapshot(this.committedSnapshot);
    this.persistenceTransactionActive = true;
    let result: T;
    try {
      result = transaction(action);
    } catch (error) {
      this.hydrate(memoryBefore);
      this.committedSnapshot = committedBefore;
      throw error;
    } finally {
      this.persistenceTransactionActive = false;
    }
    this.committedSnapshot = cloneSnapshot(this.snapshot());
    return result;
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
        ...this.listedSessionContainer(key),
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
        ...record,
        key: { ...record.key },
        entry: cloneEntry(updated),
      });
    }
    this.persist();
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
    if (this.isFixedContainer(targetKey)) return undefined;
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
      workingDir: source.workingDir,
    };
    if (source.nextSession) rebound.nextSession = { ...source.nextSession };
    const targetSessionId = this.sessionIdsByKey.get(targetKeyStr);
    if (targetSessionId && targetSessionId !== sessionId) {
      this.archiveCurrentInMemory(targetKey);
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
      ...sourceRecord,
      key: { ...targetKey },
      entry: cloneEntry(rebound),
      generation:
        sourceKeyStr === targetKeyStr
          ? sourceRecord.generation
          : this.nextGenerationForKey(targetKey, sessionId),
      archivedAt: undefined,
    });
    this.evictOverflow();
    this.persist();
    return cloneEntry(rebound);
  }

  bindExternalResumeToKey(
    targetKey: SessionKey,
    entry: ExternalResumeSessionEntry,
    sessionId?: string,
  ): SessionEntry {
    if (this.isFixedContainer(targetKey)) {
      throw new Error('Cannot rebind a fixed session container');
    }
    if (sessionId) {
      if (this.keysBySessionId.has(sessionId)) {
        throw new Error(`Session id is already in use: ${sessionId}`);
      }
      this.archiveCurrentInMemory(targetKey);
      const keyStr = serializeSessionKey(targetKey);
      const stored = cloneEntry(entry);
      this.sessionIdsByKey.set(keyStr, sessionId);
      this.keysBySessionId.set(sessionId, { ...targetKey });
      this.map.set(keyStr, stored);
      this.sessionsBySessionId.set(sessionId, {
        key: { ...targetKey },
        entry: cloneEntry(stored),
        generation: this.nextGenerationForKey(targetKey, sessionId),
        createdAt: new Date(stored.lastTurnAt),
        trajectorySequence: 0,
      });
      this.evictOverflow();
      this.persist();
      return cloneEntry(stored);
    }
    if (this.get(targetKey)) this.archiveCurrentInMemory(targetKey);
    this.set(targetKey, entry);
    return cloneEntry(this.get(targetKey)!);
  }

  private evictOverflow(): boolean {
    if (this.sessionsBySessionId.size <= this.maxEntries) return false;
    let evicted = false;
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
      evicted = true;
    }
    return evicted;
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
        ...record,
        key: { ...record.key },
        entry: cloneEntry(rest),
      });
    }
    this.persist();
    return workingDir;
  }

  registerThread(key: SessionKey, thread: ThreadRegistryEntry): void {
    const registryKey = threadRegistryKey({
      platformName: key.platformName,
      platform: key.platform,
      channelId: key.channelId,
    });
    const existing = this.threadsByChannel.get(registryKey);
    const fixedRootChanged =
      existing?.bindingMode === 'fixed' &&
      thread.bindingMode === 'fixed' &&
      existing.rootMessageId !== undefined &&
      thread.rootMessageId !== undefined &&
      existing.rootMessageId !== thread.rootMessageId;
    const next: ThreadRegistryEntry = {
      ...existing,
      ...thread,
      kind: 'thread',
      ...(thread.url === undefined && existing?.url && !fixedRootChanged
        ? { url: existing.url }
        : {}),
      ...(thread.parentUrl === undefined && existing?.parentUrl
        ? { parentUrl: existing.parentUrl }
        : {}),
    };
    if (fixedRootChanged && thread.url === undefined) delete next.url;
    this.threadsByChannel.set(registryKey, next);
    this.threadKeysByChannel.set(registryKey, {
      platformName: key.platformName,
      platform: key.platform,
      channelId: key.channelId,
    });
    this.persist();
  }

  claimFixedThreadAgent(
    key: SessionKey,
    identity: { agentName: string; agentOwner: string },
  ): boolean {
    const registryKey = threadRegistryKey({
      platformName: key.platformName,
      platform: key.platform,
      channelId: key.channelId,
    });
    const thread = this.threadsByChannel.get(registryKey);
    if (!thread || thread.bindingMode !== 'fixed') return true;
    if (thread.agentName && thread.agentName !== identity.agentName) {
      return false;
    }
    if (thread.agentOwner && thread.agentOwner !== identity.agentOwner) {
      return false;
    }
    this.threadsByChannel.set(registryKey, {
      ...thread,
      agentName: identity.agentName,
      agentOwner: identity.agentOwner,
    });
    this.persist();
    return true;
  }

  private isFixedContainer(key: SessionKey): boolean {
    return this.findThreadByChannelId(key)?.bindingMode === 'fixed';
  }

  private listedSessionContainer(
    key: SessionKey,
  ): { sessionContainer: SessionContainerRef } | Record<string, never> {
    const thread = this.findThreadByChannelId(key);
    if (!thread) return {};
    return {
      sessionContainer: {
        kind: 'thread',
        bindingMode: thread.bindingMode ?? 'rebindable',
        parentChannelId: thread.parentChannelId,
        ...(thread.rootMessageId
          ? { rootMessageId: thread.rootMessageId }
          : {}),
        ...(thread.url ? { url: thread.url } : {}),
        ...(thread.parentUrl ? { parentUrl: thread.parentUrl } : {}),
      },
    };
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

  private nextGenerationForKey(key: SessionKey, excludedSessionId?: string): number {
    const keyStr = serializeSessionKey(key);
    let max = 0;
    for (const [sessionId, record] of this.sessionsBySessionId.entries()) {
      if (sessionId === excludedSessionId) continue;
      if (serializeSessionKey(record.key) !== keyStr) continue;
      max = Math.max(max, record.generation);
    }
    return max + 1;
  }

  private snapshot(): SessionStoreSnapshot {
    return {
      sessions: [...this.sessionsBySessionId.entries()].map(
        ([sessionId, record]) => ({
          sessionId,
          key: { ...record.key },
          entry: cloneEntry(record.entry),
          generation: record.generation,
          createdAt: new Date(record.createdAt),
          archivedAt: record.archivedAt
            ? new Date(record.archivedAt)
            : undefined,
          trajectorySequence: record.trajectorySequence,
          current:
            this.sessionIdsByKey.get(serializeSessionKey(record.key)) ===
            sessionId,
        }),
      ),
      threads: [...this.threadsByChannel.entries()].flatMap(
        ([registryKey, entry]) => {
          const key = this.threadKeysByChannel.get(registryKey);
          return key ? [{ key: { ...key }, entry: { ...entry } }] : [];
        },
      ),
    };
  }

  private hydrate(snapshot: SessionStoreSnapshot): boolean {
    this.resetMemory();
    for (const session of snapshot.sessions) {
      const key = { ...session.key };
      const entry = cloneEntry(session.entry);
      this.keysBySessionId.set(session.sessionId, key);
      this.sessionsBySessionId.set(session.sessionId, {
        key,
        entry,
        generation: session.generation,
        createdAt: new Date(session.createdAt),
        archivedAt: session.archivedAt
          ? new Date(session.archivedAt)
          : undefined,
        trajectorySequence: session.trajectorySequence,
      });
      this.trajectorySequencesBySessionId.set(
        session.sessionId,
        session.trajectorySequence,
      );
      if (session.current) {
        const keyStr = serializeSessionKey(key);
        this.sessionIdsByKey.set(keyStr, session.sessionId);
        this.map.set(keyStr, cloneEntry(entry));
      }
    }
    for (const thread of snapshot.threads) {
      const registryKey = threadRegistryKey(thread.key);
      this.threadKeysByChannel.set(registryKey, { ...thread.key });
      this.threadsByChannel.set(registryKey, { ...thread.entry });
    }
    return this.evictOverflow();
  }

  private resetMemory(): void {
    this.map.clear();
    this.sessionIdsByKey.clear();
    this.keysBySessionId.clear();
    this.sessionsBySessionId.clear();
    this.trajectorySequencesBySessionId.clear();
    this.threadsByChannel.clear();
    this.threadKeysByChannel.clear();
    this.workingDirsByChannel.clear();
  }

  private persist(): void {
    if (!this.persistence) return;
    const snapshot = this.snapshot();
    try {
      this.persistence.save(snapshot);
      if (!this.persistenceTransactionActive) {
        this.committedSnapshot = cloneSnapshot(snapshot);
      }
    } catch (error) {
      this.hydrate(this.committedSnapshot);
      throw error;
    }
  }
}

function emptySnapshot(): SessionStoreSnapshot {
  return { sessions: [], threads: [] };
}

function cloneSnapshot(snapshot: SessionStoreSnapshot): SessionStoreSnapshot {
  return {
    sessions: snapshot.sessions.map((session) => ({
      ...session,
      key: { ...session.key },
      entry: cloneEntry(session.entry),
      createdAt: new Date(session.createdAt),
      archivedAt: session.archivedAt
        ? new Date(session.archivedAt)
        : undefined,
    })),
    threads: snapshot.threads.map((thread) => ({
      key: { ...thread.key },
      entry: { ...thread.entry },
    })),
  };
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
