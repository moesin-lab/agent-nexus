import { describe, expect, it, vi } from 'vitest';
import {
  CodexProfileSessionCatalog,
  type CodexProfileSessionCatalogHostPort,
} from './profile-session-catalog.js';

class FakeHost implements CodexProfileSessionCatalogHostPort {
  readonly start = vi.fn();
  readonly notify = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
  readonly request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'initialize') {
      return {
        codexHome: '/profiles/codex-main',
        userAgent:
          'agent-nexus/0.148.0-alpha.9 (Mac OS; arm64) unknown (agent-nexus; 0.146.0)',
        platformFamily: 'unix',
        platformOs: process.platform === 'darwin' ? 'macos' : 'linux',
      };
    }
    if (method === 'thread/list') {
      return {
        data: [thread('thr-main')],
        nextCursor: null,
      };
    }
    if (method === 'thread/read') {
      expect(params).toEqual({ threadId: 'thr-main', includeTurns: true });
      return {
        thread: thread('thr-main', {
          turns: [
            turn('turn-completed', 'completed', [
              agentMessage('msg-commentary', '处理中', 'commentary'),
              agentMessage('msg-final', '最后一个完整回复', 'final_answer'),
            ]),
            turn('turn-interrupted', 'interrupted', [
              agentMessage('msg-interrupted', '不能用的中断回复', 'final_answer'),
            ]),
            turn('turn-running', 'inProgress', [
              agentMessage('msg-running', '不能用的进行中回复', 'final_answer'),
            ]),
          ],
        }),
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
}

describe('CodexProfileSessionCatalog', () => {
  it('只读扫描 profile，并用 Thread.id 与最后一个完成 turn 的 final_answer 建立恢复条目', async () => {
    const host = new FakeHost();
    const catalog = makeCatalog(host);

    const sessions = await catalog.listRecent({ limit: 20 });

    expect(sessions).toEqual([
      {
        nativeSessionRef: 'thr-main',
        updatedAt: new Date('2026-08-21T12:00:00.000Z'),
        workingDir: '/workspace/project',
        title: '已有 Codex session',
        lastCompletedTurnId: 'turn-completed',
        lastCompletedReply: '最后一个完整回复',
      },
    ]);
    expect(catalog.profileId()).toMatch(/^codex-profile:[0-9a-f]{64}$/);
    expect(catalog.profileId()).not.toContain('/profiles/codex-main');
    expect(host.start).toHaveBeenCalledOnce();
    expect(host.notify).toHaveBeenCalledWith('initialized', {});
    expect(host.request.mock.calls.map(([method]) => method)).toEqual([
      'initialize',
      'thread/list',
      'thread/read',
    ]);
    expect(host.request.mock.calls[1]![1]).toMatchObject({
      useStateDbOnly: true,
    });
    expect(host.stop).toHaveBeenCalledOnce();
  });

  it('过滤 ephemeral、subagent、活跃和 allowlist 外 session，并回退到完成 turn 最后一个 agentMessage', async () => {
    const host = new FakeHost();
    host.request.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'initialize') return initializeResponse();
      if (method === 'thread/list') {
        return {
          data: [
            thread('eligible'),
            thread('ephemeral', { ephemeral: true }),
            thread('subagent', { parentThreadId: 'parent' }),
            thread('active', { status: { type: 'active', activeFlags: [] } }),
            thread('outside', { cwd: '/workspace/other' }),
          ],
          nextCursor: null,
        };
      }
      if (method === 'thread/read') {
        expect(params).toEqual({ threadId: 'eligible', includeTurns: true });
        return {
          thread: thread('eligible', {
            name: null,
            preview: 'fallback title',
            turns: [
              turn('turn-1', 'completed', [
                agentMessage('msg-1', '第一段', null),
                agentMessage('msg-2', '最后一段', null),
              ]),
            ],
          }),
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const catalog = makeCatalog(host);

    await expect(catalog.listRecent({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({
        nativeSessionRef: 'eligible',
        title: 'fallback title',
        lastCompletedReply: '最后一段',
      }),
    ]);
    expect(
      host.request.mock.calls.filter(([method]) => method === 'thread/read'),
    ).toHaveLength(1);
  });

  it('协议漂移时 fail closed，且仍停止临时 app-server host', async () => {
    const host = new FakeHost();
    host.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') return initializeResponse();
      if (method === 'thread/list') return { data: 'not-an-array' };
      throw new Error(`unexpected method ${method}`);
    });
    const catalog = makeCatalog(host);

    await expect(catalog.listRecent({ limit: 20 })).rejects.toThrow(
      /thread\/list response/,
    );
    expect(host.stop).toHaveBeenCalledOnce();
  });

  it('thread/list 后候选变为 active 时不再返回，避免物化进行中的 session', async () => {
    const host = new FakeHost();
    host.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') return initializeResponse();
      if (method === 'thread/list') {
        return { data: [thread('became-active')], nextCursor: null };
      }
      if (method === 'thread/read') {
        return {
          thread: thread('became-active', {
            status: { type: 'active', activeFlags: [] },
            turns: [
              turn('turn-completed', 'completed', [
                agentMessage('msg-final', '旧回复', 'final_answer'),
              ]),
            ],
          }),
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const catalog = makeCatalog(host);

    await expect(catalog.listRecent({ limit: 20 })).resolves.toEqual([]);
  });

  it('拒绝未逐版本验证的 app-server，而不是按 minor 范围放行', async () => {
    const host = new FakeHost();
    host.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          ...initializeResponse(),
          userAgent:
            'agent-nexus/0.147.1 (Mac OS; arm64) unknown (agent-nexus; 0.146.0)',
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const catalog = makeCatalog(host);

    await expect(catalog.listRecent({ limit: 20 })).rejects.toThrow(
      /userAgent does not match/,
    );
    expect(host.stop).toHaveBeenCalledOnce();
  });
});

function makeCatalog(host: FakeHost): CodexProfileSessionCatalog {
  return new CodexProfileSessionCatalog(
    {
      bin: 'codex',
      codexHome: '/profiles/codex-main',
      allowedWorkingDirs: ['/workspace/project'],
      clientVersion: '0.146.0',
      requestTimeoutMs: 1_000,
      terminateGraceMs: 1_000,
    },
    {
      environment: { PATH: '/usr/bin:/bin' },
      canonicalizePath: (path) => path,
      createHost: () => host,
    },
  );
}

function initializeResponse(): Record<string, unknown> {
  return {
    codexHome: '/profiles/codex-main',
    userAgent:
      'agent-nexus/0.148.0-alpha.9 (Mac OS; arm64) unknown (agent-nexus; 0.146.0)',
    platformFamily: 'unix',
    platformOs: process.platform === 'darwin' ? 'macos' : 'linux',
  };
}

function thread(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    sessionId: `session-tree-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: '已有 Codex session',
    ephemeral: false,
    createdAt: 1_776_900_000,
    updatedAt: 1_787_313_600,
    status: { type: 'idle' },
    cwd: '/workspace/project',
    cliVersion: '0.146.0',
    source: 'cli',
    name: '已有 Codex session',
    turns: [],
    ...overrides,
  };
}

function turn(
  id: string,
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress',
  items: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    id,
    status,
    items,
    error: null,
    startedAt: 1_776_900_000,
    completedAt: status === 'completed' ? 1_776_900_100 : null,
  };
}

function agentMessage(
  id: string,
  text: string,
  phase: 'commentary' | 'final_answer' | null,
): Record<string, unknown> {
  return { type: 'agentMessage', id, text, phase };
}
