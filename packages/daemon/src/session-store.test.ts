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
});
