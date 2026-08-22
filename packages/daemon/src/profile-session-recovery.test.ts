import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentSessionCatalog,
  CreateThreadInput,
  RecoverableAgentSession,
} from '@agent-nexus/protocol';
import { ProfileSessionRecoveryService } from './profile-session-recovery.js';
import { SessionStore } from './session-store.js';
import { SqliteSessionPersistence } from './session-sqlite-store.js';
import {
  CURRENT_STATE_SCHEMA_VERSION,
  SqliteStateDatabase,
} from './state-db.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('ProfileSessionRecoveryService', () => {
  it('把 profile session 物化为 fixed topic，并在重启后保留精确 resume ref/workingDir/link', async () => {
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(3);
    const path = tempDbPath();
    const firstDatabase = new SqliteStateDatabase({ path });
    const firstSessions = sessionStore(firstDatabase);
    const createThread = vi.fn(async (input: CreateThreadInput) => ({
      threadId: 'omt_recovered_1',
      parentChannelId: input.parentChannelId,
      rootMessageId: 'om_root_1',
      url: 'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_recovered_1',
    }));
    const firstService = new ProfileSessionRecoveryService({
      database: firstDatabase.database,
      sessionStore: firstSessions,
      now: fixedNow,
    });

    await expect(firstService.sync(syncInput(createThread))).resolves.toEqual({
      discovered: 1,
      linked: 1,
      existing: 0,
      failed: 0,
      ambiguous: 0,
      retryable: 0,
      deferred: 0,
    });
    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        parentChannelId: 'oc_parent_1',
        initiatorUserId: 'ou_user_1',
        title: '恢复 Codex 工作',
        initialMessage: '这是最后一个完成 turn 的回复',
        idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
    );
    const key = {
      platformName: 'lark-main',
      platform: 'lark',
      channelId: 'omt_recovered_1',
      initiatorUserId: 'ou_user_1',
    };
    expect(firstSessions.get(key)).toMatchObject({
      agentSessionId: 'thr-native-1',
      agentOwner: 'codex',
      profileId: 'codex-profile:profile-1',
      workingDir: '/workspace/project',
      title: '恢复 Codex 工作',
    });
    expect(firstSessions.findThreadByChannelId(key)).toMatchObject({
      bindingMode: 'fixed',
      parentChannelId: 'oc_parent_1',
      ownerUserId: 'ou_user_1',
      rootMessageId: 'om_root_1',
      agentName: 'codex-main',
      agentOwner: 'codex',
      profileId: 'codex-profile:profile-1',
    });
    expect(
      JSON.stringify(
        firstDatabase.database
          .prepare('SELECT * FROM native_session_materializations')
          .all(),
      ),
    ).not.toContain('这是最后一个完成 turn 的回复');
    firstSessions.close();
    firstDatabase.close();

    const secondDatabase = new SqliteStateDatabase({ path });
    const secondSessions = sessionStore(secondDatabase);
    const secondService = new ProfileSessionRecoveryService({
      database: secondDatabase.database,
      sessionStore: secondSessions,
      now: fixedNow,
    });

    expect(secondSessions.get(key)).toMatchObject({
      agentSessionId: 'thr-native-1',
      workingDir: '/workspace/project',
    });
    await expect(secondService.sync(syncInput(createThread))).resolves.toEqual({
      discovered: 1,
      linked: 0,
      existing: 1,
      failed: 0,
      ambiguous: 0,
      retryable: 0,
      deferred: 0,
    });
    expect(createThread).toHaveBeenCalledTimes(1);
    secondSessions.close();
    secondDatabase.close();
  });

  it('普通 fixed topic 已绑定同一 native session 时，跨重启扫描不重复创建话题', async () => {
    const path = tempDbPath();
    const key = {
      platformName: 'lark-main',
      platform: 'lark',
      channelId: 'omt-existing-topic',
      initiatorUserId: 'ou_user_1',
    };
    const firstDatabase = new SqliteStateDatabase({ path });
    const firstSessions = sessionStore(firstDatabase);
    firstSessions.registerThread(key, {
      parentChannelId: 'oc_parent_1',
      ownerUserId: 'ou_user_1',
      bindingMode: 'fixed',
      rootMessageId: 'om_existing_root',
    });
    // 模拟 V3 之前已持久化、尚无 profileId 的普通 fixed topic。
    expect(
      firstSessions.claimFixedThreadAgent(key, {
        agentName: 'codex-main',
        agentOwner: 'codex',
      }),
    ).toBe(true);
    firstSessions.set(key, {
      agentSessionId: 'thr-native-1',
      agentOwner: 'codex',
      lastTurnAt: new Date('2026-08-21T12:00:00.000Z'),
      workingDir: '/workspace/project',
    });
    firstSessions.close();
    firstDatabase.close();

    const secondDatabase = new SqliteStateDatabase({ path });
    const secondSessions = sessionStore(secondDatabase);
    const createThread = vi.fn();
    const service = new ProfileSessionRecoveryService({
      database: secondDatabase.database,
      sessionStore: secondSessions,
      now: fixedNow,
    });

    await expect(service.sync(syncInput(createThread))).resolves.toEqual({
      discovered: 1,
      linked: 0,
      existing: 1,
      failed: 0,
      ambiguous: 0,
      retryable: 0,
      deferred: 0,
    });
    expect(createThread).not.toHaveBeenCalled();
    expect(secondSessions.findThreadByChannelId(key)).toMatchObject({
      profileId: 'codex-profile:profile-1',
    });
    expect(secondSessions.get(key)).toMatchObject({
      profileId: 'codex-profile:profile-1',
    });
    expect(
      secondDatabase.database
        .prepare('SELECT COUNT(*) AS count FROM native_session_materializations')
        .get(),
    ).toEqual({ count: 0 });
    secondSessions.close();
    secondDatabase.close();
  });

  it('不同父群并发扫描同一 native session 时只允许一个 durable operation 创建话题', async () => {
    const database = new SqliteStateDatabase({ path: tempDbPath() });
    const sessions = sessionStore(database);
    let releaseCreate!: () => void;
    const createBarrier = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createThread = vi.fn(async (input: CreateThreadInput) => {
      await createBarrier;
      return {
        threadId: `omt-${input.parentChannelId}`,
        parentChannelId: input.parentChannelId,
        rootMessageId: `om-${input.parentChannelId}`,
      };
    });
    const service = new ProfileSessionRecoveryService({
      database: database.database,
      sessionStore: sessions,
      now: fixedNow,
    });

    const first = service.sync(syncInput(createThread));
    await vi.waitFor(() => expect(createThread).toHaveBeenCalledOnce());
    const second = service.sync({
      ...syncInput(createThread),
      parentChannelId: 'oc_parent_2',
      traceId: 'trace-recovery-2',
    });
    releaseCreate();
    const results = await Promise.all([first, second]);

    expect(createThread).toHaveBeenCalledOnce();
    expect(results.reduce((sum, result) => sum + result.linked, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.ambiguous, 0)).toBe(1);
    expect(
      database.database
        .prepare(
          `SELECT COUNT(*) AS count, MIN(parent_channel_id) AS parentChannelId
           FROM native_session_materializations`,
        )
        .get(),
    ).toEqual({ count: 1, parentChannelId: 'oc_parent_1' });
    sessions.close();
    database.close();
  });

  it('远端成功、本地绑定失败时保留 container_created，重试只绑定而不重复建话题', async () => {
    const database = new SqliteStateDatabase({ path: tempDbPath() });
    const sessions = sessionStore(database);
    const originalBind = sessions.bindNativeResumeToFixedThread.bind(sessions);
    sessions.bindNativeResumeToFixedThread = vi.fn(() => {
      throw new Error('injected local transaction failure');
    });
    const createThread = vi.fn(async (input: CreateThreadInput) => ({
      threadId: 'omt_recovered_1',
      parentChannelId: input.parentChannelId,
      rootMessageId: 'om_root_1',
    }));
    const service = new ProfileSessionRecoveryService({
      database: database.database,
      sessionStore: sessions,
      now: fixedNow,
    });

    await expect(service.sync(syncInput(createThread))).resolves.toMatchObject({
      linked: 0,
      failed: 1,
    });
    expect(
      database.database
        .prepare('SELECT state FROM native_session_materializations')
        .get(),
    ).toEqual({ state: 'container_created' });

    sessions.bindNativeResumeToFixedThread = originalBind;
    await expect(service.sync(syncInput(createThread))).resolves.toMatchObject({
      linked: 1,
      failed: 0,
    });
    expect(createThread).toHaveBeenCalledOnce();
    database.close();
  });

  it('远端结果未知时持久化 ambiguous，后续扫描不盲重试', async () => {
    const database = new SqliteStateDatabase({ path: tempDbPath() });
    const sessions = sessionStore(database);
    let stateWhileDispatching: string | undefined;
    const createThread = vi.fn(async () => {
      stateWhileDispatching = (
        database.database
          .prepare('SELECT state FROM native_session_materializations')
          .get() as { state: string }
      ).state;
      throw Object.assign(new Error('timeout'), {
        creationOutcome: 'unknown' as const,
      });
    });
    const service = new ProfileSessionRecoveryService({
      database: database.database,
      sessionStore: sessions,
      now: fixedNow,
    });

    await expect(service.sync(syncInput(createThread))).resolves.toMatchObject({
      linked: 0,
      ambiguous: 1,
    });
    await expect(service.sync(syncInput(createThread))).resolves.toMatchObject({
      linked: 0,
      ambiguous: 1,
    });
    expect(createThread).toHaveBeenCalledOnce();
    expect(stateWhileDispatching).toBe('ambiguous');
    expect(
      database.database
        .prepare('SELECT state FROM native_session_materializations')
        .get(),
    ).toEqual({ state: 'ambiguous' });
    database.close();
  });

  it('确定未创建的 transient error 保留 planned，并允许下一次命令安全重试', async () => {
    const database = new SqliteStateDatabase({ path: tempDbPath() });
    const sessions = sessionStore(database);
    const createThread = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('rate limited before create'), {
          creationOutcome: 'not-created' as const,
          retryable: true,
        }),
      )
      .mockImplementationOnce(async (input: CreateThreadInput) => ({
        threadId: 'omt-recovered-after-retry',
        parentChannelId: input.parentChannelId,
        rootMessageId: 'om-root-after-retry',
      }));
    const service = new ProfileSessionRecoveryService({
      database: database.database,
      sessionStore: sessions,
      now: fixedNow,
    });

    await expect(service.sync(syncInput(createThread))).resolves.toMatchObject({
      linked: 0,
      retryable: 1,
      failed: 0,
    });
    expect(
      database.database
        .prepare('SELECT state FROM native_session_materializations')
        .get(),
    ).toEqual({ state: 'planned' });

    await expect(service.sync(syncInput(createThread))).resolves.toMatchObject({
      linked: 1,
      retryable: 0,
    });
    expect(createThread).toHaveBeenCalledTimes(2);
    database.close();
  });

  it('单次命令只创建有界批次，后续命令继续处理 deferred session', async () => {
    const database = new SqliteStateDatabase({ path: tempDbPath() });
    const sessions = sessionStore(database);
    const candidates = ['1', '2', '3'].map((suffix) =>
      recoverableSession({ nativeSessionRef: `thr-native-${suffix}` }),
    );
    const createThread = vi.fn(async (input: CreateThreadInput) => {
      const sequence = createThread.mock.calls.length;
      return {
        threadId: `omt-batch-${sequence}`,
        parentChannelId: input.parentChannelId,
        rootMessageId: `om-root-batch-${sequence}`,
      };
    });
    const service = new ProfileSessionRecoveryService({
      database: database.database,
      sessionStore: sessions,
      now: fixedNow,
    });
    const input = {
      ...syncInput(createThread),
      catalog: catalog(candidates),
      maxCreates: 2,
    };

    await expect(service.sync(input)).resolves.toMatchObject({
      linked: 2,
      deferred: 1,
    });
    expect(createThread).toHaveBeenCalledTimes(2);

    await expect(service.sync(input)).resolves.toMatchObject({
      linked: 1,
      existing: 2,
      deferred: 0,
    });
    expect(createThread).toHaveBeenCalledTimes(3);
    database.close();
  });
});

function syncInput(
  createThread: (input: CreateThreadInput) => Promise<{
    threadId: string;
    parentChannelId: string;
    rootMessageId?: string;
    url?: string;
  }>,
) {
  return {
    catalog: catalog([recoverableSession()]),
    agentName: 'codex-main',
    agentOwner: 'codex',
    platformName: 'lark-main',
    platform: 'lark',
    parentChannelId: 'oc_parent_1',
    ownerUserId: 'ou_user_1',
    traceId: 'trace-recovery-1',
    maxTextLength: 4000,
    createThread,
  };
}

function catalog(
  sessions: RecoverableAgentSession[],
): AgentSessionCatalog {
  return {
    profileId: () => 'codex-profile:profile-1',
    listRecent: vi.fn(async () => sessions),
  };
}

function recoverableSession(
  overrides: Partial<RecoverableAgentSession> = {},
): RecoverableAgentSession {
  return {
    nativeSessionRef: 'thr-native-1',
    updatedAt: new Date('2026-08-21T12:00:00.000Z'),
    workingDir: '/workspace/project',
    title: '恢复 Codex 工作',
    lastCompletedTurnId: 'turn-native-1',
    lastCompletedReply: '这是最后一个完成 turn 的回复',
    ...overrides,
  };
}

function sessionStore(database: SqliteStateDatabase): SessionStore {
  return new SessionStore({
    persistence: new SqliteSessionPersistence({
      database: database.database,
    }),
  });
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-nexus-profile-recovery-'));
  tempDirs.push(dir);
  return join(dir, 'state.sqlite');
}

function fixedNow(): Date {
  return new Date('2026-08-21T13:00:00.000Z');
}
