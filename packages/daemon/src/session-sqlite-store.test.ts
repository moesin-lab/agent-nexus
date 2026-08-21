import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from './session-store.js';
import { SqliteSessionPersistence } from './session-sqlite-store.js';
import { SqliteStateDatabase, StateDatabaseError } from './state-db.js';
import type { SessionKey } from '@agent-nexus/protocol';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('SqliteSessionPersistence', () => {
  it('restores a fixed topic session and its exact resume link after reopen', () => {
    const path = tempDbPath();
    const key = topicKey();
    const firstDatabase = new SqliteStateDatabase({ path });
    const first = new SessionStore({
      persistence: new SqliteSessionPersistence({
        database: firstDatabase.database,
      }),
    });
    first.set(key, {
      agentSessionId: 'opaque-ref-1',
      agentOwner: 'codex',
      lastTurnAt: new Date('2026-08-21T10:00:00.000Z'),
      title: 'persistent topic',
      workingDir: '/workspace/project',
      nextSession: { workingDir: '/workspace/next' },
    });
    const sessionId = first.ensureSessionId(key);
    first.registerThread(key, {
      parentChannelId: 'oc-chat-1',
      ownerUserId: 'ou-user-1',
      bindingMode: 'fixed',
      rootMessageId: 'om-root-1',
      url: 'https://applink.feishu.cn/client/thread/open?open_thread_id=omt-topic-1',
      parentUrl:
        'https://applink.feishu.cn/client/chat/open?openChatId=oc-chat-1',
    });
    expect(
      first.claimFixedThreadAgent(key, {
        agentName: 'codex-dev',
        agentOwner: 'codex',
      }),
    ).toBe(true);
    first.close();
    firstDatabase.close();

    const secondDatabase = new SqliteStateDatabase({ path });
    const second = new SessionStore({
      persistence: new SqliteSessionPersistence({
        database: secondDatabase.database,
      }),
    });

    expect(second.ensureSessionId(key)).toBe(sessionId);
    expect(second.get(key)).toMatchObject({
      agentSessionId: 'opaque-ref-1',
      agentOwner: 'codex',
      title: 'persistent topic',
      workingDir: '/workspace/project',
      nextSession: { workingDir: '/workspace/next' },
    });
    expect(second.findThreadByChannelId(key)).toMatchObject({
      bindingMode: 'fixed',
      rootMessageId: 'om-root-1',
      url: 'https://applink.feishu.cn/client/thread/open?open_thread_id=omt-topic-1',
      agentName: 'codex-dev',
      agentOwner: 'codex',
    });
    expect(
      second.listForUser({
        platformName: 'lark-main',
        platform: 'lark',
        initiatorUserId: 'ou-user-1',
        agentOwner: 'codex',
        limit: 10,
      })[0]?.sessionContainer?.url,
    ).toBe(
      'https://applink.feishu.cn/client/thread/open?open_thread_id=omt-topic-1',
    );
    const row = secondDatabase.database
      .prepare(
        'SELECT generation, state FROM sessions WHERE session_id = ?',
      )
      .get(sessionId);
    expect(row).toEqual({ generation: 1, state: 'Interrupted' });
    second.close();
    secondDatabase.close();
  });

  it('preserves resumable history and advances generation for the same key', () => {
    const path = tempDbPath();
    const key = topicKey();
    const firstDatabase = new SqliteStateDatabase({ path });
    const first = new SessionStore({
      persistence: new SqliteSessionPersistence({
        database: firstDatabase.database,
      }),
    });
    first.set(key, {
      agentSessionId: 'opaque-ref-1',
      agentOwner: 'codex',
      lastTurnAt: new Date('2026-08-21T10:00:00.000Z'),
    });
    const firstSessionId = first.ensureSessionId(key);
    expect(first.archiveCurrent(key)).toBe(true);
    first.set(key, {
      agentSessionId: 'opaque-ref-2',
      agentOwner: 'codex',
      lastTurnAt: new Date('2026-08-21T11:00:00.000Z'),
    });
    const secondSessionId = first.ensureSessionId(key);
    first.close();
    firstDatabase.close();

    const secondDatabase = new SqliteStateDatabase({ path });
    const second = new SessionStore({
      persistence: new SqliteSessionPersistence({
        database: secondDatabase.database,
      }),
    });

    expect(second.get(key)?.agentSessionId).toBe('opaque-ref-2');
    expect(
      second
        .listForUser({
          platformName: 'lark-main',
          platform: 'lark',
          initiatorUserId: 'ou-user-1',
          agentOwner: 'codex',
          limit: 10,
        })
        .map((session) => session.agentSessionId),
    ).toEqual(['opaque-ref-2', 'opaque-ref-1']);
    expect(
      secondDatabase.database
        .prepare(
          `SELECT session_id, generation, state
           FROM sessions
           WHERE session_key = ?
           ORDER BY generation`,
        )
        .all('lark-main:lark:omt-topic-1:ou-user-1'),
    ).toEqual([
      { session_id: firstSessionId, generation: 1, state: 'Archived' },
      { session_id: secondSessionId, generation: 2, state: 'Interrupted' },
    ]);
    second.close();
    secondDatabase.close();
  });

  it('fails closed when persisted session metadata is invalid', () => {
    const path = tempDbPath();
    const database = new SqliteStateDatabase({ path });
    const store = new SessionStore({
      persistence: new SqliteSessionPersistence({
        database: database.database,
      }),
    });
    store.set(topicKey(), {
      agentSessionId: 'opaque-ref-1',
      lastTurnAt: new Date('2026-08-21T10:00:00.000Z'),
    });
    database.database.prepare("UPDATE sessions SET meta_json = '{'").run();

    expect(
      () =>
        new SessionStore({
          persistence: new SqliteSessionPersistence({
            database: database.database,
          }),
        }),
    ).toThrow(StateDatabaseError);
    database.close();
  });

  it('persists startup eviction before returning the hydrated store', () => {
    const path = tempDbPath();
    const firstDatabase = new SqliteStateDatabase({ path });
    const first = new SessionStore({
      maxEntries: 2,
      persistence: new SqliteSessionPersistence({
        database: firstDatabase.database,
      }),
    });
    const oldest = topicKey();
    const newest = { ...topicKey(), channelId: 'omt-topic-2' };
    first.set(oldest, {
      agentSessionId: 'opaque-ref-1',
      lastTurnAt: new Date('2026-08-21T10:00:00.000Z'),
    });
    first.archiveCurrent(oldest);
    first.set(newest, {
      agentSessionId: 'opaque-ref-2',
      lastTurnAt: new Date('2026-08-21T11:00:00.000Z'),
    });
    first.archiveCurrent(newest);
    firstDatabase.close();

    const secondDatabase = new SqliteStateDatabase({ path });
    const second = new SessionStore({
      maxEntries: 1,
      persistence: new SqliteSessionPersistence({
        database: secondDatabase.database,
      }),
    });

    expect(
      secondDatabase.database.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({ count: 1 });
    expect(
      second
        .listForUser({
          platformName: 'lark-main',
          platform: 'lark',
          initiatorUserId: 'ou-user-1',
          limit: 10,
        })
        .map((session) => session.agentSessionId),
    ).toEqual(['opaque-ref-2']);
    second.close();
    secondDatabase.close();
  });

  it('fails closed when the indexed session key disagrees with metadata', () => {
    const path = tempDbPath();
    const database = new SqliteStateDatabase({ path });
    const store = new SessionStore({
      persistence: new SqliteSessionPersistence({
        database: database.database,
      }),
    });
    store.set(topicKey(), {
      agentSessionId: 'opaque-ref-1',
      lastTurnAt: new Date('2026-08-21T10:00:00.000Z'),
    });
    database.database
      .prepare("UPDATE sessions SET session_key = 'different:key'")
      .run();

    expect(
      () =>
        new SessionStore({
          persistence: new SqliteSessionPersistence({
            database: database.database,
          }),
        }),
    ).toThrow(StateDatabaseError);
    database.close();
  });

  it('fails closed when persisted fixed metadata is incomplete', () => {
    const path = tempDbPath();
    const key = topicKey();
    const database = new SqliteStateDatabase({ path });
    const store = new SessionStore({
      persistence: new SqliteSessionPersistence({
        database: database.database,
      }),
    });
    store.set(key, {
      agentSessionId: 'opaque-ref-1',
      lastTurnAt: new Date('2026-08-21T10:00:00.000Z'),
    });
    store.registerThread(key, {
      parentChannelId: 'oc-chat-1',
      ownerUserId: 'ou-user-1',
      bindingMode: 'fixed',
      rootMessageId: 'om-root-1',
    });
    store.claimFixedThreadAgent(key, {
      agentName: 'codex-dev',
      agentOwner: 'codex',
    });
    const row = database.database
      .prepare('SELECT meta_json FROM sessions')
      .get() as { meta_json: string };
    const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
    delete meta['fixedThread'];
    database.database
      .prepare('UPDATE sessions SET meta_json = ?')
      .run(JSON.stringify(meta));

    expect(
      () =>
        new SessionStore({
          persistence: new SqliteSessionPersistence({
            database: database.database,
          }),
        }),
    ).toThrow(StateDatabaseError);
    database.close();
  });

  it('fails closed when fixed agent identity disagrees with the session row', () => {
    const path = tempDbPath();
    const key = topicKey();
    const database = new SqliteStateDatabase({ path });
    const store = new SessionStore({
      persistence: new SqliteSessionPersistence({
        database: database.database,
      }),
    });
    store.set(key, {
      agentSessionId: 'opaque-ref-1',
      agentOwner: 'codex',
      lastTurnAt: new Date('2026-08-21T10:00:00.000Z'),
    });
    store.registerThread(key, {
      parentChannelId: 'oc-chat-1',
      ownerUserId: 'ou-user-1',
      bindingMode: 'fixed',
      rootMessageId: 'om-root-1',
    });
    store.claimFixedThreadAgent(key, {
      agentName: 'codex-dev',
      agentOwner: 'codex',
    });
    database.database
      .prepare("UPDATE sessions SET agent_backend = 'claudecode'")
      .run();

    expect(
      () =>
        new SessionStore({
          persistence: new SqliteSessionPersistence({
            database: database.database,
          }),
        }),
    ).toThrow(StateDatabaseError);
    database.close();
  });

  it('fails closed when fixed topic owner disagrees with the session user', () => {
    const path = tempDbPath();
    const key = topicKey();
    const database = new SqliteStateDatabase({ path });
    const store = new SessionStore({
      persistence: new SqliteSessionPersistence({
        database: database.database,
      }),
    });
    store.set(key, {
      agentSessionId: 'opaque-ref-1',
      agentOwner: 'codex',
      lastTurnAt: new Date('2026-08-21T10:00:00.000Z'),
    });
    store.registerThread(key, {
      parentChannelId: 'oc-chat-1',
      ownerUserId: 'ou-user-1',
      bindingMode: 'fixed',
      rootMessageId: 'om-root-1',
    });
    store.claimFixedThreadAgent(key, {
      agentName: 'codex-dev',
      agentOwner: 'codex',
    });
    const row = database.database
      .prepare('SELECT meta_json FROM sessions')
      .get() as { meta_json: string };
    const meta = JSON.parse(row.meta_json) as {
      fixedThread: { ownerUserId: string };
    };
    meta.fixedThread.ownerUserId = 'ou-other-user';
    database.database
      .prepare('UPDATE sessions SET meta_json = ?')
      .run(JSON.stringify(meta));

    expect(
      () =>
        new SessionStore({
          persistence: new SqliteSessionPersistence({
            database: database.database,
          }),
        }),
    ).toThrow(StateDatabaseError);
    database.close();
  });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-nexus-session-'));
  tempDirs.push(dir);
  return join(dir, 'state.db');
}

function topicKey(): SessionKey {
  return {
    platformName: 'lark-main',
    platform: 'lark',
    channelId: 'omt-topic-1',
    initiatorUserId: 'ou-user-1',
  };
}
