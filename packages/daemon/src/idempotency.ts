import type { SessionKey } from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';

export type IdempotencyStatus = 'processing' | 'processed' | 'failed';

export type IdempotencyDecision =
  | { kind: 'inserted' }
  | { kind: 'hit'; status: IdempotencyStatus };

export interface IdempotencyStore {
  checkAndSet(sessionKey: SessionKey, messageId: string): IdempotencyDecision;
  markProcessed(sessionKey: SessionKey, messageId: string): void;
  markFailed(sessionKey: SessionKey, messageId: string): void;
  clearAll(): void;
}

function keyFor(sessionKey: SessionKey, messageId: string): string {
  return `${serializeSessionKey(sessionKey)}:${messageId}`;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyStatus>();

  checkAndSet(sessionKey: SessionKey, messageId: string): IdempotencyDecision {
    const key = keyFor(sessionKey, messageId);
    const existing = this.entries.get(key);
    if (existing) return { kind: 'hit', status: existing };
    this.entries.set(key, 'processing');
    return { kind: 'inserted' };
  }

  markProcessed(sessionKey: SessionKey, messageId: string): void {
    this.entries.set(keyFor(sessionKey, messageId), 'processed');
  }

  markFailed(sessionKey: SessionKey, messageId: string): void {
    this.entries.set(keyFor(sessionKey, messageId), 'failed');
  }

  clearAll(): void {
    this.entries.clear();
  }
}
