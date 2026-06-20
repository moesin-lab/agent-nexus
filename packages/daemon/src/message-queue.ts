import { randomUUID } from 'node:crypto';
import type { NormalizedEvent } from '@agent-nexus/protocol';
import { serializeSessionKey, withPlatformName } from '@agent-nexus/protocol';

export type MessageQueueItemKind =
  | 'message'
  | 'agent-command'
  | 'daemon-state-command';

export type MessageQueueItemStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface MessageQueueItemView {
  id: string;
  key: string;
  kind: MessageQueueItemKind;
  status: MessageQueueItemStatus;
  traceId: string;
  label: string;
  eventId?: string;
  editableText?: string;
  enqueuedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  errorMessage?: string;
}

export interface MessageQueueSnapshot {
  key: string;
  running?: MessageQueueItemView;
  pending: MessageQueueItemView[];
  recent: MessageQueueItemView[];
  pendingCount: number;
  maxPendingPerKey: number;
  recentCounts: {
    completed: number;
    failed: number;
    cancelled: number;
  };
}

export interface MessageQueueOptions {
  maxPendingPerKey?: number;
  historyLimitPerKey?: number;
}

export interface MessageQueueEnqueueInput<T> {
  key: string;
  kind: MessageQueueItemKind;
  traceId: string;
  label: string;
  eventId?: string;
  editableText?: string;
  position?: 'front' | 'tail';
  run: () => T | Promise<T>;
  onCancel?: () => void;
  onEdit?: (text: string) => void;
}

export interface MessageQueueEnqueueResult<T> {
  id: string;
  done: Promise<T>;
}

interface MessageQueueItem<T> {
  view: MessageQueueItemView;
  run: () => T | Promise<T>;
  onCancel?: () => void;
  onEdit?: (text: string) => void;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  done: Promise<T>;
}

interface QueueState {
  running?: MessageQueueItem<unknown>;
  pending: MessageQueueItem<unknown>[];
  recent: MessageQueueItemView[];
}

export class QueueItemCancelledError extends Error {
  constructor(item: MessageQueueItemView) {
    super(`Queue item cancelled: ${item.label}`);
    this.name = 'QueueItemCancelledError';
  }
}

export class QueueFullError extends Error {
  constructor(
    readonly key: string,
    readonly maxPendingPerKey: number,
  ) {
    super(`Queue is full for ${key}`);
    this.name = 'QueueFullError';
  }
}

export function queueKeyFromEvent(
  event: NormalizedEvent,
  platformName: string,
): string {
  return serializeSessionKey(withPlatformName(event.sessionKey, platformName));
}

export class InMemoryMessageQueue {
  private readonly states = new Map<string, QueueState>();
  readonly maxPendingPerKey: number;
  private readonly historyLimitPerKey: number;

  constructor(options: MessageQueueOptions = {}) {
    this.maxPendingPerKey = options.maxPendingPerKey ?? 20;
    this.historyLimitPerKey = options.historyLimitPerKey ?? 50;
  }

  enqueue<T>(input: MessageQueueEnqueueInput<T>): Promise<T> {
    return this.enqueueWithHandle(input).done;
  }

  enqueueWithHandle<T>(
    input: MessageQueueEnqueueInput<T>,
  ): MessageQueueEnqueueResult<T> {
    const state = this.stateFor(input.key);
    if (state.pending.length >= this.maxPendingPerKey) {
      throw new QueueFullError(input.key, this.maxPendingPerKey);
    }

    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const done = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    done.catch(() => undefined);

    const item: MessageQueueItem<T> = {
      view: {
        id: randomUUID(),
        key: input.key,
        kind: input.kind,
        status: 'queued',
        traceId: input.traceId,
        label: input.label,
        ...(input.eventId ? { eventId: input.eventId } : {}),
        ...(input.editableText ? { editableText: input.editableText } : {}),
        enqueuedAt: new Date(),
      },
      run: input.run,
      onCancel: input.onCancel,
      onEdit: input.onEdit,
      resolve,
      reject,
      done,
    };
    if (input.position === 'front') {
      state.pending.unshift(item as MessageQueueItem<unknown>);
    } else {
      state.pending.push(item as MessageQueueItem<unknown>);
    }
    this.schedule(input.key, state);
    return { id: item.view.id, done };
  }

  isIdle(key: string): boolean {
    const state = this.states.get(key);
    return !state?.running && (state?.pending.length ?? 0) === 0;
  }

  snapshot(key: string): MessageQueueSnapshot {
    const state = this.states.get(key);
    const recent = state?.recent ?? [];
    return {
      key,
      ...(state?.running ? { running: { ...state.running.view } } : {}),
      pending: (state?.pending ?? []).map((item) => ({ ...item.view })),
      recent: recent.map((item) => ({ ...item })),
      pendingCount: state?.pending.length ?? 0,
      maxPendingPerKey: this.maxPendingPerKey,
      recentCounts: {
        completed: recent.filter((item) => item.status === 'completed').length,
        failed: recent.filter((item) => item.status === 'failed').length,
        cancelled: recent.filter((item) => item.status === 'cancelled').length,
      },
    };
  }

  clearPending(key: string): { cancelled: number } {
    const state = this.states.get(key);
    if (!state || state.pending.length === 0) {
      return { cancelled: 0 };
    }
    const pending = state.pending.splice(0);
    for (const item of pending) {
      this.cancelItem(state, item);
    }
    return { cancelled: pending.length };
  }

  cancelPendingItem(
    key: string,
    itemId: string,
  ): { status: 'cancelled'; item: MessageQueueItemView } | { status: 'not_found' } {
    const state = this.states.get(key);
    if (!state) return { status: 'not_found' };
    const index = state.pending.findIndex((item) => item.view.id === itemId);
    if (index < 0) return { status: 'not_found' };
    const [item] = state.pending.splice(index, 1);
    this.cancelItem(state, item!);
    return { status: 'cancelled', item: { ...item!.view } };
  }

  editPending(
    key: string,
    itemId: string,
    text: string,
    label = text,
  ):
    | { status: 'updated'; item: MessageQueueItemView }
    | { status: 'not_found' }
    | { status: 'not_editable' } {
    const item = this.findPending(key, itemId);
    if (!item) return { status: 'not_found' };
    if (!item.onEdit) return { status: 'not_editable' };
    item.onEdit(text);
    item.view.label = label;
    item.view.editableText = text;
    return { status: 'updated', item: { ...item.view } };
  }

  movePending(
    key: string,
    itemId: string,
    direction: 'up' | 'down',
  ):
    | { status: 'moved'; item: MessageQueueItemView }
    | { status: 'not_found' }
    | { status: 'unchanged'; item: MessageQueueItemView } {
    const state = this.states.get(key);
    if (!state) return { status: 'not_found' };
    const index = state.pending.findIndex((item) => item.view.id === itemId);
    if (index < 0) return { status: 'not_found' };
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= state.pending.length) {
      return { status: 'unchanged', item: { ...state.pending[index]!.view } };
    }
    const [item] = state.pending.splice(index, 1);
    state.pending.splice(target, 0, item!);
    return { status: 'moved', item: { ...item!.view } };
  }

  clearAll(): { cancelled: number } {
    let cancelled = 0;
    for (const key of this.states.keys()) {
      cancelled += this.clearPending(key).cancelled;
    }
    return { cancelled };
  }

  private schedule(key: string, state: QueueState): void {
    if (state.running) return;
    const item = state.pending.shift();
    if (!item) return;
    state.running = item;
    item.view.status = 'running';
    item.view.startedAt = new Date();

    void Promise.resolve()
      .then(() => item.run())
      .then(
        (value) => {
          item.view.status = 'completed';
          item.view.finishedAt = new Date();
          item.resolve(value);
        },
        (err: unknown) => {
          item.view.status = 'failed';
          item.view.finishedAt = new Date();
          item.view.errorMessage =
            err instanceof Error ? err.message : String(err);
          item.reject(err);
        },
      )
      .finally(() => {
        if (state.running === item) {
          state.running = undefined;
        }
        this.pushHistory(state, item.view);
        this.schedule(key, state);
      });
  }

  private stateFor(key: string): QueueState {
    const existing = this.states.get(key);
    if (existing) return existing;
    const state: QueueState = { pending: [], recent: [] };
    this.states.set(key, state);
    return state;
  }

  private pushHistory(state: QueueState, view: MessageQueueItemView): void {
    state.recent.push({ ...view });
    while (state.recent.length > this.historyLimitPerKey) {
      state.recent.shift();
    }
  }

  private findPending(
    key: string,
    itemId: string,
  ): MessageQueueItem<unknown> | undefined {
    return this.states.get(key)?.pending.find((item) => item.view.id === itemId);
  }

  private cancelItem(
    state: QueueState,
    item: MessageQueueItem<unknown>,
  ): void {
    item.view.status = 'cancelled';
    item.view.finishedAt = new Date();
    try {
      item.onCancel?.();
    } catch (err) {
      item.view.errorMessage =
        err instanceof Error ? err.message : String(err);
    }
    item.reject(new QueueItemCancelledError(item.view));
    this.pushHistory(state, item.view);
  }
}
