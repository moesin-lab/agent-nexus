import { describe, expect, it } from 'vitest';
import {
  InMemoryTrajectoryStore,
  TrajectoryStoreError,
  confidenceMeetsMinimum,
} from './trajectory-store.js';

describe('confidenceMeetsMinimum', () => {
  it('orders confidence and excludes unknown for any explicit minimum', () => {
    expect(confidenceMeetsMinimum('high', 'medium')).toBe(true);
    expect(confidenceMeetsMinimum('medium', 'medium')).toBe(true);
    expect(confidenceMeetsMinimum('low', 'medium')).toBe(false);
    expect(confidenceMeetsMinimum('unknown', 'low')).toBe(false);
    expect(confidenceMeetsMinimum('unknown', undefined)).toBe(true);
  });
});

describe('InMemoryTrajectoryStore', () => {
  it('redacts external import metadata on write', () => {
    const store = new InMemoryTrajectoryStore();

    store.upsertExternalSessionImport({
      importId: 'imp-1',
      sourceAdapter: 'codex-cli-jsonl',
      sourceSessionId: 'codex-session-1',
      sourcePathHash: 'sha256:path',
      nativeSessionRef: 'codex-native-1',
      state: 'registered',
      confidence: 'high',
      metadataJson:
        '{"summary":"ANTHROPIC_API_KEY=sk-ant-abc path=/home/node/.codex/sessions/a.jsonl"}',
      discoveredAt: '2026-06-23T08:00:00.000Z',
    });

    const imported = store.getExternalSessionImport('imp-1');
    expect(imported?.metadataJson).toContain('ANTHROPIC_API_KEY=<redacted>');
    expect(imported?.metadataJson).toContain('path=~/.codex/sessions/a.jsonl');
    expect(imported?.metadataJson).not.toContain('sk-ant-abc');
    expect(imported?.metadataJson).not.toContain('/home/node');
  });

  it('links a registered external import directly without requiring content import', () => {
    const store = new InMemoryTrajectoryStore();
    store.upsertExternalSessionImport({
      importId: 'imp-1',
      sourceAdapter: 'claude-code-jsonl',
      sourceSessionId: 'claude-session-1',
      sourcePathHash: 'sha256:path',
      nativeSessionRef: 'claude-native-1',
      state: 'registered',
      confidence: 'medium',
      metadataJson: '{}',
      discoveredAt: '2026-06-23T08:00:00.000Z',
    });

    const binding = store.linkExternalSession({
      importId: 'imp-1',
      sessionId: 'mem-1',
      nativeSessionRef: 'claude-native-1',
      linkedAt: '2026-06-23T08:01:00.000Z',
    });

    expect(binding).toEqual({
      sessionId: 'mem-1',
      importId: 'imp-1',
      sourceAdapter: 'claude-code-jsonl',
      sourceSessionId: 'claude-session-1',
      nativeSessionRef: 'claude-native-1',
      confidence: 'medium',
      linkedAt: '2026-06-23T08:01:00.000Z',
    });
    expect(store.getExternalSessionImport('imp-1')).toMatchObject({
      state: 'linked',
      linkedSessionId: 'mem-1',
      linkedAt: '2026-06-23T08:01:00.000Z',
      nativeSessionRef: 'claude-native-1',
    });
  });

  it('fails closed when linking without a native session ref', () => {
    const store = new InMemoryTrajectoryStore();
    store.upsertExternalSessionImport({
      importId: 'imp-1',
      sourceAdapter: 'codex-app-jsonl',
      sourceSessionId: 'codex-app-session-1',
      sourcePathHash: 'sha256:path',
      state: 'registered',
      confidence: 'low',
      metadataJson: '{}',
      discoveredAt: '2026-06-23T08:00:00.000Z',
    });

    expect(() =>
      store.linkExternalSession({
        importId: 'imp-1',
        sessionId: 'mem-1',
        linkedAt: '2026-06-23T08:01:00.000Z',
      }),
    ).toThrow(TrajectoryStoreError);
    expect(store.getExternalSessionImport('imp-1')?.state).toBe('registered');
  });

  it('rejects trajectory content refs that point at external raw transcript files', () => {
    const store = new InMemoryTrajectoryStore();

    try {
      store.appendTrajectorySegment({
        segmentId: 'seg-1',
        source: 'external-import',
        kind: 'user-message',
        importId: 'imp-1',
        sequence: 1,
        ts: '2026-06-23T08:00:00.000Z',
        summary: 'hello',
        contentRef: '/home/node/.codex/sessions/2026/06/23/session.jsonl',
        confidence: 'high',
        redactionState: 'redacted',
        metadataJson: '{}',
      });
      throw new Error('expected appendTrajectorySegment to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TrajectoryStoreError);
      expect((error as TrajectoryStoreError).code).toBe('invalid-content-ref');
    }
  });

  it('rejects managed-looking content refs with parent directory traversal', () => {
    const store = new InMemoryTrajectoryStore();

    expect(() =>
      store.appendTrajectorySegment({
        segmentId: 'seg-1',
        source: 'external-import',
        kind: 'user-message',
        importId: 'imp-1',
        sequence: 1,
        ts: '2026-06-23T08:00:00.000Z',
        summary: 'hello',
        contentRef: 'transcripts/../../home/node/.codex/session.jsonl',
        confidence: 'high',
        redactionState: 'redacted',
        metadataJson: '{}',
      }),
    ).toThrow(TrajectoryStoreError);
  });

  it('does not link rejected imports', () => {
    const store = new InMemoryTrajectoryStore();
    store.upsertExternalSessionImport({
      importId: 'imp-1',
      sourceAdapter: 'claude-code-jsonl',
      sourceSessionId: 'claude-session-1',
      sourcePathHash: 'sha256:path',
      nativeSessionRef: 'claude-native-1',
      state: 'rejected',
      confidence: 'medium',
      metadataJson: '{}',
      discoveredAt: '2026-06-23T08:00:00.000Z',
    });

    expect(() =>
      store.linkExternalSession({
        importId: 'imp-1',
        sessionId: 'mem-1',
        linkedAt: '2026-06-23T08:01:00.000Z',
      }),
    ).toThrow(TrajectoryStoreError);
    expect(store.getExternalSessionImport('imp-1')?.state).toBe('rejected');
  });

  it('queries trajectory segments in stable order and filters unknown confidence', () => {
    const store = new InMemoryTrajectoryStore();
    store.appendTrajectorySegment({
      segmentId: 'seg-unknown',
      sessionId: 'mem-1',
      source: 'external-import',
      kind: 'unknown',
      sequence: 2,
      ts: '2026-06-23T08:00:00.000Z',
      summary: 'schema drift',
      confidence: 'unknown',
      redactionState: 'metadata-only',
      metadataJson: '{}',
    });
    store.appendTrajectorySegment({
      segmentId: 'seg-high',
      sessionId: 'mem-1',
      source: 'nexus-agent-event',
      kind: 'agent-message',
      sequence: 1,
      ts: '2026-06-23T08:00:00.000Z',
      summary: 'safe message',
      confidence: 'high',
      redactionState: 'redacted',
      metadataJson: '{}',
    });

    expect(
      store.queryTrajectory({ sessionId: 'mem-1' }).segments.map((s) => s.segmentId),
    ).toEqual(['seg-high', 'seg-unknown']);
    expect(
      store.queryTrajectory({ sessionId: 'mem-1', minConfidence: 'low' }).segments.map(
        (s) => s.segmentId,
      ),
    ).toEqual(['seg-high']);
  });

  it('drops provider payload refs when redaction failed', () => {
    const store = new InMemoryTrajectoryStore();

    store.recordProviderCallObservation({
      observationId: 'obs-1',
      backend: 'codex',
      captureMode: 'reverse-proxy',
      requestStartedAt: '2026-06-23T08:00:00.000Z',
      requestSummary: 'Authorization: sk-ant-abc',
      requestBodyRef: 'trajectory/provider-calls/raw-request.json',
      responseBodyRef: 'trajectory/provider-calls/raw-response.json',
      streamFramesRef: 'trajectory/provider-calls/raw-stream.jsonl',
      requestBytes: 1200,
      redactionState: 'dropped',
      alignment: { confidence: 'low', reasons: ['redaction-failed'] },
      errorCode: 'provider-capture-redaction-failed',
      metadataJson: '{"secret":"sk-ant-def"}',
    });

    const observation = store.getProviderCallObservation('obs-1');
    expect(observation).toMatchObject({ redactionState: 'dropped' });
    expect(observation).not.toHaveProperty('requestBodyRef');
    expect(observation).not.toHaveProperty('responseBodyRef');
    expect(observation).not.toHaveProperty('streamFramesRef');
    expect(store.getProviderCallObservation('obs-1')?.requestSummary).toContain(
      '<redacted:secret>',
    );
    expect(store.getProviderCallObservation('obs-1')?.metadataJson).not.toContain(
      'sk-ant-def',
    );
  });

  it('does not keep provider payload refs for metadata-only observations', () => {
    const store = new InMemoryTrajectoryStore();

    store.recordProviderCallObservation({
      observationId: 'obs-1',
      backend: 'codex',
      captureMode: 'transcript-only',
      requestStartedAt: '2026-06-23T08:00:00.000Z',
      requestSummary: 'metadata only',
      requestBodyRef: 'trajectory/provider-calls/raw-request.json',
      responseBodyRef: 'trajectory/provider-calls/raw-response.json',
      streamFramesRef: 'trajectory/provider-calls/raw-stream.jsonl',
      requestBytes: 1200,
      redactionState: 'metadata-only',
      alignment: { confidence: 'low', reasons: ['metadata-only'] },
      metadataJson: '{}',
    });

    const observation = store.getProviderCallObservation('obs-1');
    expect(observation).not.toHaveProperty('requestBodyRef');
    expect(observation).not.toHaveProperty('responseBodyRef');
    expect(observation).not.toHaveProperty('streamFramesRef');
  });
});
