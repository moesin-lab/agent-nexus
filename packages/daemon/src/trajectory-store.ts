import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import { BasicRedactor, type Redactor } from './redaction.js';

const require = createRequire(import.meta.url);

export type TrajectoryConfidence = 'high' | 'medium' | 'low' | 'unknown';

export function confidenceMeetsMinimum(
  confidence: TrajectoryConfidence,
  minimum: TrajectoryConfidence | undefined,
): boolean {
  if (minimum === undefined) return true;
  if (confidence === 'unknown') return false;
  return confidenceRank(confidence) >= confidenceRank(minimum);
}

export type ExternalSessionImportState =
  | 'discovered'
  | 'registered'
  | 'imported'
  | 'linked'
  | 'rejected'
  | 'failed'
  | 'retired';

export interface TrajectoryImportError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ExternalSessionImportRecord {
  importId: string;
  sourceAdapter: string;
  sourceSessionId: string;
  sourcePathHash: string;
  nativeSessionRef?: string;
  linkedSessionId?: string;
  state: ExternalSessionImportState;
  confidence: TrajectoryConfidence;
  metadataJson: string;
  error?: TrajectoryImportError;
  discoveredAt: string;
  importedAt?: string;
  linkedAt?: string;
}

export interface LinkExternalSessionInput {
  importId: string;
  sessionId: string;
  nativeSessionRef?: string;
  linkedAt: string;
}

export interface ExternalResumeBinding {
  sessionId: string;
  importId: string;
  sourceAdapter: string;
  sourceSessionId: string;
  nativeSessionRef: string;
  confidence: TrajectoryConfidence;
  linkedAt: string;
}

export type TrajectorySegmentSource =
  | 'nexus-agent-event'
  | 'external-import'
  | 'provider-call';

export type TrajectorySegmentKind =
  | 'user-message'
  | 'agent-message'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'usage'
  | 'provider-request'
  | 'provider-response'
  | 'state-change'
  | 'unknown';

export type TrajectoryRedactionState =
  | 'redacted'
  | 'metadata-only'
  | 'dropped';

export interface TrajectoryLogAnchor {
  logFile?: string;
  byteOffset?: number;
  event?: string;
}

export interface TrajectorySegment {
  segmentId: string;
  sessionId?: string;
  importId?: string;
  providerObservationId?: string;
  source: TrajectorySegmentSource;
  kind: TrajectorySegmentKind;
  traceId?: string;
  turnSequence?: number;
  sequence: number;
  ts: string;
  summary: string;
  contentRef?: string;
  usageEventId?: string;
  logAnchor?: TrajectoryLogAnchor;
  confidence: TrajectoryConfidence;
  redactionState: TrajectoryRedactionState;
  metadataJson: string;
}

export interface ProviderTurnAlignment {
  confidence: TrajectoryConfidence;
  turnSequence?: number;
  agentEventSequence?: number;
  reasons: string[];
}

export interface ProviderCallObservation {
  observationId: string;
  sessionId?: string;
  traceId?: string;
  backend: 'claudecode' | 'codex' | string;
  captureMode: 'reverse-proxy' | 'forward-proxy' | 'transcript-only';
  requestStartedAt: string;
  responseFinishedAt?: string;
  providerHost?: string;
  model?: string;
  requestSummary: string;
  responseSummary?: string;
  requestBodyRef?: string;
  responseBodyRef?: string;
  streamFramesRef?: string;
  requestBytes: number;
  responseBytes?: number;
  redactionState: TrajectoryRedactionState;
  alignment: ProviderTurnAlignment;
  errorCode?: string;
  metadataJson: string;
}

export interface TrajectoryQuery {
  sessionId?: string;
  importId?: string;
  source?: TrajectorySegmentSource;
  kinds?: TrajectorySegmentKind[];
  since?: string;
  until?: string;
  minConfidence?: TrajectoryConfidence;
  includeContent?: boolean;
  limit?: number;
  cursor?: string;
}

export interface TrajectoryPage {
  segments: TrajectorySegment[];
  nextCursor?: string;
}

export interface TrajectoryStore {
  upsertExternalSessionImport(record: ExternalSessionImportRecord): void;
  getExternalSessionImport(
    importId: string,
  ): ExternalSessionImportRecord | undefined;
  linkExternalSession(input: LinkExternalSessionInput): ExternalResumeBinding;
  appendTrajectorySegment(segment: TrajectorySegment): void;
  recordProviderCallObservation(observation: ProviderCallObservation): void;
  getProviderCallObservation(
    observationId: string,
  ): ProviderCallObservation | undefined;
  queryTrajectory(query: TrajectoryQuery): TrajectoryPage;
}

export type TrajectoryStoreErrorCode =
  | 'external-import-not-found'
  | 'native-resume-unavailable'
  | 'invalid-content-ref'
  | 'invalid-import-state'
  | 'invalid-query'
  | 'duplicate-record';

export class TrajectoryStoreError extends Error {
  constructor(
    readonly code: TrajectoryStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TrajectoryStoreError';
  }
}

export class InMemoryTrajectoryStore implements TrajectoryStore {
  private readonly imports = new Map<string, ExternalSessionImportRecord>();
  private readonly segments = new Map<string, TrajectorySegment>();
  private readonly observations = new Map<string, ProviderCallObservation>();
  private readonly redactor: Redactor;

  constructor(input: { redactor?: Redactor } = {}) {
    this.redactor = input.redactor ?? new BasicRedactor();
  }

  upsertExternalSessionImport(record: ExternalSessionImportRecord): void {
    this.imports.set(record.importId, this.cloneImport(record));
  }

  getExternalSessionImport(
    importId: string,
  ): ExternalSessionImportRecord | undefined {
    const record = this.imports.get(importId);
    return record ? this.cloneImport(record) : undefined;
  }

  linkExternalSession(input: LinkExternalSessionInput): ExternalResumeBinding {
    const existing = this.imports.get(input.importId);
    if (!existing) {
      throw new TrajectoryStoreError(
        'external-import-not-found',
        `External import ${input.importId} was not found`,
      );
    }

    const nativeSessionRef = input.nativeSessionRef ?? existing.nativeSessionRef;
    if (!nativeSessionRef) {
      throw new TrajectoryStoreError(
        'native-resume-unavailable',
        `External import ${input.importId} has no native session ref`,
      );
    }
    if (existing.state !== 'registered' && existing.state !== 'imported') {
      throw new TrajectoryStoreError(
        'invalid-import-state',
        `External import ${input.importId} cannot be linked from state ${existing.state}`,
      );
    }

    const linked: ExternalSessionImportRecord = {
      ...existing,
      nativeSessionRef,
      linkedSessionId: input.sessionId,
      state: 'linked',
      linkedAt: input.linkedAt,
    };
    this.imports.set(input.importId, linked);

    return {
      sessionId: input.sessionId,
      importId: linked.importId,
      sourceAdapter: linked.sourceAdapter,
      sourceSessionId: linked.sourceSessionId,
      nativeSessionRef,
      confidence: linked.confidence,
      linkedAt: input.linkedAt,
    };
  }

  appendTrajectorySegment(segment: TrajectorySegment): void {
    if (this.segments.has(segment.segmentId)) {
      throw new TrajectoryStoreError(
        'duplicate-record',
        `Trajectory segment ${segment.segmentId} already exists`,
      );
    }
    if (segment.redactionState === 'dropped' && segment.contentRef) {
      throw new TrajectoryStoreError(
        'invalid-content-ref',
        'Trajectory segment with dropped redaction state cannot keep contentRef',
      );
    }
    if (segment.contentRef) assertManagedContentRef(segment.contentRef);

    this.segments.set(segment.segmentId, this.cloneSegment(segment));
  }

  recordProviderCallObservation(observation: ProviderCallObservation): void {
    if (this.observations.has(observation.observationId)) {
      throw new TrajectoryStoreError(
        'duplicate-record',
        `Provider observation ${observation.observationId} already exists`,
      );
    }
    const next = this.cloneObservation(observation);
    if (next.redactionState !== 'redacted') {
      delete next.requestBodyRef;
      delete next.responseBodyRef;
      delete next.streamFramesRef;
    } else {
      if (next.requestBodyRef) assertManagedProviderRef(next.requestBodyRef);
      if (next.responseBodyRef) assertManagedProviderRef(next.responseBodyRef);
      if (next.streamFramesRef) assertManagedProviderRef(next.streamFramesRef);
    }
    this.observations.set(next.observationId, next);
  }

  getProviderCallObservation(
    observationId: string,
  ): ProviderCallObservation | undefined {
    const observation = this.observations.get(observationId);
    return observation ? this.cloneObservation(observation) : undefined;
  }

  queryTrajectory(query: TrajectoryQuery): TrajectoryPage {
    const limit = normalizeLimit(query.limit);
    // Offset cursor is the in-memory scaffold; durable storage should use keyset.
    const cursor = normalizeCursor(query.cursor);
    const kinds = query.kinds ? new Set(query.kinds) : undefined;
    // Content dereference is intentionally out of scope for this scaffold.
    void query.includeContent;

    const filtered = [...this.segments.values()]
      .filter((segment) => {
        if (query.sessionId && segment.sessionId !== query.sessionId) return false;
        if (query.importId && segment.importId !== query.importId) return false;
        if (query.source && segment.source !== query.source) return false;
        if (kinds && !kinds.has(segment.kind)) return false;
        if (query.since && segment.ts < query.since) return false;
        if (query.until && segment.ts > query.until) return false;
        return confidenceMeetsMinimum(segment.confidence, query.minConfidence);
      })
      .sort(compareSegments);

    const page = filtered.slice(cursor, cursor + limit);
    const nextCursor =
      cursor + limit < filtered.length ? String(cursor + limit) : undefined;

    return {
      segments: page.map((segment) => this.cloneSegment(segment)),
      nextCursor,
    };
  }

  private cloneImport(record: ExternalSessionImportRecord): ExternalSessionImportRecord {
    // Clone helpers redact at the Store boundary and again on read as defense in depth.
    return {
      ...record,
      metadataJson: this.redact(record.metadataJson),
      error: record.error
        ? {
            ...record.error,
            message: this.redact(record.error.message),
          }
        : undefined,
    };
  }

  private cloneSegment(segment: TrajectorySegment): TrajectorySegment {
    return {
      ...segment,
      summary: this.redact(segment.summary),
      logAnchor: segment.logAnchor ? { ...segment.logAnchor } : undefined,
      metadataJson: this.redact(segment.metadataJson),
    };
  }

  private cloneObservation(
    observation: ProviderCallObservation,
  ): ProviderCallObservation {
    return {
      ...observation,
      requestSummary: this.redact(observation.requestSummary),
      responseSummary: observation.responseSummary
        ? this.redact(observation.responseSummary)
        : undefined,
      alignment: {
        ...observation.alignment,
        reasons: [...observation.alignment.reasons],
      },
      metadataJson: this.redact(observation.metadataJson),
    };
  }

  private redact(value: string): string {
    return this.redactor.redact(value);
  }
}

export interface SqliteTrajectoryStoreInput {
  path?: string;
  database?: BetterSqliteDatabase;
  redactor?: Redactor;
}

export class SqliteTrajectoryStore implements TrajectoryStore {
  private readonly db: BetterSqliteDatabase;
  private readonly ownsDatabase: boolean;
  private readonly redactor: Redactor;

  constructor(input: SqliteTrajectoryStoreInput = {}) {
    this.db = input.database ?? createSqliteDatabase(input.path ?? ':memory:');
    this.ownsDatabase = input.database === undefined;
    this.redactor = input.redactor ?? new BasicRedactor();
    initializeTrajectorySchema(this.db);
  }

  close(): void {
    if (this.ownsDatabase && this.db.open) this.db.close();
  }

  upsertExternalSessionImport(record: ExternalSessionImportRecord): void {
    const next = this.cloneImport(record);
    this.db
      .prepare(
        `INSERT INTO external_session_imports (
          import_id,
          source_adapter,
          source_session_id,
          source_path_hash,
          native_session_ref,
          linked_session_id,
          state,
          confidence,
          metadata_json,
          error_json,
          discovered_at,
          imported_at,
          linked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(import_id) DO UPDATE SET
          source_adapter = excluded.source_adapter,
          source_session_id = excluded.source_session_id,
          source_path_hash = excluded.source_path_hash,
          native_session_ref = excluded.native_session_ref,
          linked_session_id = excluded.linked_session_id,
          state = excluded.state,
          confidence = excluded.confidence,
          metadata_json = excluded.metadata_json,
          error_json = excluded.error_json,
          discovered_at = excluded.discovered_at,
          imported_at = excluded.imported_at,
          linked_at = excluded.linked_at`,
      )
      .run(
        next.importId,
        next.sourceAdapter,
        next.sourceSessionId,
        next.sourcePathHash,
        next.nativeSessionRef ?? null,
        next.linkedSessionId ?? null,
        next.state,
        next.confidence,
        next.metadataJson,
        next.error ? JSON.stringify(next.error) : null,
        next.discoveredAt,
        next.importedAt ?? null,
        next.linkedAt ?? null,
      );
  }

  getExternalSessionImport(
    importId: string,
  ): ExternalSessionImportRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM external_session_imports WHERE import_id = ?')
      .get(importId) as ExternalSessionImportRow | undefined;
    return row ? this.cloneImport(importFromRow(row)) : undefined;
  }

  linkExternalSession(input: LinkExternalSessionInput): ExternalResumeBinding {
    return this.db.transaction((linkInput: LinkExternalSessionInput) => {
      const existing = this.getExternalSessionImport(linkInput.importId);
      if (!existing) {
        throw new TrajectoryStoreError(
          'external-import-not-found',
          `External import ${linkInput.importId} was not found`,
        );
      }

      const nativeSessionRef =
        linkInput.nativeSessionRef ?? existing.nativeSessionRef;
      if (!nativeSessionRef) {
        throw new TrajectoryStoreError(
          'native-resume-unavailable',
          `External import ${linkInput.importId} has no native session ref`,
        );
      }
      if (existing.state !== 'registered' && existing.state !== 'imported') {
        throw new TrajectoryStoreError(
          'invalid-import-state',
          `External import ${linkInput.importId} cannot be linked from state ${existing.state}`,
        );
      }

      this.db
        .prepare(
          `UPDATE external_session_imports
           SET native_session_ref = ?,
               linked_session_id = ?,
               state = 'linked',
               linked_at = ?
           WHERE import_id = ?`,
        )
        .run(
          nativeSessionRef,
          linkInput.sessionId,
          linkInput.linkedAt,
          linkInput.importId,
        );

      return {
        sessionId: linkInput.sessionId,
        importId: existing.importId,
        sourceAdapter: existing.sourceAdapter,
        sourceSessionId: existing.sourceSessionId,
        nativeSessionRef,
        confidence: existing.confidence,
        linkedAt: linkInput.linkedAt,
      };
    })(input);
  }

  appendTrajectorySegment(segment: TrajectorySegment): void {
    if (this.hasRecord('trajectory_segments', 'segment_id', segment.segmentId)) {
      throw new TrajectoryStoreError(
        'duplicate-record',
        `Trajectory segment ${segment.segmentId} already exists`,
      );
    }
    if (segment.redactionState === 'dropped' && segment.contentRef) {
      throw new TrajectoryStoreError(
        'invalid-content-ref',
        'Trajectory segment with dropped redaction state cannot keep contentRef',
      );
    }
    if (segment.contentRef) assertManagedContentRef(segment.contentRef);

    const next = this.cloneSegment(segment);
    this.db
      .prepare(
        `INSERT INTO trajectory_segments (
          segment_id,
          session_id,
          import_id,
          provider_observation_id,
          source,
          kind,
          trace_id,
          turn_sequence,
          sequence,
          ts,
          summary,
          content_ref,
          usage_event_id,
          log_anchor_json,
          confidence,
          redaction_state,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        next.segmentId,
        next.sessionId ?? null,
        next.importId ?? null,
        next.providerObservationId ?? null,
        next.source,
        next.kind,
        next.traceId ?? null,
        next.turnSequence ?? null,
        next.sequence,
        next.ts,
        next.summary,
        next.contentRef ?? null,
        next.usageEventId ?? null,
        next.logAnchor ? JSON.stringify(next.logAnchor) : null,
        next.confidence,
        next.redactionState,
        next.metadataJson,
      );
  }

  recordProviderCallObservation(observation: ProviderCallObservation): void {
    if (
      this.hasRecord(
        'provider_call_observations',
        'observation_id',
        observation.observationId,
      )
    ) {
      throw new TrajectoryStoreError(
        'duplicate-record',
        `Provider observation ${observation.observationId} already exists`,
      );
    }

    const next = this.cloneObservation(observation);
    if (next.redactionState !== 'redacted') {
      delete next.requestBodyRef;
      delete next.responseBodyRef;
      delete next.streamFramesRef;
    } else {
      if (next.requestBodyRef) assertManagedProviderRef(next.requestBodyRef);
      if (next.responseBodyRef) assertManagedProviderRef(next.responseBodyRef);
      if (next.streamFramesRef) assertManagedProviderRef(next.streamFramesRef);
    }

    this.db
      .prepare(
        `INSERT INTO provider_call_observations (
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        next.observationId,
        next.sessionId ?? null,
        next.traceId ?? null,
        next.backend,
        next.captureMode,
        next.requestStartedAt,
        next.responseFinishedAt ?? null,
        next.providerHost ?? null,
        next.model ?? null,
        next.requestSummary,
        next.responseSummary ?? null,
        next.requestBodyRef ?? null,
        next.responseBodyRef ?? null,
        next.streamFramesRef ?? null,
        next.requestBytes,
        next.responseBytes ?? null,
        next.redactionState,
        JSON.stringify(next.alignment),
        next.errorCode ?? null,
        next.metadataJson,
      );
  }

  getProviderCallObservation(
    observationId: string,
  ): ProviderCallObservation | undefined {
    const row = this.db
      .prepare('SELECT * FROM provider_call_observations WHERE observation_id = ?')
      .get(observationId) as ProviderCallObservationRow | undefined;
    return row ? this.cloneObservation(observationFromRow(row)) : undefined;
  }

  queryTrajectory(query: TrajectoryQuery): TrajectoryPage {
    const limit = normalizeLimit(query.limit);
    const cursor = decodeTrajectoryCursor(query.cursor);
    const { whereSql, values } = buildTrajectoryWhere(query, cursor);
    // Content dereference stays out of this durable read-model store; callers only get redacted anchors here.
    void query.includeContent;

    const rows = this.db
      .prepare(
        `SELECT * FROM trajectory_segments
         ${whereSql}
         ORDER BY ts ASC, sequence ASC, segment_id ASC
         LIMIT ?`,
      )
      .all(...values, limit + 1) as TrajectorySegmentRow[];

    const pageRows = rows.slice(0, limit);
    const segments = pageRows.map((row) => this.cloneSegment(segmentFromRow(row)));
    const last = pageRows.at(-1);

    return {
      segments,
      nextCursor:
        rows.length > limit && last
          ? encodeTrajectoryCursor({
              ts: last.ts,
              sequence: last.sequence,
              segmentId: last.segment_id,
            })
          : undefined,
    };
  }

  private hasRecord(
    table: 'trajectory_segments' | 'provider_call_observations',
    column: 'segment_id' | 'observation_id',
    id: string,
  ): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS found FROM ${table} WHERE ${column} = ?`)
      .get(id) as { found: 1 } | undefined;
    return row !== undefined;
  }

  private cloneImport(record: ExternalSessionImportRecord): ExternalSessionImportRecord {
    return {
      ...record,
      metadataJson: this.redact(record.metadataJson),
      error: record.error
        ? {
            ...record.error,
            message: this.redact(record.error.message),
          }
        : undefined,
    };
  }

  private cloneSegment(segment: TrajectorySegment): TrajectorySegment {
    return {
      ...segment,
      summary: this.redact(segment.summary),
      logAnchor: segment.logAnchor ? { ...segment.logAnchor } : undefined,
      metadataJson: this.redact(segment.metadataJson),
    };
  }

  private cloneObservation(
    observation: ProviderCallObservation,
  ): ProviderCallObservation {
    return {
      ...observation,
      requestSummary: this.redact(observation.requestSummary),
      responseSummary: observation.responseSummary
        ? this.redact(observation.responseSummary)
        : undefined,
      alignment: {
        ...observation.alignment,
        reasons: [...observation.alignment.reasons],
      },
      metadataJson: this.redact(observation.metadataJson),
    };
  }

  private redact(value: string): string {
    return this.redactor.redact(value);
  }
}

function createSqliteDatabase(path: string): BetterSqliteDatabase {
  const Database = require('better-sqlite3') as typeof DatabaseConstructor;
  return new Database(path);
}

interface ExternalSessionImportRow {
  import_id: string;
  source_adapter: string;
  source_session_id: string;
  source_path_hash: string;
  native_session_ref: string | null;
  linked_session_id: string | null;
  state: ExternalSessionImportState;
  confidence: TrajectoryConfidence;
  metadata_json: string;
  error_json: string | null;
  discovered_at: string;
  imported_at: string | null;
  linked_at: string | null;
}

interface TrajectorySegmentRow {
  segment_id: string;
  session_id: string | null;
  import_id: string | null;
  provider_observation_id: string | null;
  source: TrajectorySegmentSource;
  kind: TrajectorySegmentKind;
  trace_id: string | null;
  turn_sequence: number | null;
  sequence: number;
  ts: string;
  summary: string;
  content_ref: string | null;
  usage_event_id: string | null;
  log_anchor_json: string | null;
  confidence: TrajectoryConfidence;
  redaction_state: TrajectoryRedactionState;
  metadata_json: string;
}

interface ProviderCallObservationRow {
  observation_id: string;
  session_id: string | null;
  trace_id: string | null;
  backend: string;
  capture_mode: ProviderCallObservation['captureMode'];
  request_started_at: string;
  response_finished_at: string | null;
  provider_host: string | null;
  model: string | null;
  request_summary: string;
  response_summary: string | null;
  request_body_ref: string | null;
  response_body_ref: string | null;
  stream_frames_ref: string | null;
  request_bytes: number;
  response_bytes: number | null;
  redaction_state: TrajectoryRedactionState;
  alignment_json: string;
  error_code: string | null;
  metadata_json: string;
}

interface SqliteTrajectoryCursor {
  ts: string;
  sequence: number;
  segmentId: string;
}

function initializeTrajectorySchema(db: BetterSqliteDatabase): void {
  // The initial trajectory tables keep nullable cross-links application-owned until sessions/usage are durable.
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`
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

function importFromRow(row: ExternalSessionImportRow): ExternalSessionImportRecord {
  const record: ExternalSessionImportRecord = {
    importId: row.import_id,
    sourceAdapter: row.source_adapter,
    sourceSessionId: row.source_session_id,
    sourcePathHash: row.source_path_hash,
    state: row.state,
    confidence: row.confidence,
    metadataJson: row.metadata_json,
    discoveredAt: row.discovered_at,
  };
  if (row.native_session_ref !== null) record.nativeSessionRef = row.native_session_ref;
  if (row.linked_session_id !== null) record.linkedSessionId = row.linked_session_id;
  if (row.error_json !== null) record.error = parseImportError(row.error_json);
  if (row.imported_at !== null) record.importedAt = row.imported_at;
  if (row.linked_at !== null) record.linkedAt = row.linked_at;
  return record;
}

function segmentFromRow(row: TrajectorySegmentRow): TrajectorySegment {
  const segment: TrajectorySegment = {
    segmentId: row.segment_id,
    source: row.source,
    kind: row.kind,
    sequence: row.sequence,
    ts: row.ts,
    summary: row.summary,
    confidence: row.confidence,
    redactionState: row.redaction_state,
    metadataJson: row.metadata_json,
  };
  if (row.session_id !== null) segment.sessionId = row.session_id;
  if (row.import_id !== null) segment.importId = row.import_id;
  if (row.provider_observation_id !== null) {
    segment.providerObservationId = row.provider_observation_id;
  }
  if (row.trace_id !== null) segment.traceId = row.trace_id;
  if (row.turn_sequence !== null) segment.turnSequence = row.turn_sequence;
  if (row.content_ref !== null) segment.contentRef = row.content_ref;
  if (row.usage_event_id !== null) segment.usageEventId = row.usage_event_id;
  if (row.log_anchor_json !== null) {
    segment.logAnchor = parseLogAnchor(row.log_anchor_json);
  }
  return segment;
}

function observationFromRow(
  row: ProviderCallObservationRow,
): ProviderCallObservation {
  const observation: ProviderCallObservation = {
    observationId: row.observation_id,
    backend: row.backend,
    captureMode: row.capture_mode,
    requestStartedAt: row.request_started_at,
    requestSummary: row.request_summary,
    requestBytes: row.request_bytes,
    redactionState: row.redaction_state,
    alignment: parseProviderAlignment(row.alignment_json),
    metadataJson: row.metadata_json,
  };
  if (row.session_id !== null) observation.sessionId = row.session_id;
  if (row.trace_id !== null) observation.traceId = row.trace_id;
  if (row.response_finished_at !== null) {
    observation.responseFinishedAt = row.response_finished_at;
  }
  if (row.provider_host !== null) observation.providerHost = row.provider_host;
  if (row.model !== null) observation.model = row.model;
  if (row.response_summary !== null) observation.responseSummary = row.response_summary;
  if (row.request_body_ref !== null) observation.requestBodyRef = row.request_body_ref;
  if (row.response_body_ref !== null) observation.responseBodyRef = row.response_body_ref;
  if (row.stream_frames_ref !== null) observation.streamFramesRef = row.stream_frames_ref;
  if (row.response_bytes !== null) observation.responseBytes = row.response_bytes;
  if (row.error_code !== null) observation.errorCode = row.error_code;
  return observation;
}

function buildTrajectoryWhere(
  query: TrajectoryQuery,
  cursor: SqliteTrajectoryCursor | undefined,
): { whereSql: string; values: Array<string | number> } {
  const predicates: string[] = [];
  const values: Array<string | number> = [];
  const kinds = query.kinds;

  if (query.sessionId) addPredicate('session_id = ?', query.sessionId);
  if (query.importId) addPredicate('import_id = ?', query.importId);
  if (query.source) addPredicate('source = ?', query.source);
  if (kinds && kinds.length > 0) {
    predicates.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
    values.push(...kinds);
  }
  if (kinds && kinds.length === 0) predicates.push('0 = 1');
  if (query.since) addPredicate('ts >= ?', query.since);
  if (query.until) addPredicate('ts <= ?', query.until);
  if (query.minConfidence !== undefined) {
    const allowed = confidenceValuesAtLeast(query.minConfidence);
    predicates.push(`confidence IN (${allowed.map(() => '?').join(', ')})`);
    values.push(...allowed);
  }
  if (cursor) {
    predicates.push(
      '(ts > ? OR (ts = ? AND sequence > ?) OR (ts = ? AND sequence = ? AND segment_id > ?))',
    );
    values.push(
      cursor.ts,
      cursor.ts,
      cursor.sequence,
      cursor.ts,
      cursor.sequence,
      cursor.segmentId,
    );
  }

  return {
    whereSql: predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '',
    values,
  };

  function addPredicate(sql: string, value: string): void {
    predicates.push(sql);
    values.push(value);
  }
}

function confidenceValuesAtLeast(
  minimum: TrajectoryConfidence,
): TrajectoryConfidence[] {
  return (['high', 'medium', 'low'] as const).filter((confidence) =>
    confidenceMeetsMinimum(confidence, minimum),
  );
}

function encodeTrajectoryCursor(cursor: SqliteTrajectoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeTrajectoryCursor(
  cursor: string | undefined,
): SqliteTrajectoryCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<SqliteTrajectoryCursor>;
    if (
      typeof parsed.ts === 'string' &&
      typeof parsed.sequence === 'number' &&
      Number.isInteger(parsed.sequence) &&
      typeof parsed.segmentId === 'string'
    ) {
      return {
        ts: parsed.ts,
        sequence: parsed.sequence,
        segmentId: parsed.segmentId,
      };
    }
  } catch {
    // Fall through to the stable store error below.
  }
  throw new TrajectoryStoreError(
    'invalid-query',
    'Trajectory query cursor is not a valid durable cursor',
  );
}

function parseImportError(value: string): TrajectoryImportError {
  const parsed = parseJsonObject(value, 'import error');
  if (
    typeof parsed.code === 'string' &&
    typeof parsed.message === 'string' &&
    typeof parsed.retryable === 'boolean'
  ) {
    return {
      code: parsed.code,
      message: parsed.message,
      retryable: parsed.retryable,
    };
  }
  throw invalidStoredJson('import error');
}

function parseLogAnchor(value: string): TrajectoryLogAnchor {
  const parsed = parseJsonObject(value, 'trajectory log anchor');
  const anchor: TrajectoryLogAnchor = {};
  if (typeof parsed.logFile === 'string') anchor.logFile = parsed.logFile;
  if (typeof parsed.byteOffset === 'number') anchor.byteOffset = parsed.byteOffset;
  if (typeof parsed.event === 'string') anchor.event = parsed.event;
  return anchor;
}

function parseProviderAlignment(value: string): ProviderTurnAlignment {
  const parsed = parseJsonObject(value, 'provider alignment');
  if (
    isTrajectoryConfidence(parsed.confidence) &&
    Array.isArray(parsed.reasons) &&
    parsed.reasons.every((reason) => typeof reason === 'string')
  ) {
    const alignment: ProviderTurnAlignment = {
      confidence: parsed.confidence,
      reasons: parsed.reasons,
    };
    if (typeof parsed.turnSequence === 'number') {
      alignment.turnSequence = parsed.turnSequence;
    }
    if (typeof parsed.agentEventSequence === 'number') {
      alignment.agentEventSequence = parsed.agentEventSequence;
    }
    return alignment;
  }
  throw invalidStoredJson('provider alignment');
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the stable store error below.
  }
  throw invalidStoredJson(label);
}

function invalidStoredJson(label: string): TrajectoryStoreError {
  return new TrajectoryStoreError(
    'invalid-query',
    `Stored ${label} JSON is invalid`,
  );
}

function isTrajectoryConfidence(value: unknown): value is TrajectoryConfidence {
  return (
    value === 'high' ||
    value === 'medium' ||
    value === 'low' ||
    value === 'unknown'
  );
}

function confidenceRank(confidence: TrajectoryConfidence): number {
  switch (confidence) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    case 'unknown':
      return 0;
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TrajectoryStoreError(
      'invalid-query',
      'Trajectory query limit must be a positive integer',
    );
  }
  return Math.min(limit, 1000);
}

function normalizeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== cursor) {
    throw new TrajectoryStoreError(
      'invalid-query',
      'Trajectory query cursor must be a non-negative integer string',
    );
  }
  return parsed;
}

function compareSegments(a: TrajectorySegment, b: TrajectorySegment): number {
  const ts = a.ts.localeCompare(b.ts);
  if (ts !== 0) return ts;
  return a.sequence - b.sequence;
}

function assertManagedContentRef(contentRef: string): void {
  if (containsParentTraversal(contentRef)) {
    throw new TrajectoryStoreError(
      'invalid-content-ref',
      `Trajectory contentRef must not contain parent traversal: ${contentRef}`,
    );
  }
  if (
    contentRef.startsWith('trajectory/imports/') ||
    contentRef.startsWith('trajectory/provider-calls/') ||
    contentRef.startsWith('transcripts/')
  ) {
    return;
  }
  throw new TrajectoryStoreError(
    'invalid-content-ref',
    `Trajectory contentRef must point to Nexus-managed storage: ${contentRef}`,
  );
}

function assertManagedProviderRef(ref: string): void {
  if (containsParentTraversal(ref)) {
    throw new TrajectoryStoreError(
      'invalid-content-ref',
      `Provider observation ref must not contain parent traversal: ${ref}`,
    );
  }
  if (ref.startsWith('trajectory/provider-calls/')) return;
  throw new TrajectoryStoreError(
    'invalid-content-ref',
    `Provider observation ref must point to Nexus-managed storage: ${ref}`,
  );
}

function containsParentTraversal(ref: string): boolean {
  return ref.split(/[\\/]+/).includes('..');
}
