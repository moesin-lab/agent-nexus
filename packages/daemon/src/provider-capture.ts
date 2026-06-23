import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageRecord } from '@agent-nexus/protocol';
import type { ProviderCaptureConfig } from './config.js';
import { BasicRedactor, type Redactor } from './redaction.js';
import type {
  ProviderCallObservation,
  ProviderTurnAlignment,
  TrajectoryRedactionState,
  TrajectoryStore,
} from './trajectory-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type PreparedPayload = {
  status: 'absent' | 'too-large' | 'no-storage-root' | 'ready';
  text?: string;
};

export type ProviderCaptureErrorCode =
  | 'provider-capture-disabled'
  | 'provider-capture-unsupported'
  | 'provider-capture-redaction-failed';

export type ProviderCaptureSupport =
  | { supported: true }
  | {
      supported: false;
      code: 'provider-capture-unsupported';
      reason: string;
    };

export type ProviderCaptureRecordResult =
  | {
      status: 'disabled';
      code: 'provider-capture-disabled';
    }
  | {
      status: 'unsupported';
      code: 'provider-capture-unsupported';
      reason: string;
    }
  | {
      status: 'recorded';
      observationId: string;
    }
  | {
      status: 'dropped';
      code: 'provider-capture-redaction-failed';
      observationId: string;
    };

export interface ProviderUsageObservationInput {
  backend: string;
  sessionId?: string;
  traceId?: string;
  observedAt: Date;
  agentEventSequence: number;
  trajectorySequence: number;
  usage: UsageRecord;
}

export interface ProviderCallCaptureInput {
  backend: string;
  captureMode: ProviderCaptureConfig['mode'];
  sessionId?: string;
  traceId?: string;
  requestStartedAt: Date;
  responseFinishedAt?: Date;
  providerHost?: string;
  model?: string;
  requestBody?: string;
  responseBody?: string;
  streamFrames?: string;
  alignment: ProviderTurnAlignment;
  trajectorySequence?: number;
}

export interface ProviderCaptureRecorder {
  recordUsageObservation(
    input: ProviderUsageObservationInput,
  ): ProviderCaptureRecordResult;
}

export interface ProviderCaptureServiceInput {
  config: ProviderCaptureConfig;
  store: TrajectoryStore;
  contentStorageRoot?: string;
  redactor?: Redactor;
  now?: () => Date;
  idFactory?: () => string;
}

export class ProviderCaptureService implements ProviderCaptureRecorder {
  private readonly config: ProviderCaptureConfig;
  private readonly store: TrajectoryStore;
  private readonly contentStorageRoot?: string;
  private readonly redactor: Redactor;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(input: ProviderCaptureServiceInput) {
    this.config = input.config;
    this.store = input.store;
    this.contentStorageRoot = input.contentStorageRoot;
    this.redactor = input.redactor ?? new BasicRedactor();
    this.now = input.now ?? (() => new Date());
    this.idFactory = input.idFactory ?? randomUUID;
  }

  recordUsageObservation(
    input: ProviderUsageObservationInput,
  ): ProviderCaptureRecordResult {
    const guard = this.guardCapture(input.backend, 'transcript-only');
    if (guard) return guard;

    const observationId = this.idFactory();
    const summary = summarizeUsageRecord(input.usage);
    const observedAt = input.observedAt.toISOString();
    const alignment: ProviderTurnAlignment = {
      confidence: 'medium',
      turnSequence: input.usage.turnSequence,
      agentEventSequence: input.agentEventSequence,
      reasons: ['agent-usage-event'],
    };
    const observation: ProviderCallObservation = {
      observationId,
      backend: input.backend,
      captureMode: 'transcript-only',
      requestStartedAt: observedAt,
      responseFinishedAt: observedAt,
      model: input.usage.model,
      requestSummary: summary,
      responseSummary: summary,
      requestBytes: 0,
      responseBytes: 0,
      redactionState: 'metadata-only',
      alignment,
      metadataJson: safeJson({
        source: 'agent-usage-event',
        usage: input.usage,
      }),
    };
    if (input.sessionId) observation.sessionId = input.sessionId;
    if (input.traceId) observation.traceId = input.traceId;

    this.store.recordProviderCallObservation(observation);
    this.appendProviderTrajectorySegment({
      observationId,
      sessionId: input.sessionId,
      traceId: input.traceId,
      kind: 'usage',
      sequence: input.trajectorySequence,
      ts: observedAt,
      summary,
      redactionState: 'metadata-only',
      alignment,
      metadata: {
        source: 'agent-usage-event',
        backend: input.backend,
        captureMode: 'transcript-only',
        model: input.usage.model,
        agentEventSequence: input.agentEventSequence,
      },
    });

    return { status: 'recorded', observationId };
  }

  // Future proxy runners should enter here after collecting request/response payloads.
  // The current Engine runtime only calls recordUsageObservation for transcript-only usage.
  recordProviderCall(input: ProviderCallCaptureInput): ProviderCaptureRecordResult {
    const guard = this.guardCapture(input.backend, input.captureMode);
    if (guard) return guard;

    const observationId = this.idFactory();
    const requestBytes = byteLength(input.requestBody);
    const responseBytes =
      input.responseBody === undefined ? undefined : byteLength(input.responseBody);
    let requestBodyRef: string | undefined;
    let responseBodyRef: string | undefined;
    let streamFramesRef: string | undefined;
    let redactionState: TrajectoryRedactionState = 'metadata-only';
    let redactionFailed = false;
    const payloadMetadata: Record<string, unknown> = {
      requestBytes,
      responseBytes,
      storeRawStreams: this.config.storeRawStreams,
    };

    let request: PreparedPayload = { status: 'absent' };
    let response: PreparedPayload = { status: 'absent' };
    let stream: PreparedPayload | undefined;

    try {
      request = this.preparePayload(input.requestBody, this.config.maxRequestBytes);
      response = this.preparePayload(
        input.responseBody,
        this.config.maxResponseBytes,
      );
      stream = this.config.storeRawStreams
        ? this.preparePayload(input.streamFrames, this.config.maxResponseBytes)
        : undefined;
    } catch {
      redactionFailed = true;
      redactionState = 'dropped';
      payloadMetadata['redaction'] = 'failed';
    }

    if (!redactionFailed) {
      try {
        payloadMetadata['requestPayload'] = request.status;
        payloadMetadata['responsePayload'] = response.status;
        if (stream) payloadMetadata['streamPayload'] = stream.status;
        if (request.status === 'ready') {
          requestBodyRef = this.writePayload(observationId, 'request.txt', request.text);
          redactionState = 'redacted';
        }
        if (response.status === 'ready') {
          responseBodyRef = this.writePayload(observationId, 'response.txt', response.text);
          redactionState = 'redacted';
        }
        if (stream?.status === 'ready') {
          streamFramesRef = this.writePayload(
            observationId,
            'stream-frames.txt',
            stream.text,
          );
          redactionState = 'redacted';
        }
      } catch (err) {
        this.removePayloadDir(observationId);
        throw err;
      }
    }

    const requestStartedAt = input.requestStartedAt.toISOString();
    const responseFinishedAt = input.responseFinishedAt?.toISOString();
    const requestSummary = summarizeProviderPayload('request', requestBytes);
    const responseSummary =
      responseBytes === undefined
        ? undefined
        : summarizeProviderPayload('response', responseBytes);
    const observation: ProviderCallObservation = {
      observationId,
      backend: input.backend,
      captureMode: input.captureMode,
      requestStartedAt,
      requestSummary,
      requestBytes,
      redactionState,
      alignment: input.alignment,
      metadataJson: safeJson({
        source: 'provider-capture',
        payload: payloadMetadata,
      }),
    };
    if (input.sessionId) observation.sessionId = input.sessionId;
    if (input.traceId) observation.traceId = input.traceId;
    if (responseFinishedAt) observation.responseFinishedAt = responseFinishedAt;
    if (input.providerHost) observation.providerHost = input.providerHost;
    if (input.model) observation.model = input.model;
    if (responseSummary) observation.responseSummary = responseSummary;
    if (requestBodyRef) observation.requestBodyRef = requestBodyRef;
    if (responseBodyRef) observation.responseBodyRef = responseBodyRef;
    if (streamFramesRef) observation.streamFramesRef = streamFramesRef;
    if (responseBytes !== undefined) observation.responseBytes = responseBytes;
    if (redactionFailed) {
      observation.errorCode = 'provider-capture-redaction-failed';
    }

    this.store.recordProviderCallObservation(observation);
    if (input.trajectorySequence !== undefined) {
      this.appendProviderTrajectorySegment({
        observationId,
        sessionId: input.sessionId,
        traceId: input.traceId,
        kind: responseSummary ? 'provider-response' : 'provider-request',
        sequence: input.trajectorySequence,
        ts: responseFinishedAt ?? requestStartedAt,
        summary: responseSummary ?? requestSummary,
        redactionState,
        alignment: input.alignment,
        metadata: {
          source: 'provider-capture',
          backend: input.backend,
          captureMode: input.captureMode,
          providerHost: input.providerHost,
          model: input.model,
        },
      });
    }

    if (redactionFailed) {
      return {
        status: 'dropped',
        code: 'provider-capture-redaction-failed',
        observationId,
      };
    }
    return { status: 'recorded', observationId };
  }

  applyRetention(): { deletedObservations: number } {
    const cutoff = new Date(
      this.now().getTime() - this.config.retentionDays * DAY_MS,
    ).toISOString();
    return {
      deletedObservations: this.store.pruneProviderCallObservations({
        before: cutoff,
      }),
    };
  }

  private guardCapture(
    backend: string,
    captureMode: ProviderCaptureConfig['mode'],
  ): Extract<ProviderCaptureRecordResult, { status: 'disabled' | 'unsupported' }> | undefined {
    if (!this.config.enabled) {
      return {
        status: 'disabled',
        code: 'provider-capture-disabled',
      };
    }
    const configuredSupport = isProviderCaptureSupported(
      backend,
      this.config.mode,
    );
    if (!configuredSupport.supported) {
      return {
        status: 'unsupported',
        code: configuredSupport.code,
        reason: configuredSupport.reason,
      };
    }
    const inputSupport = isProviderCaptureSupported(backend, captureMode);
    if (!inputSupport.supported) {
      return {
        status: 'unsupported',
        code: inputSupport.code,
        reason: inputSupport.reason,
      };
    }
    return undefined;
  }

  private preparePayload(
    raw: string | undefined,
    maxBytes: number,
  ): PreparedPayload {
    if (raw === undefined) return { status: 'absent' };
    const redacted = this.redactor.redact(raw);
    if (byteLength(redacted) > maxBytes) return { status: 'too-large' };
    if (!this.contentStorageRoot) return { status: 'no-storage-root' };
    return { status: 'ready', text: redacted };
  }

  private writePayload(
    observationId: string,
    fileName: 'request.txt' | 'response.txt' | 'stream-frames.txt',
    text: string | undefined,
  ): string {
    const pathSegment = encodeURIComponent(observationId);
    const dir = join(
      this.contentStorageRoot ?? '.',
      'trajectory',
      'provider-calls',
      pathSegment,
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, fileName), text ?? '', {
      encoding: 'utf8',
      mode: 0o600,
    });
    return `trajectory/provider-calls/${pathSegment}/${fileName}`;
  }

  private removePayloadDir(observationId: string): void {
    if (!this.contentStorageRoot) return;
    rmSync(
      join(
        this.contentStorageRoot,
        'trajectory',
        'provider-calls',
        encodeURIComponent(observationId),
      ),
      { recursive: true, force: true },
    );
  }

  private appendProviderTrajectorySegment(input: {
    observationId: string;
    sessionId?: string;
    traceId?: string;
    kind: 'usage' | 'provider-request' | 'provider-response';
    sequence: number;
    ts: string;
    summary: string;
    redactionState: TrajectoryRedactionState;
    alignment: ProviderTurnAlignment;
    metadata: Record<string, unknown>;
  }): void {
    this.store.appendTrajectorySegment({
      segmentId: `provider:${input.observationId}`,
      sessionId: input.sessionId,
      providerObservationId: input.observationId,
      source: 'provider-call',
      kind: input.kind,
      traceId: input.traceId,
      turnSequence: input.alignment.turnSequence,
      sequence: input.sequence,
      ts: input.ts,
      summary: input.summary,
      confidence: input.alignment.confidence,
      redactionState: input.redactionState,
      metadataJson: safeJson(input.metadata),
    });
  }
}

export function isProviderCaptureSupported(
  backend: string,
  mode: ProviderCaptureConfig['mode'],
): ProviderCaptureSupport {
  const normalizedBackend = backend.toLowerCase();
  if (mode !== 'transcript-only') {
    return {
      supported: false,
      code: 'provider-capture-unsupported',
      reason: `Provider capture mode ${mode} is not implemented by this daemon runtime`,
    };
  }
  if (normalizedBackend === 'codex' || normalizedBackend === 'claudecode') {
    return { supported: true };
  }
  return {
    supported: false,
    code: 'provider-capture-unsupported',
    reason: `Provider capture backend ${backend} is not supported`,
  };
}

function summarizeUsageRecord(usage: UsageRecord): string {
  const cost =
    usage.costUsd === null ? 'cost unknown' : `cost $${usage.costUsd.toFixed(6)}`;
  return [
    usage.model,
    `input ${usage.inputTokens}`,
    `output ${usage.outputTokens}`,
    cost,
  ].join(', ');
}

function summarizeProviderPayload(kind: 'request' | 'response', bytes: number): string {
  return `${kind} metadata, ${bytes} bytes captured`;
}

function byteLength(value: string | undefined): number {
  return Buffer.byteLength(value ?? '', 'utf8');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"serialization":"failed"}';
  }
}
