import { BasicRedactor, type Redactor } from './redaction.js';

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

export class InMemoryTrajectoryStore {
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
