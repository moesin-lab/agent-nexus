import { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { SessionKey } from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';
import type {
  FindThreadInput,
  SessionEntry,
  SessionStorePersistence,
  SessionStoreSnapshot,
  ThreadRegistryEntry,
} from './session-store.js';
import { StateDatabaseError } from './state-db.js';

interface SessionRow {
  session_id: string;
  session_key: string;
  generation: number;
  state: string;
  created_at: string;
  last_activity_at: string;
  archived_at: string | null;
  agent_backend: string;
  agent_conversation_ref: string | null;
  working_dir: string;
  next_session_json: string | null;
  meta_json: string | null;
}

interface SessionMeta {
  sessionKey: SessionKey;
  title?: string;
  sessionContainer?: {
    kind: 'thread';
    bindingMode: 'fixed' | 'rebindable';
    parentChannelId: string;
    rootMessageId?: string;
    url?: string;
    parentUrl?: string;
  };
  fixedThread?: {
    ownerUserId: string;
    autoArchiveDurationMinutes?: 60 | 1440 | 4320 | 10080;
    renameOnFirstPrompt?: boolean;
    agentName?: string;
    agentOwner?: string;
  };
  trajectorySequence: number;
}

export class SqliteSessionPersistence implements SessionStorePersistence {
  private readonly database: BetterSqliteDatabase;

  constructor(input: { database: BetterSqliteDatabase }) {
    this.database = input.database;
  }

  load(): SessionStoreSnapshot | undefined {
    return this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE sessions
           SET state = 'Interrupted'
           WHERE state IN ('Created', 'Active', 'Idle', 'Errored')`,
        )
        .run();
      const rows = this.database
        .prepare(
          `SELECT session_id, session_key, generation, state, created_at,
                  last_activity_at, archived_at, agent_backend,
                  agent_conversation_ref, working_dir, next_session_json,
                  meta_json
           FROM sessions
           ORDER BY last_activity_at ASC, session_id ASC`,
        )
        .all() as SessionRow[];
      if (rows.length === 0) return undefined;

      const sessions: SessionStoreSnapshot['sessions'] = [];
      const threadsByKey = new Map<
        string,
        { key: FindThreadInput; entry: ThreadRegistryEntry }
      >();
      const currentKeys = new Set<string>();
      for (const row of rows) {
        const meta = parseMeta(row);
        validateSessionRow(row, meta);
        const current = row.state !== 'Archived';
        if (current) {
          const key = serializeSessionKey(meta.sessionKey);
          if (currentKeys.has(key)) {
            throw invalidSessionRow(
              row.session_id,
              `multiple current rows for ${key}`,
            );
          }
          currentKeys.add(key);
        }
        const entry: SessionEntry = {
          lastTurnAt: parseDate(row.last_activity_at, row.session_id),
        };
        if (row.agent_conversation_ref !== null) {
          entry.agentSessionId = row.agent_conversation_ref;
        }
        if (row.agent_backend !== 'unknown') {
          entry.agentOwner = row.agent_backend;
        }
        if (meta.title !== undefined) entry.title = meta.title;
        if (row.working_dir.length > 0) entry.workingDir = row.working_dir;
        const nextSession = parseNextSession(row);
        if (nextSession) entry.nextSession = nextSession;
        sessions.push({
          sessionId: row.session_id,
          key: { ...meta.sessionKey },
          entry,
          generation: row.generation,
          createdAt: parseDate(row.created_at, row.session_id),
          archivedAt:
            row.archived_at === null
              ? undefined
              : parseDate(row.archived_at, row.session_id),
          trajectorySequence: meta.trajectorySequence,
          current,
        });
        const thread = threadFromMeta(meta);
        if (thread) {
          const key: FindThreadInput = {
            platformName: meta.sessionKey.platformName,
            platform: meta.sessionKey.platform,
            channelId: meta.sessionKey.channelId,
          };
          threadsByKey.set(registryKey(key), { key, entry: thread });
        }
      }
      return { sessions, threads: [...threadsByKey.values()] };
    })();
  }

  save(
    snapshot: SessionStoreSnapshot,
    options: { restoring?: boolean } = {},
  ): void {
    const threadByKey = new Map(
      snapshot.threads.map((thread) => [registryKey(thread.key), thread.entry]),
    );
    this.database.transaction(() => {
      deleteMissingSessions(
        this.database,
        snapshot.sessions.map((session) => session.sessionId),
      );
      const upsert = this.database.prepare(
        `INSERT INTO sessions (
          session_id, session_key, generation, state, created_at,
          last_activity_at, archived_at, agent_backend,
          agent_conversation_ref, working_dir, next_session_json,
          transcript_path, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          session_key = excluded.session_key,
          generation = excluded.generation,
          state = excluded.state,
          created_at = excluded.created_at,
          last_activity_at = excluded.last_activity_at,
          archived_at = excluded.archived_at,
          agent_backend = excluded.agent_backend,
          agent_conversation_ref = excluded.agent_conversation_ref,
          working_dir = excluded.working_dir,
          next_session_json = excluded.next_session_json,
          transcript_path = excluded.transcript_path,
          meta_json = excluded.meta_json`,
      );
      for (const session of snapshot.sessions) {
        const thread = threadByKey.get(
          registryKey({
            platformName: session.key.platformName,
            platform: session.key.platform,
            channelId: session.key.channelId,
          }),
        );
        const meta = buildMeta(session, thread);
        upsert.run(
          session.sessionId,
          serializeSessionKey(session.key),
          session.generation,
          session.current
            ? options.restoring
              ? 'Interrupted'
              : 'Active'
            : 'Archived',
          session.createdAt.toISOString(),
          session.entry.lastTurnAt.toISOString(),
          session.current
            ? null
            : (session.archivedAt ?? session.entry.lastTurnAt).toISOString(),
          session.entry.agentOwner ?? 'unknown',
          session.entry.agentSessionId ?? null,
          session.entry.workingDir ?? '',
          session.entry.nextSession
            ? JSON.stringify(session.entry.nextSession)
            : null,
          `transcripts/${session.sessionId}`,
          JSON.stringify(meta),
        );
      }
    })();
  }

  close(): void {}
}

function buildMeta(
  session: SessionStoreSnapshot['sessions'][number],
  thread: ThreadRegistryEntry | undefined,
): SessionMeta {
  const meta: SessionMeta = {
    sessionKey: { ...session.key },
    trajectorySequence: session.trajectorySequence,
  };
  if (session.entry.title !== undefined) meta.title = session.entry.title;
  if (thread) {
    meta.sessionContainer = {
      kind: 'thread',
      bindingMode: thread.bindingMode ?? 'rebindable',
      parentChannelId: thread.parentChannelId,
      ...(thread.rootMessageId
        ? { rootMessageId: thread.rootMessageId }
        : {}),
      ...(thread.url ? { url: thread.url } : {}),
      ...(thread.parentUrl ? { parentUrl: thread.parentUrl } : {}),
    };
    meta.fixedThread = {
      ownerUserId: thread.ownerUserId,
      ...(thread.autoArchiveDurationMinutes
        ? { autoArchiveDurationMinutes: thread.autoArchiveDurationMinutes }
        : {}),
      ...(thread.renameOnFirstPrompt !== undefined
        ? { renameOnFirstPrompt: thread.renameOnFirstPrompt }
        : {}),
      ...(thread.agentName ? { agentName: thread.agentName } : {}),
      ...(thread.agentOwner ? { agentOwner: thread.agentOwner } : {}),
    };
  }
  return meta;
}

function parseMeta(row: SessionRow): SessionMeta {
  if (row.meta_json === null) {
    throw invalidSessionRow(row.session_id, 'meta_json is null');
  }
  let value: unknown;
  try {
    value = JSON.parse(row.meta_json);
  } catch {
    throw invalidSessionRow(row.session_id, 'meta_json is invalid JSON');
  }
  if (!isRecord(value) || !isSessionKey(value['sessionKey'])) {
    throw invalidSessionRow(row.session_id, 'meta_json.sessionKey is invalid');
  }
  const trajectorySequence = value['trajectorySequence'];
  if (
    !Number.isSafeInteger(trajectorySequence) ||
    (trajectorySequence as number) < 0
  ) {
    throw invalidSessionRow(
      row.session_id,
      'meta_json.trajectorySequence is invalid',
    );
  }
  const meta: SessionMeta = {
    sessionKey: { ...value['sessionKey'] },
    trajectorySequence: trajectorySequence as number,
  };
  if (value['title'] !== undefined) {
    if (typeof value['title'] !== 'string') {
      throw invalidSessionRow(row.session_id, 'meta_json.title is invalid');
    }
    meta.title = value['title'];
  }
  if (isSessionContainer(value['sessionContainer'])) {
    meta.sessionContainer = { ...value['sessionContainer'] };
  } else if (value['sessionContainer'] !== undefined) {
    throw invalidSessionRow(
      row.session_id,
      'meta_json.sessionContainer is invalid',
    );
  }
  if (isFixedThread(value['fixedThread'])) {
    meta.fixedThread = { ...value['fixedThread'] };
  } else if (value['fixedThread'] !== undefined) {
    throw invalidSessionRow(
      row.session_id,
      'meta_json.fixedThread is invalid',
    );
  }
  if (Boolean(meta.sessionContainer) !== Boolean(meta.fixedThread)) {
    throw invalidSessionRow(
      row.session_id,
      'sessionContainer and fixedThread must be stored together',
    );
  }
  if (
    meta.sessionContainer?.bindingMode === 'fixed' &&
    (!meta.fixedThread?.agentName || !meta.fixedThread.agentOwner)
  ) {
    throw invalidSessionRow(
      row.session_id,
      'fixed session container is missing pinned agent identity',
    );
  }
  return meta;
}

function validateSessionRow(row: SessionRow, meta: SessionMeta): void {
  if (typeof row.session_id !== 'string' || row.session_id.length === 0) {
    throw invalidSessionRow(row.session_id, 'session_id is empty');
  }
  if (
    typeof row.session_key !== 'string' ||
    typeof row.state !== 'string' ||
    typeof row.created_at !== 'string' ||
    typeof row.last_activity_at !== 'string' ||
    (row.archived_at !== null && typeof row.archived_at !== 'string')
  ) {
    throw invalidSessionRow(row.session_id, 'indexed state columns have invalid types');
  }
  if (row.session_key !== serializeSessionKey(meta.sessionKey)) {
    throw invalidSessionRow(
      row.session_id,
      'session_key disagrees with meta_json.sessionKey',
    );
  }
  if (!Number.isSafeInteger(row.generation) || row.generation < 1) {
    throw invalidSessionRow(row.session_id, 'generation is invalid');
  }
  if (!SESSION_STATES.has(row.state)) {
    throw invalidSessionRow(row.session_id, `state is invalid: ${row.state}`);
  }
  if (row.state === 'Archived' && row.archived_at === null) {
    throw invalidSessionRow(
      row.session_id,
      'Archived session is missing archived_at',
    );
  }
  if (row.state !== 'Archived' && row.archived_at !== null) {
    throw invalidSessionRow(
      row.session_id,
      'current session must not have archived_at',
    );
  }
  if (
    typeof row.agent_backend !== 'string' ||
    typeof row.working_dir !== 'string'
  ) {
    throw invalidSessionRow(row.session_id, 'text columns have invalid types');
  }
  if (
    row.agent_conversation_ref !== null &&
    typeof row.agent_conversation_ref !== 'string'
  ) {
    throw invalidSessionRow(
      row.session_id,
      'agent_conversation_ref has invalid type',
    );
  }
  if (
    meta.sessionContainer?.bindingMode === 'fixed' &&
    meta.fixedThread?.agentOwner !== row.agent_backend
  ) {
    throw invalidSessionRow(
      row.session_id,
      'fixed agent owner disagrees with agent_backend',
    );
  }
  if (
    meta.sessionContainer?.bindingMode === 'fixed' &&
    meta.fixedThread?.ownerUserId !== meta.sessionKey.initiatorUserId
  ) {
    throw invalidSessionRow(
      row.session_id,
      'fixed topic owner disagrees with session initiator',
    );
  }
}

const SESSION_STATES = new Set([
  'Created',
  'Active',
  'Idle',
  'Archived',
  'Errored',
  'Interrupted',
]);

function parseNextSession(
  row: SessionRow,
): SessionEntry['nextSession'] | undefined {
  if (row.next_session_json === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(row.next_session_json);
  } catch {
    throw invalidSessionRow(row.session_id, 'next_session_json is invalid JSON');
  }
  if (!isRecord(value)) {
    throw invalidSessionRow(row.session_id, 'next_session_json is invalid');
  }
  const workingDir = value['workingDir'];
  if (workingDir !== undefined && typeof workingDir !== 'string') {
    throw invalidSessionRow(
      row.session_id,
      'next_session_json.workingDir is invalid',
    );
  }
  return workingDir === undefined ? {} : { workingDir };
}

function threadFromMeta(meta: SessionMeta): ThreadRegistryEntry | undefined {
  const container = meta.sessionContainer;
  const fixed = meta.fixedThread;
  if (!container || !fixed) return undefined;
  return {
    kind: 'thread',
    parentChannelId: container.parentChannelId,
    ownerUserId: fixed.ownerUserId,
    bindingMode: container.bindingMode,
    ...(container.rootMessageId
      ? { rootMessageId: container.rootMessageId }
      : {}),
    ...(container.url ? { url: container.url } : {}),
    ...(container.parentUrl ? { parentUrl: container.parentUrl } : {}),
    ...(fixed.autoArchiveDurationMinutes
      ? { autoArchiveDurationMinutes: fixed.autoArchiveDurationMinutes }
      : {}),
    ...(fixed.renameOnFirstPrompt !== undefined
      ? { renameOnFirstPrompt: fixed.renameOnFirstPrompt }
      : {}),
    ...(fixed.agentName ? { agentName: fixed.agentName } : {}),
    ...(fixed.agentOwner ? { agentOwner: fixed.agentOwner } : {}),
  };
}

function deleteMissingSessions(
  database: BetterSqliteDatabase,
  sessionIds: string[],
): void {
  if (sessionIds.length === 0) {
    database.prepare('DELETE FROM sessions').run();
    return;
  }
  const placeholders = sessionIds.map(() => '?').join(', ');
  database
    .prepare(`DELETE FROM sessions WHERE session_id NOT IN (${placeholders})`)
    .run(...sessionIds);
}

function parseDate(value: string, sessionId: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalidSessionRow(sessionId, `invalid date ${value}`);
  }
  return date;
}

function registryKey(input: FindThreadInput): string {
  return JSON.stringify([
    input.platformName,
    input.platform,
    input.channelId,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSessionKey(value: unknown): value is SessionKey {
  return (
    isRecord(value) &&
    typeof value['platformName'] === 'string' &&
    typeof value['platform'] === 'string' &&
    typeof value['channelId'] === 'string' &&
    typeof value['initiatorUserId'] === 'string'
  );
}

function isSessionContainer(
  value: unknown,
): value is NonNullable<SessionMeta['sessionContainer']> {
  return (
    isRecord(value) &&
    value['kind'] === 'thread' &&
    (value['bindingMode'] === 'fixed' ||
      value['bindingMode'] === 'rebindable') &&
    typeof value['parentChannelId'] === 'string' &&
    optionalString(value['rootMessageId']) &&
    optionalString(value['url']) &&
    optionalString(value['parentUrl'])
  );
}

function isFixedThread(
  value: unknown,
): value is NonNullable<SessionMeta['fixedThread']> {
  return (
    isRecord(value) &&
    typeof value['ownerUserId'] === 'string' &&
    optionalString(value['agentName']) &&
    optionalString(value['agentOwner']) &&
    (value['renameOnFirstPrompt'] === undefined ||
      typeof value['renameOnFirstPrompt'] === 'boolean') &&
    (value['autoArchiveDurationMinutes'] === undefined ||
      [60, 1440, 4320, 10080].includes(
        value['autoArchiveDurationMinutes'] as number,
      ))
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function invalidSessionRow(
  sessionId: string,
  reason: string,
): StateDatabaseError {
  return new StateDatabaseError(
    'invalid-schema',
    `Invalid persisted session ${sessionId}: ${reason}`,
  );
}
