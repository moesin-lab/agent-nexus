import { describe, expect, it } from 'vitest';
import type { SessionKey } from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';
import { SessionStore } from './session-store.js';

const makeKey = (overrides: Partial<SessionKey> = {}): SessionKey => ({
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

  it('different platform/channel/user produce different map keys', () => {
    const store = new SessionStore();
    const k1 = makeKey({ platform: 'discord' });
    const k2 = makeKey({ platform: 'slack' });
    const k3 = makeKey({ channelId: 'C2' });
    const k4 = makeKey({ initiatorUserId: 'U2' });

    store.set(k1, { agentSessionId: 'sid-1', lastTurnAt: new Date(1) });
    store.set(k2, { agentSessionId: 'sid-2', lastTurnAt: new Date(2) });
    store.set(k3, { agentSessionId: 'sid-3', lastTurnAt: new Date(3) });
    store.set(k4, { agentSessionId: 'sid-4', lastTurnAt: new Date(4) });

    expect(store.size).toBe(4);
    expect(store.get(k1)?.agentSessionId).toBe('sid-1');
    expect(store.get(k2)?.agentSessionId).toBe('sid-2');
    expect(store.get(k3)?.agentSessionId).toBe('sid-3');
    expect(store.get(k4)?.agentSessionId).toBe('sid-4');

    // 序列化形式确认互不相同
    const ids = new Set([k1, k2, k3, k4].map(serializeSessionKey));
    expect(ids.size).toBe(4);
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
    store.set(makeKey({ channelId: 'A' }), {
      agentSessionId: 'sid-a',
      lastTurnAt: new Date(),
    });
    store.set(makeKey({ channelId: 'B' }), {
      agentSessionId: 'sid-b',
      lastTurnAt: new Date(),
    });
    expect(store.size).toBe(2);
    store.clearAll();
    expect(store.size).toBe(0);
    expect(store.get(makeKey({ channelId: 'A' }))).toBeUndefined();
  });
});
