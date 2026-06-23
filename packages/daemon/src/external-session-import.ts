import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { SessionKey } from '@agent-nexus/protocol';
import type {
  ExternalImportConfig,
  ExternalImportSourceConfig,
  TrajectorySourceAdapter,
} from './config.js';
import { BasicRedactor, type Redactor } from './redaction.js';
import type { SessionStore } from './session-store.js';
import type {
  ExternalResumeBinding,
  ExternalSessionImportRecord,
  TrajectoryConfidence,
  TrajectorySegment,
  TrajectorySegmentKind,
  TrajectoryStore,
} from './trajectory-store.js';

export interface DiscoverExternalSessionsInput {
  root: string;
  projectPathAllowlist: string[];
  metadataOnly: boolean;
  maxFileBytes: number;
  maxRecordsPerSession: number;
  maxAgeDays: number | null;
  now: Date;
}

export interface ExternalSessionCandidate {
  sourceAdapter: TrajectorySourceAdapter;
  sourceSessionId: string;
  sourcePath: string;
  nativeSessionRef?: string;
  projectPath?: string;
  createdAt?: string;
  updatedAt?: string;
  recordCount?: number;
  firstUserMessageSummary?: string;
  schemaVersion?: string;
  confidence: TrajectoryConfidence;
  unsupportedReasons: string[];
}

export interface ExternalImportPolicy {
  importContent: boolean;
  maxFileBytes: number;
  maxRecordsPerSession: number;
  redactor: Redactor;
}

export interface ImportedTranscriptSegment {
  kind: TrajectorySegmentKind;
  ts: string;
  summary: string;
  confidence: TrajectoryConfidence;
  metadata: Record<string, unknown>;
  content?: Record<string, unknown>;
}

export interface ResumeEligibility {
  canResume: boolean;
  nativeSessionRef?: string;
  confidence: TrajectoryConfidence;
  reasons: string[];
}

export interface ExternalSessionSourceAdapter {
  id(): TrajectorySourceAdapter;
  discover(input: DiscoverExternalSessionsInput): ExternalSessionCandidate[];
  importCandidate(
    candidate: ExternalSessionCandidate,
    policy: ExternalImportPolicy,
  ): ImportedTranscriptSegment[];
  resumeEligibility(candidate: ExternalSessionCandidate): ResumeEligibility;
}

export interface ExternalSessionImportOutcome {
  candidate: ExternalSessionCandidate;
  record: ExternalSessionImportRecord;
  segments: TrajectorySegment[];
  resumeEligibility: ResumeEligibility;
}

export interface ExternalSessionImportRunResult {
  imports: ExternalSessionImportOutcome[];
}

export type ExternalSessionImportServiceErrorCode =
  | 'external-import-not-found'
  | 'external-import-not-ready'
  | 'external-adapter-unavailable'
  | 'external-source-unsupported'
  | 'native-resume-backend-mismatch'
  | 'native-resume-unavailable';

export class ExternalSessionImportServiceError extends Error {
  constructor(
    readonly code: ExternalSessionImportServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExternalSessionImportServiceError';
  }
}

export interface ExternalSessionImporter {
  run(): ExternalSessionImportRunResult;
  bindToRoutingSession(input: {
    importId: string;
    sessionKey: SessionKey;
    agentOwner: string;
  }): ExternalResumeBinding;
}

export interface ExternalSessionImportServiceInput {
  config: ExternalImportConfig;
  store: TrajectoryStore;
  sessionStore?: SessionStore;
  adapters?: readonly ExternalSessionSourceAdapter[];
  contentStorageRoot?: string;
  redactor?: Redactor;
  now?: () => Date;
}

export class ExternalSessionImportService implements ExternalSessionImporter {
  private readonly config: ExternalImportConfig;
  private readonly store: TrajectoryStore;
  private readonly sessionStore?: SessionStore;
  private readonly adapters: Map<string, ExternalSessionSourceAdapter>;
  private readonly contentStorageRoot?: string;
  private readonly redactor: Redactor;
  private readonly now: () => Date;

  constructor(input: ExternalSessionImportServiceInput) {
    this.config = input.config;
    this.store = input.store;
    this.sessionStore = input.sessionStore;
    this.adapters = new Map(
      (input.adapters ?? defaultExternalSessionAdapters()).map((adapter) => [
        adapter.id(),
        adapter,
      ]),
    );
    this.contentStorageRoot = input.contentStorageRoot;
    this.redactor = input.redactor ?? new BasicRedactor();
    this.now = input.now ?? (() => new Date());
  }

  run(): ExternalSessionImportRunResult {
    if (!this.config.enabled) return { imports: [] };
    const outcomes: ExternalSessionImportOutcome[] = [];
    const now = this.now();

    for (const source of this.config.sources) {
      const adapter = this.adapters.get(source.adapter);
      if (!adapter) {
        throw new ExternalSessionImportServiceError(
          'external-adapter-unavailable',
          `External session adapter is unavailable: ${source.adapter}`,
        );
      }
      const candidates = adapter.discover({
        root: source.root,
        projectPathAllowlist: source.projectPathAllowlist,
        metadataOnly: this.config.metadataOnlyDiscovery,
        maxFileBytes: this.config.maxFileBytes,
        maxRecordsPerSession: this.config.maxRecordsPerSession,
        maxAgeDays: this.config.maxAgeDays,
        now,
      });
      for (const candidate of candidates) {
        outcomes.push(this.acceptCandidate(adapter, candidate, now));
      }
    }

    return { imports: outcomes };
  }

  bindToRoutingSession(input: {
    importId: string;
    sessionKey: SessionKey;
    agentOwner: string;
  }): ExternalResumeBinding {
    if (!this.sessionStore) {
      throw new ExternalSessionImportServiceError(
        'external-import-not-ready',
        'External session resume requires a SessionStore',
      );
    }
    const record = this.store.getExternalSessionImport(input.importId);
    if (!record) {
      throw new ExternalSessionImportServiceError(
        'external-import-not-found',
        `External import was not found: ${input.importId}`,
      );
    }
    const expectedOwner = agentOwnerForExternalSourceAdapter(record.sourceAdapter);
    if (!expectedOwner || expectedOwner !== input.agentOwner) {
      throw new ExternalSessionImportServiceError(
        'native-resume-backend-mismatch',
        `External import ${input.importId} belongs to ${expectedOwner}, not ${input.agentOwner}`,
      );
    }
    if (!record.nativeSessionRef) {
      throw new ExternalSessionImportServiceError(
        'native-resume-unavailable',
        `External import ${input.importId} has no native session ref`,
      );
    }

    const linkedAtDate = this.now();
    const linkedAt = linkedAtDate.toISOString();
    const sessionId = this.sessionStore.ensureSessionId(input.sessionKey);
    const binding = this.store.linkExternalSession({
      importId: input.importId,
      sessionId,
      linkedAt,
    });
    this.sessionStore.bindExternalResumeToKey(input.sessionKey, {
      agentSessionId: binding.nativeSessionRef,
      lastTurnAt: linkedAtDate,
      title: titleFromMetadata(record.metadataJson) ?? record.sourceSessionId,
    });
    return binding;
  }

  private acceptCandidate(
    adapter: ExternalSessionSourceAdapter,
    candidate: ExternalSessionCandidate,
    now: Date,
  ): ExternalSessionImportOutcome {
    const importId = importIdForCandidate(candidate);
    const unsupportedReasons = stableUnsupportedReasons(candidate);
    const resumeEligibility = adapter.resumeEligibility(candidate);
    const existing = this.store.getExternalSessionImport(importId);
    if (existing && this.canReuseExistingImport(existing)) {
      return {
        candidate,
        record: existing,
        segments: this.store.queryTrajectory({ importId }).segments,
        resumeEligibility,
      };
    }

    if (unsupportedReasons.length > 0) {
      const record = importRecordForCandidate({
        candidate,
        importId,
        state: 'rejected',
        now,
        error: {
          code: 'external-source-unsupported',
          message: unsupportedReasons.join(', '),
          retryable: false,
        },
        redactor: this.redactor,
      });
      this.store.upsertExternalSessionImport(record);
      return { candidate, record, segments: [], resumeEligibility };
    }

    let record = importRecordForCandidate({
      candidate,
      importId,
      state: 'registered',
      now,
      redactor: this.redactor,
    });
    const segments: TrajectorySegment[] = [];

    if (this.config.importContent) {
      try {
        const imported = adapter.importCandidate(candidate, {
          importContent: true,
          maxFileBytes: this.config.maxFileBytes,
          maxRecordsPerSession: this.config.maxRecordsPerSession,
          redactor: this.redactor,
        });
        let sequence = 1;
        for (const segment of imported) {
          const trajectorySegment = this.trajectorySegmentForImport({
            importId,
            sourcePathHash: sourcePathHash(candidate.sourcePath),
            sourceAdapter: candidate.sourceAdapter,
            sourceSessionId: candidate.sourceSessionId,
            imported: segment,
            sequence,
          });
          this.store.appendTrajectorySegment(trajectorySegment);
          segments.push(trajectorySegment);
          sequence += 1;
        }
        record = {
          ...record,
          state: 'imported',
          importedAt: now.toISOString(),
        };
      } catch (err) {
        record = {
          ...record,
          state: 'failed',
          error: {
            code: 'external-import-failed',
            message: err instanceof Error ? err.message : 'external import failed',
            retryable: true,
          },
        };
      }
    }

    this.store.upsertExternalSessionImport(record);
    return { candidate, record, segments, resumeEligibility };
  }

  private canReuseExistingImport(record: ExternalSessionImportRecord): boolean {
    if (record.state === 'imported' || record.state === 'linked') return true;
    if (record.state === 'registered' && !this.config.importContent) return true;
    return record.state === 'rejected';
  }

  private trajectorySegmentForImport(input: {
    importId: string;
    sourcePathHash: string;
    sourceAdapter: string;
    sourceSessionId: string;
    imported: ImportedTranscriptSegment;
    sequence: number;
  }): TrajectorySegment {
    const segmentId = segmentIdForImport(input.importId, input.sequence);
    const contentRef =
      this.contentStorageRoot && input.imported.content
        ? this.writeImportedContent({
            importId: input.importId,
            segmentId,
            content: input.imported.content,
          })
        : undefined;
    return {
      segmentId,
      importId: input.importId,
      source: 'external-import',
      kind: input.imported.kind,
      sequence: input.sequence,
      ts: input.imported.ts,
      summary: this.redactor.redact(input.imported.summary),
      ...(contentRef ? { contentRef } : {}),
      confidence: input.imported.confidence,
      redactionState: contentRef ? 'redacted' : 'metadata-only',
      metadataJson: this.redactor.redact(
        JSON.stringify({
          sourceAdapter: input.sourceAdapter,
          sourceSessionId: input.sourceSessionId,
          sourcePathHash: input.sourcePathHash,
          ...input.imported.metadata,
        }),
      ),
    };
  }

  private writeImportedContent(input: {
    importId: string;
    segmentId: string;
    content: Record<string, unknown>;
  }): string {
    const contentRef = `trajectory/imports/${input.importId}/${input.segmentId}.json`;
    const target = join(this.contentStorageRoot!, contentRef);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      this.redactor.redact(JSON.stringify(input.content, null, 2)),
      'utf8',
    );
    return contentRef;
  }
}

export class CodexAppJsonlSessionSourceAdapter
  implements ExternalSessionSourceAdapter
{
  id(): TrajectorySourceAdapter {
    return 'codex-app-jsonl';
  }

  discover(input: DiscoverExternalSessionsInput): ExternalSessionCandidate[] {
    return discoverJsonlCandidates(input, this.id(), parseCodexAppMetadata);
  }

  importCandidate(
    candidate: ExternalSessionCandidate,
    policy: ExternalImportPolicy,
  ): ImportedTranscriptSegment[] {
    return importJsonlSegments(candidate, policy, mapCodexAppRecord);
  }

  resumeEligibility(candidate: ExternalSessionCandidate): ResumeEligibility {
    return resumeEligibilityFromCandidate(candidate);
  }
}

export class CodexCliJsonlSessionSourceAdapter
  implements ExternalSessionSourceAdapter
{
  id(): TrajectorySourceAdapter {
    return 'codex-cli-jsonl';
  }

  discover(input: DiscoverExternalSessionsInput): ExternalSessionCandidate[] {
    return discoverJsonlCandidates(input, this.id(), parseCodexCliMetadata);
  }

  importCandidate(
    candidate: ExternalSessionCandidate,
    policy: ExternalImportPolicy,
  ): ImportedTranscriptSegment[] {
    return importJsonlSegments(candidate, policy, mapCodexCliRecord);
  }

  resumeEligibility(candidate: ExternalSessionCandidate): ResumeEligibility {
    return resumeEligibilityFromCandidate(candidate);
  }
}

export class ClaudeCodeJsonlSessionSourceAdapter
  implements ExternalSessionSourceAdapter
{
  id(): TrajectorySourceAdapter {
    return 'claude-code-jsonl';
  }

  discover(input: DiscoverExternalSessionsInput): ExternalSessionCandidate[] {
    return discoverJsonlCandidates(input, this.id(), parseClaudeCodeMetadata);
  }

  importCandidate(
    candidate: ExternalSessionCandidate,
    policy: ExternalImportPolicy,
  ): ImportedTranscriptSegment[] {
    return importJsonlSegments(candidate, policy, mapClaudeCodeRecord);
  }

  resumeEligibility(candidate: ExternalSessionCandidate): ResumeEligibility {
    return resumeEligibilityFromCandidate(candidate);
  }
}

function defaultExternalSessionAdapters(): ExternalSessionSourceAdapter[] {
  return [
    new CodexCliJsonlSessionSourceAdapter(),
    new CodexAppJsonlSessionSourceAdapter(),
    new ClaudeCodeJsonlSessionSourceAdapter(),
  ];
}

interface ParsedSessionMetadata {
  sourceSessionId?: string;
  nativeSessionRef?: string;
  projectPath?: string;
  createdAt?: string;
  schemaVersion?: string;
  confidence: TrajectoryConfidence;
  unsupportedReasons: string[];
}

function discoverJsonlCandidates(
  input: DiscoverExternalSessionsInput,
  sourceAdapter: TrajectorySourceAdapter,
  parseMetadata: (records: readonly Record<string, unknown>[]) => ParsedSessionMetadata,
): ExternalSessionCandidate[] {
  const files = walkJsonlFiles(input.root);
  const candidates: ExternalSessionCandidate[] = [];

  for (const file of files) {
    const stat = statSync(file);
    const sourceSessionId = basename(file, extname(file));
    const updatedAt = stat.mtime.toISOString();
    if (input.maxAgeDays !== null && isOlderThan(stat.mtime, input.now, input.maxAgeDays)) {
      continue;
    }
    if (stat.size > input.maxFileBytes) {
      candidates.push({
        sourceAdapter,
        sourceSessionId,
        sourcePath: file,
        updatedAt,
        confidence: 'unknown',
        unsupportedReasons: ['file-too-large'],
      });
      continue;
    }

    const parsed = readJsonlRecords(file, input.maxRecordsPerSession);
    if (parsed.tooManyRecords) {
      candidates.push({
        sourceAdapter,
        sourceSessionId,
        sourcePath: file,
        updatedAt,
        confidence: 'unknown',
        unsupportedReasons: ['max-records-exceeded'],
      });
      continue;
    }
    if (!parsed.ok) {
      candidates.push({
        sourceAdapter,
        sourceSessionId,
        sourcePath: file,
        updatedAt,
        confidence: 'unknown',
        unsupportedReasons: ['schema-unknown'],
      });
      continue;
    }

    const metadata = parseMetadata(parsed.records);
    const unsupportedReasons = [
      ...metadata.unsupportedReasons,
      ...projectAllowlistReasons(metadata.projectPath, input.projectPathAllowlist),
    ];
    candidates.push({
      sourceAdapter,
      sourceSessionId: metadata.sourceSessionId ?? sourceSessionId,
      sourcePath: file,
      ...(metadata.nativeSessionRef
        ? { nativeSessionRef: metadata.nativeSessionRef }
        : {}),
      ...(metadata.projectPath ? { projectPath: metadata.projectPath } : {}),
      ...(metadata.createdAt ? { createdAt: metadata.createdAt } : {}),
      updatedAt,
      recordCount: parsed.records.length,
      ...(metadata.schemaVersion ? { schemaVersion: metadata.schemaVersion } : {}),
      confidence: metadata.confidence,
      unsupportedReasons,
    });
  }

  return candidates.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function importJsonlSegments(
  candidate: ExternalSessionCandidate,
  policy: ExternalImportPolicy,
  mapRecord: (
    record: Record<string, unknown>,
    candidate: ExternalSessionCandidate,
  ) => ImportedTranscriptSegment | undefined,
): ImportedTranscriptSegment[] {
  const stat = statSync(candidate.sourcePath);
  if (stat.size > policy.maxFileBytes) {
    throw new ExternalSessionImportServiceError(
      'external-source-unsupported',
      'external source exceeds maxFileBytes',
    );
  }
  const parsed = readJsonlRecords(candidate.sourcePath, policy.maxRecordsPerSession);
  if (!parsed.ok || parsed.tooManyRecords) {
    throw new ExternalSessionImportServiceError(
      'external-source-unsupported',
      parsed.tooManyRecords ? 'external source exceeds maxRecordsPerSession' : 'external source schema is unknown',
    );
  }
  return parsed.records
    .map((record) => mapRecord(record, candidate))
    .filter((segment): segment is ImportedTranscriptSegment => segment !== undefined);
}

function parseCodexAppMetadata(
  records: readonly Record<string, unknown>[],
): ParsedSessionMetadata {
  const metaRecord = records.find((record) => record['type'] === 'session_meta');
  const payload = asRecord(metaRecord?.['payload']);
  if (!payload) return unknownSchemaMetadata();
  const sourceSessionId = stringValue(payload['id']);
  const projectPath = stringValue(payload['cwd']);
  const createdAt = stringValue(payload['timestamp']) ?? stringValue(metaRecord?.['timestamp']);
  return {
    sourceSessionId,
    nativeSessionRef: sourceSessionId,
    projectPath,
    createdAt,
    schemaVersion: stringValue(payload['cli_version']),
    confidence: sourceSessionId && projectPath ? 'high' : 'low',
    unsupportedReasons: sourceSessionId ? [] : ['missing-native-session-ref'],
  };
}

function parseCodexCliMetadata(
  records: readonly Record<string, unknown>[],
): ParsedSessionMetadata {
  const threadRecord = records.find((record) => {
    const type = stringValue(record['type']);
    return type === 'thread.started' || type === 'session_started';
  });
  const threadId =
    stringValue(threadRecord?.['thread_id']) ??
    stringValue(asRecord(threadRecord?.['payload'])?.['thread_id']) ??
    stringValue(asRecord(threadRecord?.['payload'])?.['agentSessionId']);
  const projectPath =
    stringValue(threadRecord?.['cwd']) ??
    stringValue(asRecord(threadRecord?.['payload'])?.['cwd']);
  return {
    sourceSessionId: threadId,
    nativeSessionRef: threadId,
    projectPath,
    createdAt: stringValue(threadRecord?.['timestamp']),
    confidence: threadId && projectPath ? 'medium' : 'low',
    unsupportedReasons: threadId ? [] : ['missing-native-session-ref'],
  };
}

function parseClaudeCodeMetadata(
  records: readonly Record<string, unknown>[],
): ParsedSessionMetadata {
  const first = records.find((record) => stringValue(record['sessionId']));
  const sessionId = stringValue(first?.['sessionId']);
  const projectPath = stringValue(first?.['cwd']);
  return {
    sourceSessionId: sessionId,
    nativeSessionRef: sessionId,
    projectPath,
    createdAt: stringValue(first?.['timestamp']),
    schemaVersion: stringValue(first?.['version']),
    confidence: sessionId && projectPath ? 'medium' : 'low',
    unsupportedReasons: sessionId ? [] : ['missing-native-session-ref'],
  };
}

function unknownSchemaMetadata(): ParsedSessionMetadata {
  return {
    confidence: 'unknown',
    unsupportedReasons: ['schema-unknown'],
  };
}

function mapCodexAppRecord(
  record: Record<string, unknown>,
  candidate: ExternalSessionCandidate,
): ImportedTranscriptSegment | undefined {
  const payload = asRecord(record['payload']) ?? record;
  const payloadType = stringValue(payload['type']) ?? stringValue(record['type']);
  const kind = kindFromCodexPayloadType(payloadType);
  if (!kind) return undefined;
  return safeImportedSegment({
    adapter: candidate.sourceAdapter,
    sourceSessionId: candidate.sourceSessionId,
    kind,
    ts: stringValue(record['timestamp']) ?? candidate.updatedAt,
    payloadType,
    confidence: candidate.confidence === 'unknown' ? 'low' : candidate.confidence,
  });
}

function mapCodexCliRecord(
  record: Record<string, unknown>,
  candidate: ExternalSessionCandidate,
): ImportedTranscriptSegment | undefined {
  const type = stringValue(record['type']);
  const kind = kindFromCodexPayloadType(type);
  if (!kind) return undefined;
  return safeImportedSegment({
    adapter: candidate.sourceAdapter,
    sourceSessionId: candidate.sourceSessionId,
    kind,
    ts: stringValue(record['timestamp']) ?? candidate.updatedAt,
    payloadType: type,
    confidence: candidate.confidence === 'unknown' ? 'low' : candidate.confidence,
  });
}

function mapClaudeCodeRecord(
  record: Record<string, unknown>,
  candidate: ExternalSessionCandidate,
): ImportedTranscriptSegment | undefined {
  const recordType = stringValue(record['type']);
  const message = asRecord(record['message']);
  const role = stringValue(message?.['role']);
  const kind = kindFromClaudeRecord(recordType, role);
  if (!kind) return undefined;
  return safeImportedSegment({
    adapter: candidate.sourceAdapter,
    sourceSessionId: candidate.sourceSessionId,
    kind,
    ts: stringValue(record['timestamp']) ?? candidate.updatedAt,
    payloadType: recordType ?? role,
    confidence: candidate.confidence === 'unknown' ? 'low' : candidate.confidence,
  });
}

function safeImportedSegment(input: {
  adapter: string;
  sourceSessionId: string;
  kind: TrajectorySegmentKind;
  ts?: string;
  payloadType?: string;
  confidence: TrajectoryConfidence;
}): ImportedTranscriptSegment {
  const payloadType = input.payloadType ?? 'unknown';
  return {
    kind: input.kind,
    ts: input.ts ?? new Date(0).toISOString(),
    summary: `${input.adapter} ${input.kind}`,
    confidence: input.confidence,
    metadata: {
      payloadType,
    },
    content: {
      sourceAdapter: input.adapter,
      sourceSessionId: input.sourceSessionId,
      kind: input.kind,
      payloadType,
      redaction: 'body-omitted',
    },
  };
}

function kindFromCodexPayloadType(
  payloadType: string | undefined,
): TrajectorySegmentKind | undefined {
  switch (payloadType) {
    case 'user_message':
    case 'user':
      return 'user-message';
    case 'agent_message':
    case 'assistant':
      return 'agent-message';
    case 'reasoning':
      return 'reasoning';
    case 'function_call':
    case 'custom_tool_call':
    case 'tool_call':
    case 'item.started':
      return 'tool-call';
    case 'function_call_output':
    case 'tool_result':
    case 'item.completed':
      return 'tool-result';
    case 'token_count':
    case 'usage':
      return 'usage';
    default:
      return undefined;
  }
}

function kindFromClaudeRecord(
  recordType: string | undefined,
  role: string | undefined,
): TrajectorySegmentKind | undefined {
  if (recordType === 'assistant' || role === 'assistant') return 'agent-message';
  if (recordType === 'user' || role === 'user') return 'user-message';
  if (recordType === 'queue-operation') return 'state-change';
  return undefined;
}

function readJsonlRecords(
  filePath: string,
  maxRecords: number,
):
  | { ok: true; records: Record<string, unknown>[]; tooManyRecords: boolean }
  | { ok: false; records: []; tooManyRecords: false } {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length > maxRecords) {
    return { ok: true, records: [], tooManyRecords: true };
  }
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, records: [], tooManyRecords: false };
      }
      records.push(parsed as Record<string, unknown>);
    } catch {
      return { ok: false, records: [], tooManyRecords: false };
    }
  }
  return { ok: true, records, tooManyRecords: false };
}

function walkJsonlFiles(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsonlFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function importRecordForCandidate(input: {
  candidate: ExternalSessionCandidate;
  importId: string;
  state: ExternalSessionImportRecord['state'];
  now: Date;
  redactor: Redactor;
  error?: ExternalSessionImportRecord['error'];
}): ExternalSessionImportRecord {
  const metadataJson = input.redactor.redact(
    JSON.stringify({
      sourceAdapter: input.candidate.sourceAdapter,
      sourceSessionId: input.candidate.sourceSessionId,
      sourcePathHash: sourcePathHash(input.candidate.sourcePath),
      projectPath: input.candidate.projectPath,
      createdAt: input.candidate.createdAt,
      updatedAt: input.candidate.updatedAt,
      recordCount: input.candidate.recordCount,
      schemaVersion: input.candidate.schemaVersion,
      title: input.candidate.firstUserMessageSummary,
      unsupportedReasons: input.candidate.unsupportedReasons,
    }),
  );
  return {
    importId: input.importId,
    sourceAdapter: input.candidate.sourceAdapter,
    sourceSessionId: input.candidate.sourceSessionId,
    sourcePathHash: sourcePathHash(input.candidate.sourcePath),
    ...(input.candidate.nativeSessionRef
      ? { nativeSessionRef: input.candidate.nativeSessionRef }
      : {}),
    state: input.state,
    confidence: input.candidate.confidence,
    metadataJson,
    ...(input.error ? { error: input.error } : {}),
    discoveredAt: input.now.toISOString(),
  };
}

function stableUnsupportedReasons(
  candidate: ExternalSessionCandidate,
): string[] {
  return [...new Set(candidate.unsupportedReasons)].sort((a, b) =>
    a.localeCompare(b),
  );
}

function resumeEligibilityFromCandidate(
  candidate: ExternalSessionCandidate,
): ResumeEligibility {
  if (!candidate.nativeSessionRef) {
    return {
      canResume: false,
      confidence: candidate.confidence,
      reasons: ['missing-native-session-ref'],
    };
  }
  if (candidate.unsupportedReasons.length > 0) {
    return {
      canResume: false,
      nativeSessionRef: candidate.nativeSessionRef,
      confidence: candidate.confidence,
      reasons: stableUnsupportedReasons(candidate),
    };
  }
  return {
    canResume: true,
    nativeSessionRef: candidate.nativeSessionRef,
    confidence: candidate.confidence,
    reasons: [],
  };
}

function projectAllowlistReasons(
  projectPath: string | undefined,
  allowlist: readonly string[],
): string[] {
  if (allowlist.length === 0) return ['project-allowlist-empty'];
  if (!projectPath) return ['missing-project-path'];
  const project = resolve(projectPath);
  for (const root of allowlist) {
    const normalizedRoot = resolve(root);
    const rel = relative(normalizedRoot, project);
    if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return [];
    }
  }
  return ['outside-project-allowlist'];
}

function isOlderThan(mtime: Date, now: Date, days: number): boolean {
  return now.getTime() - mtime.getTime() > days * 24 * 60 * 60 * 1000;
}

function sourcePathHash(sourcePath: string): string {
  return `sha256:${sha256(resolve(sourcePath))}`;
}

function importIdForCandidate(candidate: ExternalSessionCandidate): string {
  return `ext_${sha256([
    candidate.sourceAdapter,
    candidate.sourceSessionId,
    sourcePathHash(candidate.sourcePath),
  ].join('\0')).slice(0, 32)}`;
}

function segmentIdForImport(importId: string, sequence: number): string {
  return `${importId}_${String(sequence).padStart(6, '0')}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function agentOwnerForExternalSourceAdapter(
  sourceAdapter: string,
): string | undefined {
  if (sourceAdapter === 'codex-cli-jsonl' || sourceAdapter === 'codex-app-jsonl') {
    return 'codex';
  }
  if (sourceAdapter === 'claude-code-jsonl') return 'claudecode';
  return undefined;
}

function titleFromMetadata(metadataJson: string): string | undefined {
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const title = (parsed as Record<string, unknown>)['title'];
    return typeof title === 'string' && title.length > 0 ? title : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
