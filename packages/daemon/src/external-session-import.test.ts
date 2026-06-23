import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type SessionKey } from '@agent-nexus/protocol';
import {
  DEFAULT_DAEMON_RUNTIME_CONFIG,
  type ExternalImportConfig,
} from './config.js';
import {
  CodexAppJsonlSessionSourceAdapter,
  ExternalSessionImportService,
  ExternalSessionImportServiceError,
  ClaudeCodeJsonlSessionSourceAdapter,
} from './external-session-import.js';
import { SessionStore } from './session-store.js';
import { InMemoryTrajectoryStore } from './trajectory-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('ExternalSessionImportService', () => {
  it('externalImport.enabled=false 时不扫描 source root', () => {
    const store = new InMemoryTrajectoryStore();
    const service = new ExternalSessionImportService({
      config: config({
        enabled: false,
        sources: [
          {
            adapter: 'codex-app-jsonl',
            root: join(tmpdir(), 'agent-nexus-missing-root'),
            projectPathAllowlist: ['/workspace/agent-nexus'],
          },
        ],
      }),
      store,
      adapters: [new CodexAppJsonlSessionSourceAdapter()],
      now: fixedNow,
    });

    expect(service.run()).toEqual({ imports: [] });
  });

  it('metadata-only discovery registers Codex App sessions without content refs', () => {
    const root = tempDir();
    writeJsonl(join(root, '2026', '06', '23', 'codex-session.jsonl'), [
      {
        type: 'session_meta',
        timestamp: '2026-06-23T08:00:00.000Z',
        payload: {
          id: 'codex-thread-1',
          cwd: '/workspace/agent-nexus',
          cli_version: '0.142.0',
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-23T08:01:00.000Z',
        payload: {
          type: 'user_message',
          text: 'Please inspect ANTHROPIC_API_KEY=sk-ant-secret',
        },
      },
    ]);
    const store = new InMemoryTrajectoryStore();
    const service = new ExternalSessionImportService({
      config: config({
        sources: [
          {
            adapter: 'codex-app-jsonl',
            root,
            projectPathAllowlist: ['/workspace/agent-nexus'],
          },
        ],
        metadataOnlyDiscovery: true,
        importContent: false,
      }),
      store,
      adapters: [new CodexAppJsonlSessionSourceAdapter()],
      now: fixedNow,
    });

    const result = service.run();

    expect(result.imports).toHaveLength(1);
    const importId = result.imports[0]!.record.importId;
    expect(store.getExternalSessionImport(importId)).toMatchObject({
      sourceAdapter: 'codex-app-jsonl',
      sourceSessionId: 'codex-thread-1',
      nativeSessionRef: 'codex-thread-1',
      state: 'registered',
      confidence: 'high',
      discoveredAt: '2026-06-23T10:00:00.000Z',
    });
    expect(store.queryTrajectory({ importId }).segments).toEqual([]);
    expect(store.getExternalSessionImport(importId)?.metadataJson).not.toContain(
      'sk-ant-secret',
    );
    expect(store.getExternalSessionImport(importId)?.metadataJson).not.toContain(
      'Please inspect',
    );
    expect(store.getExternalSessionImport(importId)?.metadataJson).not.toContain(root);
    expect(store.getExternalSessionImport(importId)?.metadataJson).not.toContain(
      'codex-session.jsonl',
    );
  });

  it('content import writes redacted managed trajectory segments for Codex App sessions', () => {
    const root = tempDir();
    const contentRoot = tempDir();
    writeJsonl(join(root, 'codex-session.jsonl'), [
      {
        type: 'session_meta',
        timestamp: '2026-06-23T08:00:00.000Z',
        payload: {
          id: 'codex-thread-2',
          cwd: '/workspace/agent-nexus',
          cli_version: '0.142.0',
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-23T08:01:00.000Z',
        payload: {
          type: 'user_message',
          text: 'Do not persist this prompt body sk-ant-secret',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-23T08:02:00.000Z',
        payload: {
          type: 'agent_message',
          text: 'Do not persist this answer body',
        },
      },
    ]);
    const store = new InMemoryTrajectoryStore();
    const service = new ExternalSessionImportService({
      config: config({
        sources: [
          {
            adapter: 'codex-app-jsonl',
            root,
            projectPathAllowlist: ['/workspace/agent-nexus'],
          },
        ],
        metadataOnlyDiscovery: false,
        importContent: true,
      }),
      store,
      adapters: [new CodexAppJsonlSessionSourceAdapter()],
      contentStorageRoot: contentRoot,
      now: fixedNow,
    });

    const result = service.run();

    const importId = result.imports[0]!.record.importId;
    expect(store.getExternalSessionImport(importId)).toMatchObject({
      state: 'imported',
      importedAt: '2026-06-23T10:00:00.000Z',
    });
    const segments = store.queryTrajectory({ importId }).segments;
    expect(segments.map((segment) => segment.kind)).toEqual([
      'user-message',
      'agent-message',
    ]);
    expect(segments.every((segment) => segment.source === 'external-import')).toBe(
      true,
    );
    expect(segments.every((segment) => !segment.sessionId)).toBe(true);
    expect(segments[0]?.contentRef).toMatch(
      new RegExp(`^trajectory/imports/${importId}/`),
    );
    const content = readFileSync(join(contentRoot, segments[0]!.contentRef!), 'utf8');
    expect(content).not.toContain('Do not persist this prompt body');
    expect(content).not.toContain('sk-ant-secret');
    expect(content).not.toContain(root);

    const second = service.run();
    expect(second.imports[0]!.record).toMatchObject({ state: 'imported' });
    expect(store.queryTrajectory({ importId }).segments).toHaveLength(2);
  });

  it('oversized and outside-allowlist candidates fail closed without segments', () => {
    const root = tempDir();
    writeJsonl(join(root, 'too-large.jsonl'), [
      {
        type: 'session_meta',
        timestamp: '2026-06-23T08:00:00.000Z',
        payload: {
          id: 'too-large',
          cwd: '/workspace/agent-nexus',
          note: 'x'.repeat(512),
        },
      },
    ]);
    writeJsonl(join(root, 'outside.jsonl'), [
      {
        type: 'session_meta',
        timestamp: '2026-06-23T08:00:00.000Z',
        payload: {
          id: 'outside',
          cwd: '/workspace/other',
        },
      },
    ]);
    const store = new InMemoryTrajectoryStore();
    const service = new ExternalSessionImportService({
      config: config({
        sources: [
          {
            adapter: 'codex-app-jsonl',
            root,
            projectPathAllowlist: ['/workspace/agent-nexus'],
          },
        ],
        importContent: true,
        maxFileBytes: 256,
      }),
      store,
      adapters: [new CodexAppJsonlSessionSourceAdapter()],
      contentStorageRoot: tempDir(),
      now: fixedNow,
    });

    const result = service.run();

    expect(result.imports).toHaveLength(2);
    expect(result.imports.map((item) => item.record.state)).toEqual([
      'rejected',
      'rejected',
    ]);
    expect(result.imports.flatMap((item) => item.candidate.unsupportedReasons))
      .toEqual(expect.arrayContaining(['file-too-large', 'outside-project-allowlist']));
    for (const item of result.imports) {
      expect(store.queryTrajectory({ importId: item.record.importId }).segments)
        .toEqual([]);
    }
  });

  it('unknown schema records a rejected import instead of throwing raw parser errors', () => {
    const root = tempDir();
    writeJsonl(join(root, 'unknown.jsonl'), [{ hello: 'world' }]);
    const store = new InMemoryTrajectoryStore();
    const service = new ExternalSessionImportService({
      config: config({
        sources: [
          {
            adapter: 'codex-app-jsonl',
            root,
            projectPathAllowlist: ['/workspace/agent-nexus'],
          },
        ],
      }),
      store,
      adapters: [new CodexAppJsonlSessionSourceAdapter()],
      now: fixedNow,
    });

    const result = service.run();

    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]!.record).toMatchObject({
      state: 'rejected',
      error: {
        code: 'external-source-unsupported',
        retryable: false,
      },
    });
    expect(result.imports[0]!.candidate.unsupportedReasons).toContain(
      'schema-unknown',
    );
  });

  it('discovers Claude Code sessions by sessionId and cwd metadata', () => {
    const root = tempDir();
    writeJsonl(join(root, 'project', 'claude-session-1.jsonl'), [
      {
        type: 'user',
        sessionId: 'claude-session-1',
        uuid: 'u1',
        timestamp: '2026-06-23T08:00:00.000Z',
        cwd: '/workspace/agent-nexus',
        message: { role: 'user', content: 'hello' },
      },
    ]);
    const store = new InMemoryTrajectoryStore();
    const service = new ExternalSessionImportService({
      config: config({
        sources: [
          {
            adapter: 'claude-code-jsonl',
            root,
            projectPathAllowlist: ['/workspace/agent-nexus'],
          },
        ],
      }),
      store,
      adapters: [new ClaudeCodeJsonlSessionSourceAdapter()],
      now: fixedNow,
    });

    const result = service.run();

    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]!.record).toMatchObject({
      sourceAdapter: 'claude-code-jsonl',
      sourceSessionId: 'claude-session-1',
      nativeSessionRef: 'claude-session-1',
      state: 'registered',
      confidence: 'medium',
    });
  });

  it('links a registered import into SessionStore and rejects backend mismatch without clearing the old ref', () => {
    const trajectoryStore = new InMemoryTrajectoryStore();
    const sessionStore = new SessionStore();
    const service = new ExternalSessionImportService({
      config: config(),
      store: trajectoryStore,
      sessionStore,
      adapters: [],
      now: fixedNow,
    });
    trajectoryStore.upsertExternalSessionImport({
      importId: 'imp-codex',
      sourceAdapter: 'codex-app-jsonl',
      sourceSessionId: 'codex-thread-3',
      sourcePathHash: 'sha256:path',
      nativeSessionRef: 'codex-thread-3',
      state: 'registered',
      confidence: 'high',
      metadataJson: '{"title":"Imported Codex"}',
      discoveredAt: '2026-06-23T09:00:00.000Z',
    });
    trajectoryStore.upsertExternalSessionImport({
      importId: 'imp-claude',
      sourceAdapter: 'claude-code-jsonl',
      sourceSessionId: 'claude-session-1',
      sourcePathHash: 'sha256:path2',
      nativeSessionRef: 'claude-session-1',
      state: 'registered',
      confidence: 'medium',
      metadataJson: '{"title":"Imported Claude"}',
      discoveredAt: '2026-06-23T09:00:00.000Z',
    });
    trajectoryStore.upsertExternalSessionImport({
      importId: 'imp-unknown',
      sourceAdapter: 'future-jsonl',
      sourceSessionId: 'future-session-1',
      sourcePathHash: 'sha256:path3',
      nativeSessionRef: 'future-session-1',
      state: 'registered',
      confidence: 'low',
      metadataJson: '{"title":"Imported Future"}',
      discoveredAt: '2026-06-23T09:00:00.000Z',
    });

    const binding = service.bindToRoutingSession({
      importId: 'imp-codex',
      sessionKey: routedKey(),
      agentOwner: 'codex',
    });

    expect(binding.nativeSessionRef).toBe('codex-thread-3');
    expect(sessionStore.get(routedKey())).toMatchObject({
      agentSessionId: 'codex-thread-3',
      title: 'Imported Codex',
    });
    expect(trajectoryStore.getExternalSessionImport('imp-codex')).toMatchObject({
      state: 'linked',
      linkedSessionId: sessionStore.ensureSessionId(routedKey()),
    });

    expect(() =>
      service.bindToRoutingSession({
        importId: 'imp-claude',
        sessionKey: routedKey(),
        agentOwner: 'codex',
      }),
    ).toThrow(ExternalSessionImportServiceError);
    expect(sessionStore.get(routedKey())?.agentSessionId).toBe('codex-thread-3');
    expect(trajectoryStore.getExternalSessionImport('imp-claude')).toMatchObject({
      state: 'registered',
    });
    expect(() =>
      service.bindToRoutingSession({
        importId: 'imp-unknown',
        sessionKey: routedKey(),
        agentOwner: 'codex',
      }),
    ).toThrow(ExternalSessionImportServiceError);
    expect(trajectoryStore.getExternalSessionImport('imp-unknown')).toMatchObject({
      state: 'registered',
    });
  });
});

function config(overrides: Partial<ExternalImportConfig> = {}): ExternalImportConfig {
  return {
    ...DEFAULT_DAEMON_RUNTIME_CONFIG.trajectory.externalImport,
    enabled: true,
    maxRecordsPerSession: 20,
    maxFileBytes: 1024 * 1024,
    ...overrides,
  };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-nexus-external-import-'));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(path: string, records: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    records.map((record) => JSON.stringify(record)).join('\n'),
    'utf8',
  );
}

function fixedNow(): Date {
  return new Date('2026-06-23T10:00:00.000Z');
}

function routedKey(): SessionKey {
  return {
    platformName: 'discord-main',
    platform: 'discord',
    channelId: 'C1',
    initiatorUserId: 'U1',
  };
}
