import { describe, expect, it } from 'vitest';
import type { SessionKey } from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';
import { SessionStore } from './session-store.js';

const makeKey = (overrides: Partial<SessionKey> = {}): SessionKey => ({
  platformName: 'discord-main',
  platform: 'discord',
  channelId: 'C1',
  initiatorUserId: 'U1',
  ...overrides,
});

describe('SessionStore', () => {
  it('get on missing key returns undefined', () => {
    const store = new SessionStore();
    expect(store.get(makeKey())).toBeUndefined();
  });

  it('set then get returns the same entry', () => {
    const store = new SessionStore();
    const key = makeKey();
    const entry = { agentSessionId: 'sid-1', lastTurnAt: new Date(0) };
    store.set(key, entry);
    expect(store.get(key)).toEqual(entry);
    expect(store.size).toBe(1);
  });

  it('does not expose mutable current session state from get', () => {
    const store = new SessionStore();
    const key = makeKey();
    store.set(key, {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(1),
      nextSession: { workingDir: '/workspace/original' },
    });

    const current = store.get(key)!;
    current.agentSessionId = 'sid-mutated';
    current.nextSession!.workingDir = '/workspace/mutated';

    expect(store.get(key)).toMatchObject({
      agentSessionId: 'sid-1',
      nextSession: { workingDir: '/workspace/original' },
    });
    expect(
      store.listForUser({
        platformName: 'discord-main',
        platform: 'discord',
        initiatorUserId: 'U1',
        limit: 10,
      })[0],
    ).toMatchObject({
      agentSessionId: 'sid-1',
      nextSession: { workingDir: '/workspace/original' },
    });
  });

  it('ensureSessionId reuses a key-bound Nexus sessionId until delete', () => {
    const store = new SessionStore();
    const key = makeKey();

    const first = store.ensureSessionId(key);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(store.ensureSessionId(key)).toBe(first);
    expect(store.nextTrajectorySequence(first)).toBe(1);
    expect(store.nextTrajectorySequence(first)).toBe(2);

    store.set(key, { agentSessionId: 'sid-1', lastTurnAt: new Date(0) });
    expect(
      store.listForUser({
        platformName: 'discord-main',
        platform: 'discord',
        initiatorUserId: 'U1',
        limit: 1,
      })[0]?.sessionId,
    ).toBe(first);

    store.delete(key);
    const next = store.ensureSessionId(key);
    expect(next).not.toBe(first);
    expect(store.nextTrajectorySequence(next)).toBe(1);
  });

  it('different platformName/platform/channel/user produce different map keys', () => {
    const store = new SessionStore();
    const k1 = makeKey({ platformName: 'discord-main' });
    const k2 = makeKey({ platformName: 'discord-side' });
    const k3 = makeKey({ platform: 'slack' });
    const k4 = makeKey({ channelId: 'C2' });
    const k5 = makeKey({ initiatorUserId: 'U2' });

    store.set(k1, { agentSessionId: 'sid-1', lastTurnAt: new Date(1) });
    store.set(k2, { agentSessionId: 'sid-2', lastTurnAt: new Date(2) });
    store.set(k3, { agentSessionId: 'sid-3', lastTurnAt: new Date(3) });
    store.set(k4, { agentSessionId: 'sid-4', lastTurnAt: new Date(4) });
    store.set(k5, { agentSessionId: 'sid-5', lastTurnAt: new Date(5) });

    expect(store.size).toBe(5);
    expect(store.get(k1)?.agentSessionId).toBe('sid-1');
    expect(store.get(k2)?.agentSessionId).toBe('sid-2');
    expect(store.get(k3)?.agentSessionId).toBe('sid-3');
    expect(store.get(k4)?.agentSessionId).toBe('sid-4');
    expect(store.get(k5)?.agentSessionId).toBe('sid-5');

    // 序列化形式确认互不相同
    const ids = new Set([k1, k2, k3, k4, k5].map(serializeSessionKey));
    expect(ids.size).toBe(5);
  });

  it('delete returns true when present, false when missing', () => {
    const store = new SessionStore();
    const key = makeKey();
    store.set(key, { agentSessionId: 'sid-x', lastTurnAt: new Date() });
    expect(store.delete(key)).toBe(true);
    expect(store.delete(key)).toBe(false);
    expect(store.get(key)).toBeUndefined();
  });

  it('clearAll empties the store', () => {
    const store = new SessionStore();
    const keyA = makeKey({ channelId: 'A' });
    const keyB = makeKey({ channelId: 'B' });
    store.set(keyA, {
      agentSessionId: 'sid-a',
      lastTurnAt: new Date(),
    });
    store.set(keyB, {
      agentSessionId: 'sid-b',
      lastTurnAt: new Date(),
    });
    store.registerThread(keyA, {
      parentChannelId: 'C-parent',
      ownerUserId: 'U1',
      autoArchiveDurationMinutes: 1440,
    });
    store.setChannelWorkingDir(keyB, '/workspace/channel');

    expect(store.size).toBe(2);
    store.clearAll();

    expect(store.size).toBe(0);
    expect(store.get(keyA)).toBeUndefined();
    expect(store.findThreadByChannelId(keyA)).toBeUndefined();
    expect(store.getChannelWorkingDir(keyB)).toBeUndefined();
  });

  it('lists resumable sessions for the same platform user', () => {
    const store = new SessionStore();
    store.set(makeKey({ channelId: 'C1' }), {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(1),
      title: 'First question',
    });
    store.set(makeKey({ channelId: 'C2' }), {
      agentSessionId: 'sid-2',
      lastTurnAt: new Date(2),
      title: 'Second question',
    });
    store.set(makeKey({ initiatorUserId: 'U2' }), {
      agentSessionId: 'sid-other-user',
      lastTurnAt: new Date(3),
    });

    const sessions = store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    });

    expect(sessions.map((session) => session.agentSessionId)).toEqual([
      'sid-2',
      'sid-1',
    ]);
    expect(sessions[0]).toMatchObject({
      title: 'Second question',
      key: makeKey({ channelId: 'C2' }),
    });
    expect(sessions[0]).not.toHaveProperty('channelId');
    expect(sessions[0]).not.toHaveProperty('platformName');
    expect(sessions[0]).not.toHaveProperty('platform');
    expect(sessions[0]).not.toHaveProperty('initiatorUserId');
  });

  it('filters resumable sessions by compatible agent owner', () => {
    const store = new SessionStore();
    store.set(makeKey({ channelId: 'C-codex' }), {
      agentSessionId: 'sid-codex',
      agentOwner: 'codex',
      lastTurnAt: new Date(1),
    });
    store.set(makeKey({ channelId: 'C-claude' }), {
      agentSessionId: 'sid-claude',
      agentOwner: 'claudecode',
      lastTurnAt: new Date(2),
    });
    store.set(makeKey({ channelId: 'C-unknown' }), {
      agentSessionId: 'sid-unknown',
      lastTurnAt: new Date(3),
    });

    expect(
      store
        .listForUser({
          platformName: 'discord-main',
          platform: 'discord',
          initiatorUserId: 'U1',
          agentOwner: 'codex',
          limit: 10,
        })
        .map((session) => session.agentSessionId),
    ).toEqual(['sid-codex']);
  });

  it('does not list thread placeholders before an agent session exists', () => {
    const store = new SessionStore();
    const key = makeKey({ channelId: 'T1' });
    store.set(key, {
      lastTurnAt: new Date(1),
      title: 'Thread shell',
    });
    store.registerThread(key, {
      parentChannelId: 'C1',
      ownerUserId: 'U1',
      autoArchiveDurationMinutes: 1440,
    });

    expect(
      store.listForUser({
        platformName: 'discord-main',
        platform: 'discord',
        initiatorUserId: 'U1',
        limit: 10,
      }),
    ).toEqual([]);
  });

  it('preserves the first title when an existing session is refreshed', () => {
    const store = new SessionStore();
    const key = makeKey();
    store.set(key, {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(1),
      title: 'Original prompt',
    });
    store.set(key, {
      agentSessionId: 'sid-2',
      lastTurnAt: new Date(2),
    });

    expect(store.get(key)).toMatchObject({
      agentSessionId: 'sid-2',
      title: 'Original prompt',
    });
  });

  it('preserves the agent session id when an existing session is refreshed without one', () => {
    const store = new SessionStore();
    const key = makeKey();
    store.set(key, {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(1),
      title: 'Original prompt',
    });
    store.set(key, {
      lastTurnAt: new Date(2),
    });

    expect(store.get(key)).toMatchObject({
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(2),
      title: 'Original prompt',
    });
  });

  it('archiveCurrent removes the active binding but keeps the session resumable', () => {
    const store = new SessionStore();
    const key = makeKey();
    store.set(key, {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(1),
      title: 'First prompt',
    });
    const firstSessionId = store.ensureSessionId(key);

    expect(store.archiveCurrent(key)).toBe(true);
    expect(store.get(key)).toBeUndefined();
    expect(store.ensureSessionId(key)).not.toBe(firstSessionId);
    store.set(key, {
      agentSessionId: 'sid-2',
      lastTurnAt: new Date(2),
      title: 'Second prompt',
    });

    expect(
      store
        .listForUser({
          platformName: 'discord-main',
          platform: 'discord',
          initiatorUserId: 'U1',
          limit: 10,
        })
        .map((session) => session.agentSessionId),
    ).toEqual(['sid-2', 'sid-1']);
  });

  it('archiveCurrent releases an empty generation before a session entry exists', () => {
    const store = new SessionStore();
    const key = makeKey();
    const firstSessionId = store.ensureSessionId(key);

    expect(store.archiveCurrent(key)).toBe(false);
    expect(store.ensureSessionId(key)).not.toBe(firstSessionId);
  });

  it('archiveCurrent discards a placeholder without an agent conversation ref', () => {
    const store = new SessionStore({ maxEntries: 2 });
    const realHistory = makeKey({ channelId: 'C-real' });
    const placeholder = makeKey({ channelId: 'C-placeholder' });
    const active = makeKey({ channelId: 'C-active' });
    store.set(realHistory, {
      agentSessionId: 'sid-real',
      lastTurnAt: new Date(1),
    });
    store.archiveCurrent(realHistory);
    store.setNextWorkingDir(placeholder, '/workspace/next', new Date(2));

    expect(store.archiveCurrent(placeholder)).toBe(true);
    store.set(active, {
      agentSessionId: 'sid-active',
      lastTurnAt: new Date(3),
    });

    expect(
      store
        .listForUser({
          platformName: 'discord-main',
          platform: 'discord',
          initiatorUserId: 'U1',
          limit: 10,
        })
        .map((session) => session.agentSessionId),
    ).toEqual(['sid-active', 'sid-real']);
  });

  it('evicts the oldest archived session when history exceeds capacity', () => {
    const store = new SessionStore({ maxEntries: 2 });
    const first = makeKey({ channelId: 'C1' });
    const second = makeKey({ channelId: 'C2' });
    const third = makeKey({ channelId: 'C3' });
    store.set(first, {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(1),
    });
    store.archiveCurrent(first);
    store.set(second, {
      agentSessionId: 'sid-2',
      lastTurnAt: new Date(2),
    });
    store.archiveCurrent(second);

    store.set(third, {
      agentSessionId: 'sid-3',
      lastTurnAt: new Date(3),
    });

    expect(
      store
        .listForUser({
          platformName: 'discord-main',
          platform: 'discord',
          initiatorUserId: 'U1',
          limit: 10,
        })
        .map((session) => session.agentSessionId),
    ).toEqual(['sid-3', 'sid-2']);
  });

  it('evicts inactive history before active sessions when capacity is exceeded', () => {
    const store = new SessionStore({ maxEntries: 2 });
    const active = makeKey({ channelId: 'C-active' });
    const oldHistory = makeKey({ channelId: 'C-old' });
    const newHistory = makeKey({ channelId: 'C-new' });
    store.set(active, {
      agentSessionId: 'sid-active',
      lastTurnAt: new Date(1),
    });
    store.set(oldHistory, {
      agentSessionId: 'sid-old',
      lastTurnAt: new Date(2),
    });
    store.archiveCurrent(oldHistory);

    store.set(newHistory, {
      agentSessionId: 'sid-new',
      lastTurnAt: new Date(3),
    });
    store.archiveCurrent(newHistory);

    expect(store.get(active)?.agentSessionId).toBe('sid-active');
    expect(
      store
        .listForUser({
          platformName: 'discord-main',
          platform: 'discord',
          initiatorUserId: 'U1',
          limit: 10,
        })
        .map((session) => session.agentSessionId),
    ).toEqual(['sid-new', 'sid-active']);
  });

  it('keeps active sessions when they alone exceed capacity', () => {
    const store = new SessionStore({ maxEntries: 1 });
    const first = makeKey({ channelId: 'C1' });
    const second = makeKey({ channelId: 'C2' });
    store.set(first, {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(1),
    });
    const firstSessionId = store.ensureSessionId(first);
    expect(store.nextTrajectorySequence(firstSessionId)).toBe(1);

    store.set(second, {
      agentSessionId: 'sid-2',
      lastTurnAt: new Date(2),
    });

    expect(store.get(first)?.agentSessionId).toBe('sid-1');
    expect(store.get(second)?.agentSessionId).toBe('sid-2');
    expect(store.nextTrajectorySequence(firstSessionId)).toBe(2);
  });

  it('evicts overflow as soon as an active session becomes history', () => {
    const store = new SessionStore({ maxEntries: 1 });
    const first = makeKey({ channelId: 'C1' });
    const second = makeKey({ channelId: 'C2' });
    store.set(first, {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(1),
    });
    store.set(second, {
      agentSessionId: 'sid-2',
      lastTurnAt: new Date(2),
    });

    store.archiveCurrent(first);

    expect(
      store
        .listForUser({
          platformName: 'discord-main',
          platform: 'discord',
          initiatorUserId: 'U1',
          limit: 10,
        })
        .map((session) => session.agentSessionId),
    ).toEqual(['sid-2']);
  });

  it('touch refreshes current and listed session recency', () => {
    const store = new SessionStore();
    const key = makeKey();
    store.set(key, {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(1),
    });

    expect(store.touch(key, new Date(2))).toBe(true);
    expect(store.get(key)?.lastTurnAt).toEqual(new Date(2));
    expect(
      store.listForUser({
        platformName: 'discord-main',
        platform: 'discord',
        initiatorUserId: 'U1',
        limit: 10,
      })[0]?.lastTurnAt,
    ).toEqual(new Date(2));
    expect(store.touch(makeKey({ channelId: 'missing' }), new Date(3))).toBe(
      false,
    );
  });

  it('bindExternalResumeToKey writes an imported native ref onto the existing routing session', () => {
    const store = new SessionStore();
    const key = makeKey();
    const sessionId = store.ensureSessionId(key);

    const rebound = store.bindExternalResumeToKey(key, {
      agentSessionId: 'codex-thread-imported',
      lastTurnAt: new Date(10),
      title: 'Imported Codex session',
    });

    expect(rebound).toEqual({
      agentSessionId: 'codex-thread-imported',
      lastTurnAt: new Date(10),
      title: 'Imported Codex session',
    });
    expect(store.ensureSessionId(key)).toBe(sessionId);
    expect(store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    })[0]).toMatchObject({
      sessionId,
      agentSessionId: 'codex-thread-imported',
      title: 'Imported Codex session',
    });
  });

  it('preserves registered thread metadata when the first agent session starts', () => {
    const store = new SessionStore();
    const key = makeKey({ channelId: 'T1' });
    store.set(key, {
      lastTurnAt: new Date(1),
      title: 'Thread shell',
    });
    store.registerThread(key, {
      parentChannelId: 'C1',
      ownerUserId: 'U1',
      autoArchiveDurationMinutes: 1440,
    });
    store.set(key, {
      agentSessionId: 'sid-thread',
      lastTurnAt: new Date(2),
      title: 'First prompt',
    });

    expect(store.get(key)).toMatchObject({
      agentSessionId: 'sid-thread',
      title: 'First prompt',
    });
    expect(store.findThreadByChannelId(key)).toMatchObject({
      parentChannelId: 'C1',
      ownerUserId: 'U1',
      autoArchiveDurationMinutes: 1440,
    });
  });

  it('finds daemon-created thread metadata by thread channel id', () => {
    const store = new SessionStore();
    store.registerThread(makeKey({ channelId: 'T1' }), {
      parentChannelId: 'C1',
      ownerUserId: 'U1',
      autoArchiveDurationMinutes: 1440,
    });

    expect(
      store.findThreadByChannelId({
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'T1',
      }),
    ).toMatchObject({ parentChannelId: 'C1', ownerUserId: 'U1' });
  });

  it('keeps registered thread metadata after deleting the routing session entry', () => {
    const store = new SessionStore();
    const key = makeKey({ channelId: 'T1' });
    store.set(key, {
      lastTurnAt: new Date(1),
    });
    store.registerThread(key, {
      parentChannelId: 'C1',
      ownerUserId: 'U1',
      autoArchiveDurationMinutes: 1440,
    });

    store.delete(key);

    expect(store.get(key)).toBeUndefined();
    expect(
      store.findThreadByChannelId({
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'T1',
      }),
    ).toMatchObject({ parentChannelId: 'C1', ownerUserId: 'U1' });
  });

  it('stores and consumes a one-shot next workingDir override per session key', () => {
    const store = new SessionStore();
    const parentKey = makeKey({ channelId: 'C1' });
    const threadKey = makeKey({ channelId: 'T1' });

    store.setNextWorkingDir(parentKey, '/workspace/parent', new Date(1));
    store.setNextWorkingDir(threadKey, '/workspace/thread', new Date(2));

    expect(store.consumeNextWorkingDir(threadKey)).toBe('/workspace/thread');
    expect(store.consumeNextWorkingDir(threadKey)).toBeUndefined();
    expect(store.consumeNextWorkingDir(parentKey)).toBe('/workspace/parent');
  });

  it('preserves pending next workingDir when the session entry is refreshed', () => {
    const store = new SessionStore();
    const key = makeKey();
    store.setNextWorkingDir(key, '/workspace/next', new Date(1));
    store.set(key, {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(2),
      title: 'Prompt',
    });

    expect(store.get(key)).toMatchObject({
      agentSessionId: 'sid-1',
      nextSession: { workingDir: '/workspace/next' },
    });
  });

  it('does not restore a consumed next workingDir when rebinding history', () => {
    const store = new SessionStore();
    const key = makeKey();
    store.setNextWorkingDir(key, '/workspace/next', new Date(1));
    store.set(key, {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(2),
    });
    const [session] = store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    });

    expect(store.consumeNextWorkingDir(key)).toBe('/workspace/next');
    store.archiveCurrent(key);

    expect(store.bindExistingToKey(key, session!.sessionId, new Date(3)))
      .not.toHaveProperty('nextSession');
  });

  it('does not expose mutable nextSession state from listed sessions', () => {
    const store = new SessionStore();
    const key = makeKey();
    store.setNextWorkingDir(key, '/workspace/next', new Date(1));
    store.set(key, {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(2),
    });

    const [session] = store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    });
    session!.nextSession!.workingDir = '/workspace/mutated';

    expect(store.get(key)?.nextSession).toEqual({
      workingDir: '/workspace/next',
    });
  });

  it('stores channel workingDir defaults separately from session entries', () => {
    const store = new SessionStore();
    const channel = {
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'C1',
    };
    store.setChannelWorkingDir(channel, '/tmp/channel');
    store.set(makeKey({ channelId: 'C1' }), {
      agentSessionId: 'sid-1',
      lastTurnAt: new Date(1),
    });

    expect(store.getChannelWorkingDir(channel)).toBe('/tmp/channel');
    store.delete(makeKey({ channelId: 'C1' }));
    expect(store.getChannelWorkingDir(channel)).toBe('/tmp/channel');
  });

  it('can bind an existing resumable session to a new session key', () => {
    const store = new SessionStore();
    const sourceKey = makeKey({ channelId: 'C-old' });
    const targetKey = makeKey({ channelId: 'C-new' });
    store.set(sourceKey, {
      agentSessionId: 'sid-old',
      lastTurnAt: new Date(1),
      title: 'Old prompt',
    });

    const [source] = store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    });
    expect(source).toBeDefined();

    const rebound = store.bindExistingToKey(targetKey, source!.sessionId, new Date(2));

    expect(rebound?.agentSessionId).toBe('sid-old');
    expect(store.get(targetKey)).toMatchObject({
      agentSessionId: 'sid-old',
      lastTurnAt: new Date(2),
      title: 'Old prompt',
    });
    expect(store.get(sourceKey)).toBeUndefined();
  });

  it('rejects rebinding a session owned by another agent backend', () => {
    const store = new SessionStore();
    const key = makeKey();
    store.set(key, {
      agentSessionId: 'sid-codex',
      agentOwner: 'codex',
      lastTurnAt: new Date(1),
    });
    const [session] = store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    });
    store.archiveCurrent(key);

    expect(
      store.bindExistingToKey(
        key,
        session!.sessionId,
        new Date(2),
        'claudecode',
      ),
    ).toBeUndefined();
    expect(store.get(key)).toBeUndefined();
  });

  it('rejects rebinding a session without an explicit agent owner', () => {
    const store = new SessionStore();
    const key = makeKey();
    store.set(key, {
      agentSessionId: 'sid-unknown',
      lastTurnAt: new Date(1),
    });
    const [session] = store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    });
    store.archiveCurrent(key);

    expect(
      store.bindExistingToKey(key, session!.sessionId, new Date(2), 'codex'),
    ).toBeUndefined();
  });

  it('moves pending next workingDir when rebinding a resumable session', () => {
    const store = new SessionStore();
    const sourceKey = makeKey({ channelId: 'C-old' });
    const targetKey = makeKey({ channelId: 'C-new' });
    store.setNextWorkingDir(sourceKey, '/workspace/next', new Date(1));
    store.set(sourceKey, {
      agentSessionId: 'sid-old',
      lastTurnAt: new Date(2),
      title: 'Old prompt',
    });
    const [source] = store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    });

    const rebound = store.bindExistingToKey(
      targetKey,
      source!.sessionId,
      new Date(3),
    );

    expect(rebound).toMatchObject({
      agentSessionId: 'sid-old',
      nextSession: { workingDir: '/workspace/next' },
    });
    expect(store.get(targetKey)).toMatchObject({
      agentSessionId: 'sid-old',
      nextSession: { workingDir: '/workspace/next' },
    });
    expect(store.get(sourceKey)).toBeUndefined();
  });

  it('replaces stale target session metadata when rebinding', () => {
    const store = new SessionStore();
    const sourceKey = makeKey({ channelId: 'C-old' });
    const targetKey = makeKey({ channelId: 'C-new' });
    store.set(sourceKey, {
      agentSessionId: 'sid-old',
      lastTurnAt: new Date(2),
      title: 'Old prompt',
    });
    store.setNextWorkingDir(targetKey, '/workspace/stale-target', new Date(1));
    store.set(targetKey, {
      agentSessionId: 'sid-target',
      lastTurnAt: new Date(1),
      title: 'Target prompt',
    });
    const source = store
      .listForUser({
        platformName: 'discord-main',
        platform: 'discord',
        initiatorUserId: 'U1',
        limit: 10,
      })
      .find((session) => session.key.channelId === 'C-old');

    store.bindExistingToKey(targetKey, source!.sessionId, new Date(3));

    expect(store.get(targetKey)).toMatchObject({
      agentSessionId: 'sid-old',
      title: 'Old prompt',
    });
    expect(store.get(targetKey)?.nextSession).toBeUndefined();
    expect(store.get(sourceKey)).toBeUndefined();
  });

  it('rebinding an archived same-key session preserves the displaced current session as resumable', () => {
    const store = new SessionStore();
    const key = makeKey();
    store.set(key, {
      agentSessionId: 'sid-old',
      lastTurnAt: new Date(1),
      title: 'Old prompt',
    });
    const [oldSession] = store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    });
    store.archiveCurrent(key);
    store.set(key, {
      agentSessionId: 'sid-current',
      lastTurnAt: new Date(2),
      title: 'Current prompt',
    });

    const rebound = store.bindExistingToKey(key, oldSession!.sessionId, new Date(3));

    expect(rebound).toMatchObject({
      agentSessionId: 'sid-old',
      title: 'Old prompt',
    });
    expect(store.get(key)).toMatchObject({
      agentSessionId: 'sid-old',
    });
    expect(
      store
        .listForUser({
          platformName: 'discord-main',
          platform: 'discord',
          initiatorUserId: 'U1',
          limit: 10,
        })
        .map((session) => session.agentSessionId),
    ).toEqual(['sid-old', 'sid-current']);
  });

  it('does not copy thread topology metadata when rebinding a resumable session', () => {
    const store = new SessionStore();
    const sourceKey = makeKey({ channelId: 'T-old' });
    const targetKey = makeKey({ channelId: 'C-new' });
    store.set(sourceKey, {
      agentSessionId: 'sid-thread',
      lastTurnAt: new Date(1),
      title: 'Thread prompt',
    });
    store.registerThread(sourceKey, {
      parentChannelId: 'C-parent',
      ownerUserId: 'U1',
      autoArchiveDurationMinutes: 1440,
    });
    const [source] = store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    });

    store.bindExistingToKey(targetKey, source!.sessionId, new Date(2));

    expect(store.get(targetKey)).toMatchObject({
      agentSessionId: 'sid-thread',
      title: 'Thread prompt',
    });
    expect(
      store.findThreadByChannelId({
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C-new',
      }),
    ).toBeUndefined();
    expect(store.findThreadByChannelId(sourceKey)).toMatchObject({
      parentChannelId: 'C-parent',
      ownerUserId: 'U1',
    });
  });

  it('lists a fixed topic session with its stored resume link', () => {
    const store = new SessionStore();
    const key = makeKey({
      platformName: 'lark-main',
      platform: 'lark',
      channelId: 'omt-topic-1',
    });
    store.registerThread(key, {
      parentChannelId: 'oc-chat-1',
      ownerUserId: 'U1',
      bindingMode: 'fixed',
      rootMessageId: 'om-root-1',
      url: 'https://applink.feishu.cn/client/message/open?messageId=om-root-1',
      parentUrl: 'https://applink.feishu.cn/client/chat/open?openChatId=oc-chat-1',
    });
    store.set(key, {
      agentSessionId: 'sid-topic-1',
      agentOwner: 'codex',
      lastTurnAt: new Date(1),
      title: 'Topic prompt',
    });

    expect(
      store.listForUser({
        platformName: 'lark-main',
        platform: 'lark',
        initiatorUserId: 'U1',
        limit: 10,
      }),
    ).toEqual([
      expect.objectContaining({
        key,
        sessionContainer: {
          kind: 'thread',
          bindingMode: 'fixed',
          parentChannelId: 'oc-chat-1',
          rootMessageId: 'om-root-1',
          url: 'https://applink.feishu.cn/client/message/open?messageId=om-root-1',
          parentUrl: 'https://applink.feishu.cn/client/chat/open?openChatId=oc-chat-1',
        },
      }),
    ]);
  });

  it('fills a missing topic link without erasing an already resolved link', () => {
    const store = new SessionStore();
    const key = makeKey({ channelId: 'omt-topic-1' });
    store.registerThread(key, {
      parentChannelId: 'oc-chat-1',
      ownerUserId: 'U1',
      bindingMode: 'fixed',
      rootMessageId: 'om-root-1',
      parentUrl: 'https://applink.feishu.cn/client/chat/open?openChatId=oc-chat-1',
    });
    store.registerThread(key, {
      parentChannelId: 'oc-chat-1',
      ownerUserId: 'U1',
      bindingMode: 'fixed',
      rootMessageId: 'om-root-1',
      url: 'https://applink.feishu.cn/client/message/open?messageId=om-root-1',
      parentUrl: 'https://applink.feishu.cn/client/chat/open?openChatId=oc-chat-1',
    });
    store.registerThread(key, {
      parentChannelId: 'oc-chat-1',
      ownerUserId: 'U1',
      bindingMode: 'fixed',
      rootMessageId: 'om-root-1',
    });

    expect(store.findThreadByChannelId(key)).toMatchObject({
      url: 'https://applink.feishu.cn/client/message/open?messageId=om-root-1',
      parentUrl: 'https://applink.feishu.cn/client/chat/open?openChatId=oc-chat-1',
    });
  });

  it('drops a stale fixed-topic link when the observed root message changes', () => {
    const store = new SessionStore();
    const key = makeKey({ channelId: 'omt-topic-1' });
    store.registerThread(key, {
      parentChannelId: 'oc-chat-1',
      ownerUserId: 'U1',
      bindingMode: 'fixed',
      rootMessageId: 'om-old-root',
      url: 'https://applink.feishu.cn/client/message/open?messageId=om-old-root',
    });

    store.registerThread(key, {
      parentChannelId: 'oc-chat-1',
      ownerUserId: 'U1',
      bindingMode: 'fixed',
      rootMessageId: 'om-new-root',
    });

    expect(store.findThreadByChannelId(key)).toMatchObject({
      rootMessageId: 'om-new-root',
    });
    expect(store.findThreadByChannelId(key)?.url).toBeUndefined();
  });

  it('atomically pins a fixed topic to its first agent identity', () => {
    const store = new SessionStore();
    const key = makeKey({ channelId: 'omt-topic-1' });
    store.registerThread(key, {
      parentChannelId: 'oc-chat-1',
      ownerUserId: 'U1',
      bindingMode: 'fixed',
      rootMessageId: 'om-root-1',
    });

    expect(
      store.claimFixedThreadAgent(key, {
        agentName: 'codex-dev',
        agentOwner: 'codex',
      }),
    ).toBe(true);
    expect(
      store.claimFixedThreadAgent(key, {
        agentName: 'codex-prod',
        agentOwner: 'codex',
      }),
    ).toBe(false);
    expect(
      store.claimFixedThreadAgent(key, {
        agentName: 'claude-prod',
        agentOwner: 'claudecode',
      }),
    ).toBe(false);
    expect(store.findThreadByChannelId(key)).toMatchObject({
      agentName: 'codex-dev',
      agentOwner: 'codex',
    });
  });

  it('does not bind another resumable session into a fixed topic', () => {
    const store = new SessionStore();
    const sourceKey = makeKey({ channelId: 'C-old' });
    const fixedTopicKey = makeKey({ channelId: 'omt-topic-1' });
    store.set(sourceKey, {
      agentSessionId: 'sid-old',
      agentOwner: 'codex',
      lastTurnAt: new Date(1),
    });
    const [source] = store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    });
    store.registerThread(fixedTopicKey, {
      parentChannelId: 'oc-chat-1',
      ownerUserId: 'U1',
      bindingMode: 'fixed',
      rootMessageId: 'om-root-1',
    });

    expect(
      store.bindExistingToKey(
        fixedTopicKey,
        source!.sessionId,
        new Date(2),
        'codex',
      ),
    ).toBeUndefined();
    expect(store.get(sourceKey)?.agentSessionId).toBe('sid-old');
    expect(store.get(fixedTopicKey)).toBeUndefined();
  });
});
