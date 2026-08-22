import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import { type Database as BetterSqliteDatabase } from 'better-sqlite3';

const require = createRequire(import.meta.url);
export const CURRENT_STATE_SCHEMA_VERSION = 3;

export type StateDatabaseErrorCode =
  | 'unsupported-schema-version'
  | 'invalid-schema';

export class StateDatabaseError extends Error {
  constructor(
    readonly code: StateDatabaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StateDatabaseError';
  }
}

export class SqliteStateDatabase {
  readonly database: BetterSqliteDatabase;

  constructor(input: { path: string }) {
    this.database = openStateDatabase(input.path);
  }

  close(): void {
    if (this.database.open) this.database.close();
  }
}

export function openStateDatabase(path: string): BetterSqliteDatabase {
  const Database = require('better-sqlite3') as typeof DatabaseConstructor;
  const database = new Database(path);
  try {
    initializeStateSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function initializeStateSchema(database: BetterSqliteDatabase): void {
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS trajectory_schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  let currentVersion = readSchemaVersion(database);
  if (currentVersion > CURRENT_STATE_SCHEMA_VERSION) {
    throw new StateDatabaseError(
      'unsupported-schema-version',
      `State schema version ${currentVersion} is newer than supported version ${CURRENT_STATE_SCHEMA_VERSION}`,
    );
  }
  if (currentVersion < 1) {
    database.transaction(() => {
      applySchemaV1(database);
      setSchemaVersion(database, 1);
    })();
    currentVersion = 1;
  }
  if (currentVersion < 2) {
    database.transaction(() => {
      applySchemaV2(database);
      setSchemaVersion(database, 2);
    })();
  }
  if (currentVersion < 3) {
    database.transaction(() => {
      applySchemaV3(database);
      setSchemaVersion(database, 3);
    })();
  }
  validateCurrentSchema(database);
}

function applySchemaV1(database: BetterSqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS external_session_imports (
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

    CREATE INDEX IF NOT EXISTS idx_external_session_imports_source
      ON external_session_imports(source_adapter, source_session_id);
    CREATE INDEX IF NOT EXISTS idx_external_session_imports_linked_session
      ON external_session_imports(linked_session_id);
    CREATE INDEX IF NOT EXISTS idx_external_session_imports_state
      ON external_session_imports(state, discovered_at DESC);

    CREATE TABLE IF NOT EXISTS trajectory_segments (
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

    CREATE INDEX IF NOT EXISTS idx_trajectory_segments_session
      ON trajectory_segments(session_id, ts, sequence);
    CREATE INDEX IF NOT EXISTS idx_trajectory_segments_import
      ON trajectory_segments(import_id, ts, sequence);
    CREATE INDEX IF NOT EXISTS idx_trajectory_segments_source_kind
      ON trajectory_segments(source, kind);

    CREATE TABLE IF NOT EXISTS provider_call_observations (
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

    CREATE INDEX IF NOT EXISTS idx_provider_call_observations_session
      ON provider_call_observations(session_id, request_started_at);
    CREATE INDEX IF NOT EXISTS idx_provider_call_observations_backend
      ON provider_call_observations(backend, request_started_at);
  `);
}

function applySchemaV2(database: BetterSqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
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
      meta_json TEXT,
      UNIQUE (session_key, generation)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_last_activity
      ON sessions(last_activity_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_key_generation
      ON sessions(session_key, generation DESC);
  `);
}

function applySchemaV3(database: BetterSqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS native_session_materializations (
      operation_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      native_session_ref TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      agent_owner TEXT NOT NULL,
      platform_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      parent_channel_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (
        state IN ('planned', 'container_created', 'linked', 'failed', 'ambiguous')
      ),
      thread_id TEXT,
      root_message_id TEXT,
      url TEXT,
      linked_session_id TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (
        profile_id, native_session_ref, agent_name, agent_owner,
        platform_name, platform, owner_user_id
      )
    );

    CREATE INDEX IF NOT EXISTS idx_native_session_materializations_state
      ON native_session_materializations(state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_native_session_materializations_linked_session
      ON native_session_materializations(linked_session_id);
  `);
}

function readSchemaVersion(database: BetterSqliteDatabase): number {
  try {
    const row = database
      .prepare('SELECT version FROM trajectory_schema_version WHERE id = 1')
      .get() as { version: number } | undefined;
    return row?.version ?? 0;
  } catch (error) {
    throw new StateDatabaseError(
      'invalid-schema',
      `State schema version table is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function setSchemaVersion(
  database: BetterSqliteDatabase,
  version: number,
): void {
  database
    .prepare(
      `INSERT INTO trajectory_schema_version (id, version, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version,
         updated_at = excluded.updated_at`,
    )
    .run(version, new Date().toISOString());
}

function validateCurrentSchema(database: BetterSqliteDatabase): void {
  for (const [table, columns] of Object.entries(REQUIRED_TABLE_SCHEMA)) {
    const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      type: string;
      notnull: 0 | 1;
      pk: 0 | 1;
    }>;
    const actual = new Map(rows.map((row) => [row.name, row]));
    const missing = Object.keys(columns).filter((column) => !actual.has(column));
    if (missing.length > 0) {
      throw new StateDatabaseError(
        'invalid-schema',
        `State schema table ${table} is missing required columns: ${missing.join(', ')}`,
      );
    }
    for (const [column, expected] of Object.entries(columns)) {
      const row = actual.get(column)!;
      if (
        row.type.toUpperCase() !== expected.type ||
        row.notnull !== (expected.notNull ? 1 : 0) ||
        row.pk !== (expected.primaryKey ? 1 : 0)
      ) {
        throw new StateDatabaseError(
          'invalid-schema',
          `State schema column ${table}.${column} has incompatible type or constraints`,
        );
      }
    }
  }
  validateIndex(database, 'external_session_imports', [
    'source_adapter',
    'source_session_id',
  ]);
  validateIndex(database, 'external_session_imports', ['linked_session_id']);
  validateIndex(database, 'external_session_imports', [
    'state',
    'discovered_at',
  ]);
  validateIndex(database, 'trajectory_segments', [
    'session_id',
    'ts',
    'sequence',
  ]);
  validateIndex(database, 'trajectory_segments', [
    'import_id',
    'ts',
    'sequence',
  ]);
  validateIndex(database, 'trajectory_segments', ['source', 'kind']);
  validateIndex(database, 'provider_call_observations', [
    'session_id',
    'request_started_at',
  ]);
  validateIndex(database, 'provider_call_observations', [
    'backend',
    'request_started_at',
  ]);
  validateIndex(database, 'sessions', ['last_activity_at']);
  validateIndex(database, 'sessions', ['session_key', 'generation']);
  validateIndex(
    database,
    'sessions',
    ['session_key', 'generation'],
    true,
  );
  validateIndex(database, 'native_session_materializations', [
    'state',
    'updated_at',
  ]);
  validateIndex(database, 'native_session_materializations', [
    'linked_session_id',
  ]);
  validateIndex(
    database,
    'native_session_materializations',
    ['idempotency_key'],
    true,
  );
  validateIndex(
    database,
    'native_session_materializations',
    [
      'profile_id',
      'native_session_ref',
      'agent_name',
      'agent_owner',
      'platform_name',
      'platform',
      'owner_user_id',
    ],
    true,
  );
}

interface RequiredColumnSchema {
  type: 'TEXT' | 'INTEGER' | 'REAL';
  notNull?: boolean;
  primaryKey?: boolean;
}

const text = (notNull = false): RequiredColumnSchema => ({
  type: 'TEXT',
  ...(notNull ? { notNull: true } : {}),
});
const integer = (notNull = false): RequiredColumnSchema => ({
  type: 'INTEGER',
  ...(notNull ? { notNull: true } : {}),
});
const real = (): RequiredColumnSchema => ({ type: 'REAL' });
const textPrimaryKey = (): RequiredColumnSchema => ({
  type: 'TEXT',
  primaryKey: true,
});

const REQUIRED_TABLE_SCHEMA: Record<
  string,
  Record<string, RequiredColumnSchema>
> = {
  trajectory_schema_version: {
    id: { type: 'INTEGER', primaryKey: true },
    version: integer(true),
    updated_at: text(true),
  },
  external_session_imports: {
    import_id: textPrimaryKey(),
    source_adapter: text(true),
    source_session_id: text(true),
    source_path_hash: text(true),
    native_session_ref: text(),
    linked_session_id: text(),
    state: text(true),
    confidence: text(true),
    metadata_json: text(true),
    error_json: text(),
    discovered_at: text(true),
    imported_at: text(),
    linked_at: text(),
  },
  trajectory_segments: {
    segment_id: textPrimaryKey(),
    session_id: text(),
    import_id: text(),
    provider_observation_id: text(),
    source: text(true),
    kind: text(true),
    trace_id: text(),
    turn_sequence: integer(),
    sequence: integer(true),
    ts: text(true),
    summary: text(true),
    content_ref: text(),
    usage_event_id: text(),
    log_anchor_json: text(),
    confidence: text(true),
    redaction_state: text(true),
    metadata_json: text(true),
  },
  provider_call_observations: {
    observation_id: textPrimaryKey(),
    session_id: text(),
    trace_id: text(),
    backend: text(true),
    capture_mode: text(true),
    request_started_at: text(true),
    response_finished_at: text(),
    provider_host: text(),
    model: text(),
    request_summary: text(true),
    response_summary: text(),
    request_body_ref: text(),
    response_body_ref: text(),
    stream_frames_ref: text(),
    request_bytes: integer(true),
    response_bytes: integer(),
    redaction_state: text(true),
    alignment_json: text(true),
    error_code: text(),
    metadata_json: text(true),
  },
  sessions: {
    session_id: textPrimaryKey(),
    session_key: text(true),
    generation: integer(true),
    state: text(true),
    created_at: text(true),
    last_activity_at: text(true),
    archived_at: text(),
    agent_backend: text(true),
    agent_conversation_ref: text(),
    working_dir: text(true),
    next_session_json: text(),
    transcript_path: text(true),
    turns_used: integer(true),
    tool_calls_used: integer(true),
    wall_clock_ms: integer(true),
    tokens_used: integer(true),
    cost_used_usd: real(),
    budget_limit_usd: real(),
    meta_json: text(),
  },
  native_session_materializations: {
    operation_id: textPrimaryKey(),
    profile_id: text(true),
    native_session_ref: text(true),
    agent_name: text(true),
    agent_owner: text(true),
    platform_name: text(true),
    platform: text(true),
    parent_channel_id: text(true),
    owner_user_id: text(true),
    idempotency_key: text(true),
    state: text(true),
    thread_id: text(),
    root_message_id: text(),
    url: text(),
    linked_session_id: text(),
    error_code: text(),
    created_at: text(true),
    updated_at: text(true),
  },
};

function validateIndex(
  database: BetterSqliteDatabase,
  table: string,
  expectedColumns: string[],
  unique = false,
): void {
  const indexes = database.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: 0 | 1;
    partial: 0 | 1;
  }>;
  const found = indexes.some((index) => {
    if (Boolean(index.unique) !== unique || index.partial) return false;
    const columns = database
      .prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`)
      .all() as Array<{ seqno: number; name: string }>;
    return columns
      .sort((a, b) => a.seqno - b.seqno)
      .map((column) => column.name)
      .every((column, index) => column === expectedColumns[index]) &&
      columns.length === expectedColumns.length;
  });
  if (!found) {
    throw new StateDatabaseError(
      'invalid-schema',
      `State schema table ${table} is missing ${unique ? 'unique ' : ''}index (${expectedColumns.join(', ')})`,
    );
  }
}
