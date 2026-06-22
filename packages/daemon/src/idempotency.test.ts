import { describe, expect, it } from 'vitest';
import { withPlatformName } from '@agent-nexus/protocol';
import { InMemoryIdempotencyStore } from './idempotency.js';

const sessionKey = withPlatformName(
  {
    platform: 'discord',
    channelId: 'C1',
    initiatorUserId: 'U1',
  },
  'discord-main',
);

describe('InMemoryIdempotencyStore', () => {
  it('first check inserts processing and replay hits the existing status', () => {
    const store = new InMemoryIdempotencyStore();

    expect(store.checkAndSet(sessionKey, 'm-1')).toEqual({ kind: 'inserted' });
    expect(store.checkAndSet(sessionKey, 'm-1')).toEqual({
      kind: 'hit',
      status: 'processing',
    });

    store.markProcessed(sessionKey, 'm-1');
    expect(store.checkAndSet(sessionKey, 'm-1')).toEqual({
      kind: 'hit',
      status: 'processed',
    });
  });

  it('records cancelled as a terminal replay status', () => {
    const store = new InMemoryIdempotencyStore();

    expect(store.checkAndSet(sessionKey, 'm-1')).toEqual({ kind: 'inserted' });
    store.markCancelled(sessionKey, 'm-1');

    expect(store.checkAndSet(sessionKey, 'm-1')).toEqual({
      kind: 'hit',
      status: 'cancelled',
    });
  });

  it('keys records by the routed session key and messageId pair', () => {
    const store = new InMemoryIdempotencyStore();
    const otherSessionKey = withPlatformName(
      {
        platform: 'discord',
        channelId: 'C2',
        initiatorUserId: 'U1',
      },
      'discord-main',
    );

    expect(store.checkAndSet(sessionKey, 'm-1')).toEqual({ kind: 'inserted' });
    expect(store.checkAndSet(otherSessionKey, 'm-1')).toEqual({
      kind: 'inserted',
    });
    expect(store.checkAndSet(sessionKey, 'm-2')).toEqual({ kind: 'inserted' });
  });

  it('clearAll drops prior replay state', () => {
    const store = new InMemoryIdempotencyStore();

    expect(store.checkAndSet(sessionKey, 'm-1')).toEqual({ kind: 'inserted' });
    store.clearAll();

    expect(store.checkAndSet(sessionKey, 'm-1')).toEqual({ kind: 'inserted' });
  });

  it('forget drops one message replay state without clearing the session', () => {
    const store = new InMemoryIdempotencyStore();

    expect(store.checkAndSet(sessionKey, 'm-1')).toEqual({ kind: 'inserted' });
    expect(store.checkAndSet(sessionKey, 'm-2')).toEqual({ kind: 'inserted' });
    store.markProcessed(sessionKey, 'm-1');
    store.markProcessed(sessionKey, 'm-2');

    store.forget(sessionKey, 'm-1');

    expect(store.checkAndSet(sessionKey, 'm-1')).toEqual({ kind: 'inserted' });
    expect(store.checkAndSet(sessionKey, 'm-2')).toEqual({
      kind: 'hit',
      status: 'processed',
    });
  });
});
