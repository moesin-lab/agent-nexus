import { describe, expect, it } from 'vitest';
import {
  InMemoryMessageQueue,
  QueueFullError,
  QueueItemCancelledError,
} from './message-queue.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('InMemoryMessageQueue', () => {
  it('runs one item at a time per key while allowing different keys to run in parallel', async () => {
    const queue = new InMemoryMessageQueue();
    const firstGate = deferred<void>();
    const order: string[] = [];

    const first = queue.enqueue({
      key: 'k1',
      kind: 'message',
      traceId: 't1',
      label: 'first',
      run: async () => {
        order.push('k1:first:start');
        await firstGate.promise;
        order.push('k1:first:end');
      },
    });
    const second = queue.enqueue({
      key: 'k1',
      kind: 'message',
      traceId: 't2',
      label: 'second',
      run: async () => {
        order.push('k1:second');
      },
    });
    const other = queue.enqueue({
      key: 'k2',
      kind: 'message',
      traceId: 't3',
      label: 'other',
      run: async () => {
        order.push('k2:other');
      },
    });

    await other;
    expect(order).toEqual(['k1:first:start', 'k2:other']);

    firstGate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual([
      'k1:first:start',
      'k2:other',
      'k1:first:end',
      'k1:second',
    ]);
  });

  it('releases the per-key running slot after a worker failure', async () => {
    const queue = new InMemoryMessageQueue();
    const order: string[] = [];
    const failed = queue.enqueue({
      key: 'k1',
      kind: 'message',
      traceId: 't1',
      label: 'failed',
      run: async () => {
        order.push('failed');
        throw new Error('boom');
      },
    });
    const next = queue.enqueue({
      key: 'k1',
      kind: 'message',
      traceId: 't2',
      label: 'next',
      run: async () => {
        order.push('next');
      },
    });

    await expect(failed).rejects.toThrow('boom');
    await next;

    expect(order).toEqual(['failed', 'next']);
    expect(queue.snapshot('k1').recent.map((item) => item.status)).toEqual([
      'failed',
      'completed',
    ]);
  });

  it('cancels only pending items for a key', async () => {
    const queue = new InMemoryMessageQueue();
    const gate = deferred<void>();
    const onCancel: string[] = [];

    const running = queue.enqueue({
      key: 'k1',
      kind: 'message',
      traceId: 't1',
      label: 'running',
      run: async () => {
        await gate.promise;
      },
    });
    const pending = queue.enqueue({
      key: 'k1',
      kind: 'message',
      traceId: 't2',
      label: 'pending',
      onCancel: () => onCancel.push('pending'),
      run: async () => {
        throw new Error('pending should not run');
      },
    });

    expect(queue.clearPending('k1').cancelled).toBe(1);
    await expect(pending).rejects.toBeInstanceOf(QueueItemCancelledError);
    expect(onCancel).toEqual(['pending']);
    expect(queue.snapshot('k1')).toMatchObject({
      pendingCount: 0,
      running: expect.objectContaining({ label: 'running' }),
    });

    gate.resolve();
    await running;
  });

  it('rejects enqueue when per-key pending depth reaches the limit', async () => {
    const queue = new InMemoryMessageQueue({ maxPendingPerKey: 1 });
    const gate = deferred<void>();
    const running = queue.enqueue({
      key: 'k1',
      kind: 'message',
      traceId: 't1',
      label: 'running',
      run: async () => {
        await gate.promise;
      },
    });
    const pending = queue.enqueue({
      key: 'k1',
      kind: 'message',
      traceId: 't2',
      label: 'pending',
      run: async () => undefined,
    });

    expect(() =>
      queue.enqueue({
        key: 'k1',
        kind: 'message',
        traceId: 't3',
        label: 'overflow',
        run: async () => undefined,
      }),
    ).toThrow(QueueFullError);

    gate.resolve();
    await Promise.all([running, pending]);
  });

  it('moves, edits, inserts, and cancels pending items by id', async () => {
    const queue = new InMemoryMessageQueue();
    const gate = deferred<void>();
    const prompts = { second: 'second' };
    const order: string[] = [];

    const running = queue.enqueueWithHandle({
      key: 'k1',
      kind: 'message',
      traceId: 't1',
      label: 'running',
      run: async () => {
        await gate.promise;
      },
    });
    const second = queue.enqueueWithHandle({
      key: 'k1',
      kind: 'message',
      traceId: 't2',
      label: prompts.second,
      onEdit: (text) => {
        prompts.second = text;
      },
      run: async () => {
        order.push(prompts.second);
      },
    });
    const third = queue.enqueueWithHandle({
      key: 'k1',
      kind: 'message',
      traceId: 't3',
      label: 'third',
      run: async () => {
        order.push('third');
      },
    });
    const inserted = queue.enqueueWithHandle({
      key: 'k1',
      kind: 'message',
      traceId: 't4',
      label: 'inserted',
      position: 'front',
      run: async () => {
        order.push('inserted');
      },
    });

    expect(queue.editPending('k1', second.id, 'edited second')).toMatchObject({
      status: 'updated',
      item: expect.objectContaining({ label: 'edited second' }),
    });
    expect(queue.movePending('k1', third.id, 'up')).toMatchObject({
      status: 'moved',
    });
    expect(queue.cancelPendingItem('k1', second.id)).toMatchObject({
      status: 'cancelled',
    });
    await expect(second.done).rejects.toBeInstanceOf(QueueItemCancelledError);

    gate.resolve();
    await Promise.all([running.done, inserted.done, third.done]);

    expect(order).toEqual(['inserted', 'third']);
    expect(queue.snapshot('k1').recent.map((item) => item.status)).toEqual([
      'cancelled',
      'completed',
      'completed',
      'completed',
    ]);
  });
});
