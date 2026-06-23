import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DAEMON_RUNTIME_CONFIG,
  type ProviderCaptureConfig,
} from './config.js';
import {
  ProviderCaptureService,
  isProviderCaptureSupported,
} from './provider-capture.js';
import { InMemoryTrajectoryStore } from './trajectory-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('isProviderCaptureSupported', () => {
  it('only enables the implemented transcript-only backend paths', () => {
    expect(isProviderCaptureSupported('codex', 'transcript-only')).toEqual({
      supported: true,
    });
    expect(isProviderCaptureSupported('claudecode', 'transcript-only')).toEqual({
      supported: true,
    });
    expect(isProviderCaptureSupported('codex', 'reverse-proxy')).toMatchObject({
      supported: false,
      code: 'provider-capture-unsupported',
    });
    expect(isProviderCaptureSupported('future', 'transcript-only')).toMatchObject({
      supported: false,
      code: 'provider-capture-unsupported',
    });
  });
});

describe('ProviderCaptureService', () => {
  it('does not record observations when provider capture is disabled', () => {
    const store = new InMemoryTrajectoryStore();
    const service = new ProviderCaptureService({
      config: providerConfig({ enabled: false }),
      store,
      now: fixedNow,
    });

    const result = service.recordUsageObservation(usageInput());

    expect(result).toEqual({
      status: 'disabled',
      code: 'provider-capture-disabled',
    });
    expect(store.queryTrajectory({ source: 'provider-call' }).segments).toEqual([]);
  });

  it('fails closed for unsupported capture modes without writing store records', () => {
    const store = new InMemoryTrajectoryStore();
    const service = new ProviderCaptureService({
      config: providerConfig({ enabled: true, mode: 'reverse-proxy' }),
      store,
      now: fixedNow,
    });

    const result = service.recordUsageObservation(usageInput());

    expect(result).toMatchObject({
      status: 'unsupported',
      code: 'provider-capture-unsupported',
    });
    expect(store.queryTrajectory({ source: 'provider-call' }).segments).toEqual([]);
  });

  it('records transcript-only usage as a provider observation and trajectory segment', () => {
    const store = new InMemoryTrajectoryStore();
    const service = new ProviderCaptureService({
      config: providerConfig({ enabled: true, mode: 'transcript-only' }),
      store,
      now: fixedNow,
      idFactory: fixedIdFactory('obs-usage'),
    });

    const result = service.recordUsageObservation(
      usageInput({ trajectorySequence: 7 }),
    );

    expect(result).toMatchObject({
      status: 'recorded',
      observationId: 'obs-usage',
    });
    expect(store.getProviderCallObservation('obs-usage')).toMatchObject({
      observationId: 'obs-usage',
      sessionId: 'sess-1',
      traceId: 'trace-1',
      backend: 'codex',
      captureMode: 'transcript-only',
      model: 'gpt-5',
      requestBytes: 0,
      responseBytes: 0,
      redactionState: 'metadata-only',
      alignment: {
        confidence: 'medium',
        turnSequence: 3,
        agentEventSequence: 42,
        reasons: ['agent-usage-event'],
      },
    });
    const segments = store.queryTrajectory({ source: 'provider-call' }).segments;
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      sessionId: 'sess-1',
      providerObservationId: 'obs-usage',
      kind: 'usage',
      sequence: 7,
      confidence: 'medium',
      redactionState: 'metadata-only',
    });
  });

  it('writes redacted managed provider payload files within configured size limits', () => {
    const store = new InMemoryTrajectoryStore();
    const contentRoot = tempDir();
    const service = new ProviderCaptureService({
      config: providerConfig({
        enabled: true,
        mode: 'transcript-only',
        maxRequestBytes: 200,
        maxResponseBytes: 200,
        storeRawStreams: false,
      }),
      store,
      contentStorageRoot: contentRoot,
      now: fixedNow,
      idFactory: fixedIdFactory('obs-payload'),
    });

    const result = service.recordProviderCall({
      backend: 'codex',
      captureMode: 'transcript-only',
      sessionId: 'sess-1',
      traceId: 'trace-1',
      requestStartedAt: new Date('2026-06-23T11:00:00.000Z'),
      responseFinishedAt: new Date('2026-06-23T11:00:01.000Z'),
      providerHost: 'api.openai.com',
      model: 'gpt-5',
      requestBody: 'Authorization: sk-ant-secret /home/node/private',
      responseBody: 'answer for /home/node/private',
      streamFrames: 'raw stream frame should not be written',
      alignment: {
        confidence: 'medium',
        turnSequence: 3,
        agentEventSequence: 42,
        reasons: ['test'],
      },
      trajectorySequence: 8,
    });

    expect(result).toMatchObject({
      status: 'recorded',
      observationId: 'obs-payload',
    });
    const observation = store.getProviderCallObservation('obs-payload');
    expect(observation).toMatchObject({
      redactionState: 'redacted',
      requestBodyRef: 'trajectory/provider-calls/obs-payload/request.txt',
      responseBodyRef: 'trajectory/provider-calls/obs-payload/response.txt',
    });
    expect(observation).not.toHaveProperty('streamFramesRef');
    const request = readFileSync(
      join(contentRoot, observation!.requestBodyRef!),
      'utf8',
    );
    expect(request).toContain('<redacted:secret>');
    expect(request).toContain('~/private');
    expect(request).not.toContain('sk-ant-secret');
    expect(request).not.toContain('/home/node/private');
  });

  it('drops payload refs when redaction throws', () => {
    const store = new InMemoryTrajectoryStore();
    const contentRoot = tempDir();
    const service = new ProviderCaptureService({
      config: providerConfig({ enabled: true, mode: 'transcript-only' }),
      store,
      contentStorageRoot: contentRoot,
      redactor: {
        redact: vi.fn(() => {
          throw new Error('redaction failed');
        }),
      },
      now: fixedNow,
      idFactory: fixedIdFactory('obs-redaction-failed'),
    });

    const result = service.recordProviderCall({
      backend: 'codex',
      captureMode: 'transcript-only',
      sessionId: 'sess-1',
      traceId: 'trace-1',
      requestStartedAt: new Date('2026-06-23T11:00:00.000Z'),
      requestBody: 'sk-ant-secret',
      alignment: {
        confidence: 'low',
        reasons: ['test'],
      },
      trajectorySequence: 9,
    });

    expect(result).toMatchObject({
      status: 'dropped',
      code: 'provider-capture-redaction-failed',
      observationId: 'obs-redaction-failed',
    });
    const observation = store.getProviderCallObservation('obs-redaction-failed');
    expect(observation).toMatchObject({
      redactionState: 'dropped',
      errorCode: 'provider-capture-redaction-failed',
    });
    expect(observation).not.toHaveProperty('requestBodyRef');
    expect(existsSync(join(contentRoot, 'trajectory/provider-calls/obs-redaction-failed/request.txt')))
      .toBe(false);
  });

  it('applies provider observation retention to observations and provider-call segments', () => {
    const store = new InMemoryTrajectoryStore();
    const service = new ProviderCaptureService({
      config: providerConfig({ enabled: true, mode: 'transcript-only', retentionDays: 30 }),
      store,
      now: () => new Date('2026-06-23T11:00:00.000Z'),
      idFactory: fixedIdFactory('obs-old', 'obs-new'),
    });

    service.recordProviderCall({
      backend: 'codex',
      captureMode: 'transcript-only',
      sessionId: 'sess-1',
      traceId: 'trace-old',
      requestStartedAt: new Date('2026-05-01T00:00:00.000Z'),
      alignment: { confidence: 'low', reasons: ['old'] },
      trajectorySequence: 1,
    });
    service.recordProviderCall({
      backend: 'codex',
      captureMode: 'transcript-only',
      sessionId: 'sess-1',
      traceId: 'trace-new',
      requestStartedAt: new Date('2026-06-20T00:00:00.000Z'),
      alignment: { confidence: 'low', reasons: ['new'] },
      trajectorySequence: 2,
    });

    expect(service.applyRetention()).toEqual({ deletedObservations: 1 });
    expect(store.getProviderCallObservation('obs-old')).toBeUndefined();
    expect(store.getProviderCallObservation('obs-new')).toBeDefined();
    expect(store.queryTrajectory({ source: 'provider-call' }).segments.map((s) => s.providerObservationId))
      .toEqual(['obs-new']);
  });
});

function providerConfig(
  overrides: Partial<ProviderCaptureConfig> = {},
): ProviderCaptureConfig {
  return {
    ...DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.providerCapture,
    ...overrides,
  };
}

function usageInput(
  overrides: Partial<Parameters<ProviderCaptureService['recordUsageObservation']>[0]> = {},
): Parameters<ProviderCaptureService['recordUsageObservation']>[0] {
  return {
    backend: 'codex',
    sessionId: 'sess-1',
    traceId: 'trace-1',
    observedAt: new Date('2026-06-23T11:00:00.000Z'),
    agentEventSequence: 42,
    trajectorySequence: 1,
    usage: {
      model: 'gpt-5',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      costUsd: null,
      turnSequence: 3,
      toolCallsThisTurn: 1,
      wallClockMs: 1234,
      completeness: 'partial',
    },
    ...overrides,
  };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-nexus-provider-capture-'));
  tempDirs.push(dir);
  return dir;
}

function fixedNow(): Date {
  return new Date('2026-06-23T11:00:00.000Z');
}

function fixedIdFactory(...ids: string[]): () => string {
  let index = 0;
  return () => ids[Math.min(index++, ids.length - 1)] ?? 'obs-fallback';
}
