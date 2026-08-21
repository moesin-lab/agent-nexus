import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type DatabaseConstructor from 'better-sqlite3';
import { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteTrajectoryStore,
  TrajectoryStoreError,
  type ExternalSessionImportRecord,
  type ProviderCallObservation,
  type TrajectorySegment,
} from './trajectory-store.js';
import {
  CURRENT_STATE_SCHEMA_VERSION,
  SqliteStateDatabase,
  StateDatabaseError,
} from './state-db.js';

const tempDirs: string[] = [];
const require = createRequire(import.meta.url);

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('SqliteTrajectoryStore', () => {
  it('records trajectory schema version on first open and preserves it across reopen', () => {
    const dbPath = tempDbPath();
    const first = new SqliteTrajectoryStore({ path: dbPath });
    first.close();

    const db = openDb(dbPath);
    expect(readSchemaVersion(db)).toBe(CURRENT_STATE_SCHEMA_VERSION);
    db.close();

    const second = new SqliteTrajectoryStore({ path: dbPath });
    second.close();

    const reopened = openDb(dbPath);
    expect(readSchemaVersion(reopened)).toBe(CURRENT_STATE_SCHEMA_VERSION);
    reopened.close();
  });

  it('migrates a V1 trajectory database to sessions without losing records', () => {
    const dbPath = tempDbPath();
    createV1StateDb(dbPath);

    const state = new SqliteStateDatabase({ path: dbPath });
    const store = new SqliteTrajectoryStore({ database: state.database });

    expect(readSchemaVersion(state.database)).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(store.getExternalSessionImport('imp-v1')).toMatchObject({
      sourceSessionId: 'source-v1',
      metadataJson: '{}',
    });
    const sessionsTable = state.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
      )
      .get();
    expect(sessionsTable).toEqual({ name: 'sessions' });
    store.close();
    state.close();

    const reopened = new SqliteStateDatabase({ path: dbPath });
    expect(readSchemaVersion(reopened.database)).toBe(
      CURRENT_STATE_SCHEMA_VERSION,
    );
    reopened.close();
  });

  it('fails closed when the state schema version is newer than supported', () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    db.exec(`
      CREATE TABLE trajectory_schema_version (
        id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO trajectory_schema_version (id, version, updated_at)
      VALUES (1, ${CURRENT_STATE_SCHEMA_VERSION + 1}, '2026-08-21T00:00:00.000Z');
    `);
    db.close();

    expect(() => new SqliteStateDatabase({ path: dbPath })).toThrow(
      StateDatabaseError,
    );
    try {
      new SqliteStateDatabase({ path: dbPath });
    } catch (error) {
      expect(error).toMatchObject({ code: 'unsupported-schema-version' });
    }
  });

  it('fails closed when a current-version database is missing sessions', () => {
    const dbPath = tempDbPath();
    const first = new SqliteStateDatabase({ path: dbPath });
    first.database.exec('DROP TABLE sessions');
    first.close();

    expect(() => new SqliteStateDatabase({ path: dbPath })).toThrow(
      StateDatabaseError,
    );
    try {
      new SqliteStateDatabase({ path: dbPath });
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid-schema' });
    }
  });

  it('fails closed when a current-version trajectory table is missing a required column', () => {
    const dbPath = tempDbPath();
    const first = new SqliteStateDatabase({ path: dbPath });
    first.database.exec('ALTER TABLE trajectory_segments DROP COLUMN summary');
    first.close();

    expect(() => new SqliteStateDatabase({ path: dbPath })).toThrow(
      StateDatabaseError,
    );
    try {
      new SqliteStateDatabase({ path: dbPath });
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid-schema' });
    }
  });

  it.each([
    {
      label: 'column type',
      sql: `
        ALTER TABLE sessions DROP COLUMN cost_used_usd;
        ALTER TABLE sessions ADD COLUMN cost_used_usd TEXT;
      `,
    },
    {
      label: 'not-null constraint',
      sql: `
        ALTER TABLE sessions DROP COLUMN working_dir;
        ALTER TABLE sessions ADD COLUMN working_dir TEXT;
      `,
    },
  ])('fails closed when a current-version $label is incompatible', ({ sql }) => {
    const dbPath = tempDbPath();
    const first = new SqliteStateDatabase({ path: dbPath });
    first.database.exec(sql);
    first.close();

    expect(() => new SqliteStateDatabase({ path: dbPath })).toThrow(
      StateDatabaseError,
    );
  });

  it('fails closed when a current-version required index is missing', () => {
    const dbPath = tempDbPath();
    const first = new SqliteStateDatabase({ path: dbPath });
    first.database.exec('DROP INDEX idx_sessions_last_activity');
    first.close();

    expect(() => new SqliteStateDatabase({ path: dbPath })).toThrow(
      StateDatabaseError,
    );
  });

  it('does not accept a partial index as the session generation unique constraint', () => {
    const dbPath = tempDbPath();
    const first = new SqliteStateDatabase({ path: dbPath });
    first.database.exec(`
      ALTER TABLE sessions RENAME TO sessions_old;
      DROP TABLE sessions_old;
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        state TEXT NOT NULL CHECK (
          state IN ('Created', 'Active', 'Idle', 'Archived', 'Errored', 'Interrupted')
        ),
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        archived_at TEXT,
        agent_backend TEXT NOT NULL,
        agent_conversation_ref TEXT,
        working_dir TEXT NOT NULL,
        next_session_json TEXT,
        transcript_path TEXT NOT NULL,
        turns_used INTEGER NOT NULL DEFAULT 0,
        tool_calls_used INTEGER NOT NULL DEFAULT 0,
        wall_clock_ms INTEGER NOT NULL DEFAULT 0,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        cost_used_usd REAL,
        budget_limit_usd REAL,
        meta_json TEXT
      );
      CREATE INDEX idx_sessions_last_activity
        ON sessions(last_activity_at);
      CREATE INDEX idx_sessions_key_generation
        ON sessions(session_key, generation DESC);
      CREATE UNIQUE INDEX idx_sessions_partial_unique
        ON sessions(session_key, generation)
        WHERE state = 'Active';
    `);
    first.close();

    expect(() => new SqliteStateDatabase({ path: dbPath })).toThrow(
      StateDatabaseError,
    );
  });

  it('persists external imports, trajectory segments, and provider observations across reopen', () => {
    const dbPath = tempDbPath();
    const first = new SqliteTrajectoryStore({ path: dbPath });

    first.upsertExternalSessionImport(importRecord());
    const binding = first.linkExternalSession({
      importId: 'imp-1',
      sessionId: 'sess-1',
      linkedAt: '2026-06-23T09:01:00.000Z',
    });
    first.appendTrajectorySegment(segment({ segmentId: 'seg-1' }));
    first.recordProviderCallObservation(observation());
    first.close();

    const second = new SqliteTrajectoryStore({ path: dbPath });

    expect(binding).toMatchObject({
      sessionId: 'sess-1',
      importId: 'imp-1',
      nativeSessionRef: 'native-1',
    });
    expect(second.getExternalSessionImport('imp-1')).toMatchObject({
      state: 'linked',
      linkedSessionId: 'sess-1',
      linkedAt: '2026-06-23T09:01:00.000Z',
    });
    expect(second.queryTrajectory({ sessionId: 'sess-1' }).segments).toHaveLength(
      1,
    );
    expect(second.getProviderCallObservation('obs-1')).toMatchObject({
      backend: 'codex',
      requestSummary: 'safe request',
    });
    second.close();
  });

  it('redacts persisted import metadata and error messages at the store boundary', () => {
    const store = new SqliteTrajectoryStore({ path: tempDbPath() });

    store.upsertExternalSessionImport(
      importRecord({
        metadataJson:
          '{"path":"/home/node/.codex/sessions/raw.jsonl","key":"ANTHROPIC_API_KEY=sk-ant-secret"}',
        error: {
          code: 'external-source-unsupported',
          message: 'failed with sk-ant-secret at /home/node/.claude/projects/a.jsonl',
          retryable: false,
        },
      }),
    );

    const imported = store.getExternalSessionImport('imp-1');
    expect(imported?.metadataJson).not.toContain('sk-ant-secret');
    expect(imported?.metadataJson).not.toContain('/home/node');
    expect(imported?.metadataJson).toContain('ANTHROPIC_API_KEY=<redacted>');
    expect(imported?.error?.message).not.toContain('sk-ant-secret');
    expect(imported?.error?.message).toContain('~/.claude/projects/a.jsonl');
    store.close();
  });

  it('fails closed when durable link has no native session ref', () => {
    const store = new SqliteTrajectoryStore({ path: tempDbPath() });
    store.upsertExternalSessionImport(
      importRecord({ nativeSessionRef: undefined }),
    );

    try {
      store.linkExternalSession({
        importId: 'imp-1',
        sessionId: 'sess-1',
        linkedAt: '2026-06-23T09:01:00.000Z',
      });
      throw new Error('expected linkExternalSession to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TrajectoryStoreError);
      expect((error as TrajectoryStoreError).code).toBe(
        'native-resume-unavailable',
      );
    }
    expect(store.getExternalSessionImport('imp-1')).toMatchObject({
      state: 'registered',
    });
    store.close();
  });

  it('does not mutate durable imports when linking from an invalid state', () => {
    const store = new SqliteTrajectoryStore({ path: tempDbPath() });
    store.upsertExternalSessionImport(
      importRecord({
        state: 'rejected',
        linkedSessionId: undefined,
        linkedAt: undefined,
      }),
    );

    try {
      store.linkExternalSession({
        importId: 'imp-1',
        sessionId: 'sess-1',
        linkedAt: '2026-06-23T09:01:00.000Z',
      });
      throw new Error('expected linkExternalSession to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TrajectoryStoreError);
      expect((error as TrajectoryStoreError).code).toBe('invalid-import-state');
    }
    expect(store.getExternalSessionImport('imp-1')).toMatchObject({
      state: 'rejected',
    });
    expect(store.getExternalSessionImport('imp-1')).not.toHaveProperty(
      'linkedSessionId',
    );
    expect(store.getExternalSessionImport('imp-1')).not.toHaveProperty(
      'linkedAt',
    );
    store.close();
  });

  it('keeps provider payload refs only for redacted managed provider files', () => {
    const store = new SqliteTrajectoryStore({ path: tempDbPath() });

    store.recordProviderCallObservation(
      observation({
        observationId: 'obs-metadata',
        redactionState: 'metadata-only',
        requestBodyRef: 'trajectory/provider-calls/request.json',
        responseBodyRef: 'trajectory/provider-calls/response.json',
        streamFramesRef: 'trajectory/provider-calls/frames.jsonl',
      }),
    );
    store.recordProviderCallObservation(
      observation({
        observationId: 'obs-redacted',
        redactionState: 'redacted',
        requestBodyRef: 'trajectory/provider-calls/redacted-request.json',
      }),
    );

    expect(store.getProviderCallObservation('obs-metadata')).not.toHaveProperty(
      'requestBodyRef',
    );
    expect(store.getProviderCallObservation('obs-metadata')).not.toHaveProperty(
      'responseBodyRef',
    );
    expect(store.getProviderCallObservation('obs-metadata')).not.toHaveProperty(
      'streamFramesRef',
    );
    expect(store.getProviderCallObservation('obs-redacted')).toMatchObject({
      requestBodyRef: 'trajectory/provider-calls/redacted-request.json',
    });
    expect(() =>
      store.recordProviderCallObservation(
        observation({
          observationId: 'obs-bad',
          redactionState: 'redacted',
          requestBodyRef: 'trajectory/provider-calls/../../raw.json',
        }),
      ),
    ).toThrow(TrajectoryStoreError);
    store.close();
  });

  it('maps provider observation duplicate races to store errors', () => {
    const dbPath = tempDbPath();
    const setup = new SqliteTrajectoryStore({ path: dbPath });
    setup.close();
    const db = openDb(dbPath);
    db.prepare(
      `CREATE TRIGGER duplicate_provider_observation_before_insert
       BEFORE INSERT ON provider_call_observations
       WHEN NEW.observation_id = 'obs-race'
       BEGIN
         INSERT INTO provider_call_observations (
           observation_id,
           session_id,
           trace_id,
           backend,
           capture_mode,
           request_started_at,
           response_finished_at,
           provider_host,
           model,
           request_summary,
           response_summary,
           request_body_ref,
           response_body_ref,
           stream_frames_ref,
           request_bytes,
           response_bytes,
           redaction_state,
           alignment_json,
           error_code,
           metadata_json
         ) VALUES (
           NEW.observation_id,
           NEW.session_id,
           NEW.trace_id,
           NEW.backend,
           NEW.capture_mode,
           NEW.request_started_at,
           NEW.response_finished_at,
           NEW.provider_host,
           NEW.model,
           NEW.request_summary,
           NEW.response_summary,
           NEW.request_body_ref,
           NEW.response_body_ref,
           NEW.stream_frames_ref,
           NEW.request_bytes,
           NEW.response_bytes,
           NEW.redaction_state,
           NEW.alignment_json,
           NEW.error_code,
           NEW.metadata_json
         );
       END`,
    ).run();
    db.close();

    const store = new SqliteTrajectoryStore({ path: dbPath });
    try {
      store.recordProviderCallObservation(
        observation({ observationId: 'obs-race' }),
      );
      throw new Error('expected recordProviderCallObservation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TrajectoryStoreError);
      expect((error as TrajectoryStoreError).code).toBe('duplicate-record');
    }
    store.close();
  });

  it('prunes old provider observations and their provider-call segments', () => {
    const store = new SqliteTrajectoryStore({ path: tempDbPath() });
    store.recordProviderCallObservation(
      observation({
        observationId: 'obs-old',
        requestStartedAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    store.recordProviderCallObservation(
      observation({
        observationId: 'obs-new',
        requestStartedAt: '2026-06-20T00:00:00.000Z',
      }),
    );
    store.appendTrajectorySegment(
      segment({
        segmentId: 'seg-old-provider',
        importId: undefined,
        providerObservationId: 'obs-old',
        source: 'provider-call',
        kind: 'provider-request',
        sequence: 1,
      }),
    );
    store.appendTrajectorySegment(
      segment({
        segmentId: 'seg-new-provider',
        importId: undefined,
        providerObservationId: 'obs-new',
        source: 'provider-call',
        kind: 'provider-request',
        sequence: 2,
      }),
    );

    expect(
      store.pruneProviderCallObservations({
        before: '2026-06-01T00:00:00.000Z',
      }),
    ).toBe(1);

    expect(store.getProviderCallObservation('obs-old')).toBeUndefined();
    expect(store.getProviderCallObservation('obs-new')).toBeDefined();
    expect(
      store.queryTrajectory({ source: 'provider-call' }).segments.map((s) => s.segmentId),
    ).toEqual(['seg-new-provider']);
    store.close();
  });

  it('queries with stable keyset pagination and confidence filtering', () => {
    const store = new SqliteTrajectoryStore({ path: tempDbPath() });

    store.appendTrajectorySegment(
      segment({ segmentId: 'seg-1', sequence: 1, confidence: 'high' }),
    );
    store.appendTrajectorySegment(
      segment({ segmentId: 'seg-2', sequence: 2, confidence: 'unknown' }),
    );
    store.appendTrajectorySegment(
      segment({ segmentId: 'seg-3', sequence: 3, confidence: 'medium' }),
    );

    const firstPage = store.queryTrajectory({
      sessionId: 'sess-1',
      minConfidence: 'low',
      limit: 1,
    });
    expect(firstPage.segments.map((s) => s.segmentId)).toEqual(['seg-1']);
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = store.queryTrajectory({
      sessionId: 'sess-1',
      minConfidence: 'low',
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.segments.map((s) => s.segmentId)).toEqual(['seg-3']);
    expect(secondPage.nextCursor).toBeUndefined();
    store.close();
  });

  it('rejects invalid durable query limits and cursors', () => {
    const store = new SqliteTrajectoryStore({ path: tempDbPath() });

    expect(() => store.queryTrajectory({ limit: 0 })).toThrow(
      TrajectoryStoreError,
    );
    expect(() => store.queryTrajectory({ cursor: 'not-a-durable-cursor' }))
      .toThrow(TrajectoryStoreError);
    store.close();
  });

  it('fails closed for duplicate segments and unsafe content refs', () => {
    const store = new SqliteTrajectoryStore({ path: tempDbPath() });
    store.appendTrajectorySegment(segment({ segmentId: 'seg-1' }));

    expect(() => store.appendTrajectorySegment(segment({ segmentId: 'seg-1' })))
      .toThrow(TrajectoryStoreError);
    expect(() =>
      store.appendTrajectorySegment(
        segment({
          segmentId: 'seg-unsafe',
          contentRef: '/home/node/.codex/sessions/raw.jsonl',
        }),
      ),
    ).toThrow(TrajectoryStoreError);
    store.close();
  });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-nexus-trajectory-'));
  tempDirs.push(dir);
  return join(dir, 'state.db');
}

function openDb(path: string): BetterSqliteDatabase {
  const Database = require('better-sqlite3') as typeof DatabaseConstructor;
  return new Database(path);
}

function readSchemaVersion(db: BetterSqliteDatabase): number {
  const row = db
    .prepare(
      'SELECT version FROM trajectory_schema_version WHERE id = 1',
    )
    .get() as { version: number } | undefined;
  return row?.version ?? 0;
}

function createV1StateDb(path: string): void {
  const db = openDb(path);
  db.exec(`
    CREATE TABLE trajectory_schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO trajectory_schema_version (id, version, updated_at)
    VALUES (1, 1, '2026-08-21T00:00:00.000Z');

    CREATE TABLE external_session_imports (
      import_id TEXT PRIMARY KEY,
      source_adapter TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      source_path_hash TEXT NOT NULL,
      native_session_ref TEXT,
      linked_session_id TEXT,
      state TEXT NOT NULL,
      confidence TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      error_json TEXT,
      discovered_at TEXT NOT NULL,
      imported_at TEXT,
      linked_at TEXT
    );
    CREATE INDEX idx_external_session_imports_source
      ON external_session_imports(source_adapter, source_session_id);
    CREATE INDEX idx_external_session_imports_linked_session
      ON external_session_imports(linked_session_id);
    CREATE INDEX idx_external_session_imports_state
      ON external_session_imports(state, discovered_at DESC);
    INSERT INTO external_session_imports (
      import_id, source_adapter, source_session_id, source_path_hash,
      state, confidence, metadata_json, discovered_at
    ) VALUES (
      'imp-v1', 'codex-cli-jsonl', 'source-v1', 'sha256:v1',
      'registered', 'high', '{}', '2026-08-21T00:00:00.000Z'
    );

    CREATE TABLE trajectory_segments (
      segment_id TEXT PRIMARY KEY,
      session_id TEXT,
      import_id TEXT,
      provider_observation_id TEXT,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      trace_id TEXT,
      turn_sequence INTEGER,
      sequence INTEGER NOT NULL,
      ts TEXT NOT NULL,
      summary TEXT NOT NULL,
      content_ref TEXT,
      usage_event_id TEXT,
      log_anchor_json TEXT,
      confidence TEXT NOT NULL,
      redaction_state TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE INDEX idx_trajectory_segments_session
      ON trajectory_segments(session_id, ts, sequence);
    CREATE INDEX idx_trajectory_segments_import
      ON trajectory_segments(import_id, ts, sequence);
    CREATE INDEX idx_trajectory_segments_source_kind
      ON trajectory_segments(source, kind);
    CREATE TABLE provider_call_observations (
      observation_id TEXT PRIMARY KEY,
      session_id TEXT,
      trace_id TEXT,
      backend TEXT NOT NULL,
      capture_mode TEXT NOT NULL,
      request_started_at TEXT NOT NULL,
      response_finished_at TEXT,
      provider_host TEXT,
      model TEXT,
      request_summary TEXT NOT NULL,
      response_summary TEXT,
      request_body_ref TEXT,
      response_body_ref TEXT,
      stream_frames_ref TEXT,
      request_bytes INTEGER NOT NULL,
      response_bytes INTEGER,
      redaction_state TEXT NOT NULL,
      alignment_json TEXT NOT NULL,
      error_code TEXT,
      metadata_json TEXT NOT NULL
    );
    CREATE INDEX idx_provider_call_observations_session
      ON provider_call_observations(session_id, request_started_at);
    CREATE INDEX idx_provider_call_observations_backend
      ON provider_call_observations(backend, request_started_at);
  `);
  db.close();
}

function importRecord(
  overrides: Partial<ExternalSessionImportRecord> = {},
): ExternalSessionImportRecord {
  return {
    importId: 'imp-1',
    sourceAdapter: 'codex-cli-jsonl',
    sourceSessionId: 'source-1',
    sourcePathHash: 'sha256:path',
    nativeSessionRef: 'native-1',
    state: 'registered',
    confidence: 'high',
    metadataJson: '{}',
    discoveredAt: '2026-06-23T09:00:00.000Z',
    ...overrides,
  };
}

function segment(overrides: Partial<TrajectorySegment> = {}): TrajectorySegment {
  return {
    segmentId: 'seg-1',
    sessionId: 'sess-1',
    importId: 'imp-1',
    source: 'external-import',
    kind: 'user-message',
    sequence: 1,
    ts: '2026-06-23T09:00:00.000Z',
    summary: 'safe summary',
    contentRef: 'trajectory/imports/imp-1/seg-1.json',
    confidence: 'high',
    redactionState: 'redacted',
    metadataJson: '{}',
    ...overrides,
  };
}

function observation(
  overrides: Partial<ProviderCallObservation> = {},
): ProviderCallObservation {
  return {
    observationId: 'obs-1',
    sessionId: 'sess-1',
    traceId: 'trace-1',
    backend: 'codex',
    captureMode: 'transcript-only',
    requestStartedAt: '2026-06-23T09:00:00.000Z',
    responseFinishedAt: '2026-06-23T09:00:01.000Z',
    providerHost: 'api.openai.com',
    model: 'model-1',
    requestSummary: 'safe request',
    responseSummary: 'safe response',
    requestBytes: 10,
    responseBytes: 20,
    redactionState: 'metadata-only',
    alignment: { confidence: 'medium', turnSequence: 1, reasons: ['matched'] },
    metadataJson: '{}',
    ...overrides,
  };
}
