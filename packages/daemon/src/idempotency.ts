import type { SessionKey } from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';

export type IdempotencyStatus =
  | 'processing'
  | 'processed'
  | 'failed'
  | 'cancelled';

export type IdempotencyDecision =
  | { kind: 'inserted' }
  | { kind: 'hit'; status: IdempotencyStatus };

export interface IdempotencyStore {
  checkAndSet(sessionKey: SessionKey, idempotencyKey: string): IdempotencyDecision;
  markProcessed(sessionKey: SessionKey, idempotencyKey: string): void;
  markFailed(sessionKey: SessionKey, idempotencyKey: string): void;
  markCancelled(sessionKey: SessionKey, idempotencyKey: string): void;
  forget(sessionKey: SessionKey, idempotencyKey: string): void;
  clearAll(): void;
}

function keyFor(sessionKey: SessionKey, idempotencyKey: string): string {
  return `${serializeSessionKey(sessionKey)}:${idempotencyKey}`;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyStatus>();

  checkAndSet(sessionKey: SessionKey, idempotencyKey: string): IdempotencyDecision {
    const key = keyFor(sessionKey, idempotencyKey);
    const existing = this.entries.get(key);
    if (existing) return { kind: 'hit', status: existing };
    this.entries.set(key, 'processing');
    return { kind: 'inserted' };
  }

  markProcessed(sessionKey: SessionKey, idempotencyKey: string): void {
    this.entries.set(keyFor(sessionKey, idempotencyKey), 'processed');
  }

  markFailed(sessionKey: SessionKey, idempotencyKey: string): void {
    this.entries.set(keyFor(sessionKey, idempotencyKey), 'failed');
  }

  markCancelled(sessionKey: SessionKey, idempotencyKey: string): void {
    this.entries.set(keyFor(sessionKey, idempotencyKey), 'cancelled');
  }

  forget(sessionKey: SessionKey, idempotencyKey: string): void {
    this.entries.delete(keyFor(sessionKey, idempotencyKey));
  }

  clearAll(): void {
    this.entries.clear();
  }
}
