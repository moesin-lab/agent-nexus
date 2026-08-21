import { describe, expect, it, vi } from 'vitest';
import type { AppServerRpcPort, RpcRequestOptions } from './controller.js';
import {
  CodexProcessController,
  CodexProcessError,
  type CodexProcessStatus,
} from './process-controller.js';
import { RpcProtocolError, RpcRemoteError } from './rpc-transport.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakePort implements AppServerRpcPort {
  readonly requests: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: RpcRequestOptions;
  }> = [];
  readonly exec = deferred<unknown>();
  readonly startAck = deferred<unknown>();
  readonly writes: Deferred<unknown>[] = [];
  readonly terminate = deferred<unknown>();

  request(method: string, params: unknown, options?: RpcRequestOptions): Promise<unknown> {
    this.requests.push({ method, params: params as Record<string, unknown>, options });
    if (method === 'command/exec') return this.exec.promise;
    if (method === 'command/exec/write') {
      const value = params as { deltaBase64?: string };
      if (value.deltaBase64 === '' && this.requests.filter((entry) =>
        entry.method === 'command/exec/write').length === 1) {
        return this.startAck.promise;
      }
      const write = deferred<unknown>();
      this.writes.push(write);
      return write.promise;
    }
    if (method === 'command/exec/terminate') return this.terminate.promise;
    return Promise.reject(new Error(`unexpected ${method}`));
  }

  notify(): Promise<void> {
    return Promise.resolve();
  }

  respondExec(result: unknown): void {
    const request = this.requests.find((entry) => entry.method === 'command/exec');
    request?.options?.onResponse?.({ kind: 'result', result });
    this.exec.resolve(result);
  }

  rejectExec(error: Error): void {
    const request = this.requests.find((entry) => entry.method === 'command/exec');
    if (error instanceof RpcRemoteError) {
      request?.options?.onResponse?.({ kind: 'error', error });
    }
    this.exec.reject(error);
  }
}

class MultiProcessPort implements AppServerRpcPort {
  readonly requests: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: RpcRequestOptions;
  }> = [];
  private readonly execs = new Map<string, {
    pending: Deferred<unknown>;
    options?: RpcRequestOptions;
  }>();

  request(method: string, params: unknown, options?: RpcRequestOptions): Promise<unknown> {
    const input = params as Record<string, unknown>;
    this.requests.push({ method, params: input, options });
    if (method === 'command/exec') {
      const pending = deferred<unknown>();
      this.execs.set(input['processId'] as string, { pending, options });
      return pending.promise;
    }
    if (method === 'command/exec/write' || method === 'command/exec/terminate') {
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  }

  notify(): Promise<void> {
    return Promise.resolve();
  }

  complete(processId: string, exitCode = 0): void {
    const exec = this.execs.get(processId);
    if (!exec) throw new Error(`missing ${processId}`);
    const result = { exitCode, stdout: '', stderr: '' };
    exec.options?.onResponse?.({ kind: 'result', result });
    exec.pending.resolve(result);
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function controller(
  port: FakePort,
  overrides: Partial<ConstructorParameters<typeof CodexProcessController>[1]> = {},
): CodexProcessController {
  let id = 0;
  return new CodexProcessController(port, {
    workingDir: '/workspace',
    sandbox: 'workspace-write',
    addDirs: ['/extra'],
    terminateGraceMs: 500,
    idFactory: () => `opaque-${++id}`,
    ...overrides,
  });
}

async function startRunning(
  owner: CodexProcessController,
  port: FakePort,
): Promise<CodexProcessStatus> {
  const starting = owner.start({ argv: ['/usr/bin/tool', '--flag'] });
  await vi.waitFor(() => expect(port.requests).toHaveLength(2));
  port.startAck.resolve({});
  return starting;
}

describe('CodexProcessController', () => {
  it('should_admit_only_after_the_zero_byte_write_barrier_with_fixed_security_params', async () => {
    const port = new FakePort();
    const owner = controller(port);
    const starting = owner.start({ argv: ['/usr/bin/tool', '--flag'] });
    await vi.waitFor(() => expect(port.requests).toHaveLength(2));

    expect(port.requests).toEqual([
      {
        method: 'command/exec',
        params: {
          command: ['/usr/bin/tool', '--flag'],
          processId: 'opaque-2',
          cwd: '/workspace',
          streamStdin: true,
          streamStdoutStderr: true,
          disableTimeout: true,
          disableOutputCap: true,
          env: { CODEX_HOME: null },
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: ['/workspace', '/extra'],
            networkAccess: false,
          },
        },
        options: { timeoutMs: null, onResponse: expect.any(Function) },
      },
      {
        method: 'command/exec/write',
        params: { processId: 'opaque-2', deltaBase64: '' },
        options: undefined,
      },
    ]);

    let settled = false;
    void starting.finally(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    port.startAck.resolve({});
    await expect(starting).resolves.toMatchObject({
      handle: 'opaque-1',
      state: 'running',
      stdinOpen: true,
      nextCursor: 0,
    });
  });

  it('should_publish_a_quick_exit_without_waiting_for_a_late_start_barrier', async () => {
    const port = new FakePort();
    const owner = controller(port);
    const starting = owner.start({ argv: ['/usr/bin/true'] });
    await vi.waitFor(() => expect(port.requests).toHaveLength(2));

    port.respondExec({ exitCode: 0, stdout: '', stderr: '' });

    await expect(starting).resolves.toMatchObject({ state: 'exited', exitCode: 0 });
    port.startAck.reject(new Error('process already exited'));
    await flush();
    expect(owner.status('opaque-1')).toMatchObject({ state: 'exited', exitCode: 0 });
  });

  it('should_keep_binary_output_in_a_bounded_cursor_ring_and_report_gaps', async () => {
    const port = new FakePort();
    const owner = controller(port, {
      limits: {
        maxActiveProcesses: 4,
        maxTerminalRecords: 16,
        maxOutputBytes: 5,
        maxOutputChunks: 64,
        maxReadBytes: 64,
        maxIngressBytes: 64,
        maxStdinWriteBytes: 64,
        maxPendingStdinBytes: 256,
        maxPendingStdinWrites: 64,
      },
    });
    await startRunning(owner, port);

    owner.handleNotification({
      method: 'command/exec/outputDelta',
      params: {
        processId: 'opaque-2',
        stream: 'stdout',
        deltaBase64: Buffer.from([0, 1, 2]).toString('base64'),
        capReached: false,
      },
    });
    owner.handleNotification({
      method: 'command/exec/outputDelta',
      params: {
        processId: 'opaque-2',
        stream: 'stderr',
        deltaBase64: Buffer.from([3, 4, 5]).toString('base64'),
        capReached: false,
      },
    });

    const page = owner.readOutput({ handle: 'opaque-1', cursor: 0 });
    expect(page).toMatchObject({
      requestedCursor: 0,
      oldestCursor: 1,
      nextCursor: 6,
      truncatedBefore: true,
      status: { state: 'running' },
    });
    expect(Buffer.concat(page.chunks.map((chunk) =>
      Buffer.from(chunk.dataBase64, 'base64')))).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(page.chunks.map((chunk) => chunk.stream)).toEqual(['stdout', 'stderr']);
  });

  it('should_bound_output_chunk_metadata_even_for_tiny_alternating_deltas', async () => {
    const port = new FakePort();
    const owner = controller(port, {
      limits: {
        maxActiveProcesses: 4,
        maxTerminalRecords: 16,
        maxOutputBytes: 64,
        maxOutputChunks: 2,
        maxReadBytes: 64,
        maxIngressBytes: 64,
        maxStdinWriteBytes: 64,
        maxPendingStdinBytes: 256,
        maxPendingStdinWrites: 64,
      },
    });
    await startRunning(owner, port);

    for (const [index, stream] of ['stdout', 'stderr', 'stdout'].entries()) {
      owner.handleNotification({
        method: 'command/exec/outputDelta',
        params: {
          processId: 'opaque-2',
          stream,
          deltaBase64: Buffer.from([index]).toString('base64'),
          capReached: false,
        },
      });
    }

    const page = owner.readOutput({ handle: 'opaque-1', cursor: 0 });
    expect(page).toMatchObject({ oldestCursor: 1, nextCursor: 3, truncatedBefore: true });
    expect(page.chunks).toHaveLength(2);
    expect(Buffer.concat(page.chunks.map((chunk) =>
      Buffer.from(chunk.dataBase64, 'base64')))).toEqual(Buffer.from([1, 2]));
  });

  it('should_terminate_when_the_lifetime_output_limit_is_exceeded', async () => {
    const port = new FakePort();
    const owner = controller(port, {
      limits: {
        maxActiveProcesses: 4,
        maxTerminalRecords: 16,
        maxOutputBytes: 64,
        maxOutputChunks: 64,
        maxReadBytes: 64,
        maxIngressBytes: 3,
        maxStdinWriteBytes: 64,
        maxPendingStdinBytes: 256,
        maxPendingStdinWrites: 64,
      },
    });
    await startRunning(owner, port);

    owner.handleNotification({
      method: 'command/exec/outputDelta',
      params: {
        processId: 'opaque-2',
        stream: 'stdout',
        deltaBase64: Buffer.from('abc').toString('base64'),
        capReached: false,
      },
    });

    await vi.waitFor(() => expect(port.requests.some((request) =>
      request.method === 'command/exec/terminate')).toBe(true));
    expect(owner.status('opaque-1')).toMatchObject({
      state: 'terminating',
      failureCode: 'process_output_limit_reached',
    });
    port.terminate.resolve({});
    port.respondExec({ exitCode: 137, stdout: '', stderr: '' });
    await vi.waitFor(() => expect(owner.status('opaque-1')).toMatchObject({
      state: 'exited',
      exitCode: 137,
      failureCode: 'process_output_limit_reached',
    }));
  });

  it('should_fail_closed_when_a_capped_stream_emits_another_delta', async () => {
    const port = new FakePort();
    const onFatal = vi.fn();
    const owner = controller(port, { onFatal });
    await startRunning(owner, port);

    owner.handleNotification({
      method: 'command/exec/outputDelta',
      params: {
        processId: 'opaque-2',
        stream: 'stdout',
        deltaBase64: Buffer.from('first').toString('base64'),
        capReached: true,
      },
    });
    expect(owner.status('opaque-1')).toMatchObject({
      state: 'terminating',
      failureCode: 'process_upstream_output_truncated',
    });

    expect(() => owner.handleNotification({
      method: 'command/exec/outputDelta',
      params: {
        processId: 'opaque-2',
        stream: 'stdout',
        deltaBase64: '',
        capReached: true,
      },
    })).toThrowError(expect.objectContaining({ code: 'process_protocol_error' }));
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('should_serialize_stdin_close_admission_and_enforce_terminal_rejection', async () => {
    const port = new FakePort();
    const owner = controller(port);
    await startRunning(owner, port);

    const first = owner.writeStdin({
      handle: 'opaque-1',
      dataBase64: Buffer.from('one').toString('base64'),
    });
    const closing = owner.writeStdin({ handle: 'opaque-1', closeStdin: true });
    await vi.waitFor(() => expect(port.writes).toHaveLength(1));
    expect(port.requests.filter((entry) => entry.method === 'command/exec/write')).toHaveLength(2);
    expect(port.requests[2]).toMatchObject({
      method: 'command/exec/write',
      params: {
        processId: 'opaque-2',
        deltaBase64: Buffer.from('one').toString('base64'),
      },
    });
    expect(port.requests[2]!.params).not.toHaveProperty('dataBase64');
    await expect(owner.writeStdin({
      handle: 'opaque-1',
      dataBase64: Buffer.from('late').toString('base64'),
    })).rejects.toMatchObject({ code: 'process_stdin_closed' });

    port.writes[0]!.resolve({});
    await expect(first).resolves.toEqual({ acceptedBytes: 3, stdinOpen: false });
    await vi.waitFor(() => expect(port.writes).toHaveLength(2));
    port.writes[1]!.resolve({});
    await expect(closing).resolves.toEqual({ acceptedBytes: 0, stdinOpen: false });
  });

  it('should_wait_for_the_exec_terminal_and_coalesce_concurrent_terminate', async () => {
    const port = new FakePort();
    const owner = controller(port);
    await startRunning(owner, port);

    const first = owner.terminate('opaque-1');
    const second = owner.terminate('opaque-1');
    await vi.waitFor(() => expect(port.requests.filter((entry) =>
      entry.method === 'command/exec/terminate')).toHaveLength(1));
    expect(owner.status('opaque-1').state).toBe('terminating');

    port.terminate.resolve({});
    await flush();
    let firstSettled = false;
    void first.finally(() => {
      firstSettled = true;
    });
    await flush();
    expect(firstSettled).toBe(false);

    port.respondExec({ exitCode: 137, stdout: '', stderr: '' });
    await expect(first).resolves.toMatchObject({
      alreadyTerminal: false,
      status: { state: 'exited', exitCode: 137 },
    });
    await expect(second).resolves.toMatchObject({ status: { state: 'exited' } });
    await expect(owner.terminate('opaque-1')).resolves.toMatchObject({
      alreadyTerminal: true,
    });
  });

  it('should_not_duplicate_an_inflight_terminate_during_owner_stop', async () => {
    const port = new FakePort();
    const owner = controller(port);
    await startRunning(owner, port);

    const terminating = owner.terminate('opaque-1');
    await vi.waitFor(() => expect(port.requests.filter((entry) =>
      entry.method === 'command/exec/terminate')).toHaveLength(1));
    const stopping = owner.beginStop();
    await flush();
    expect(port.requests.filter((entry) =>
      entry.method === 'command/exec/terminate')).toHaveLength(1);

    port.terminate.resolve({});
    port.respondExec({ exitCode: 137, stdout: '', stderr: '' });
    await expect(terminating).resolves.toMatchObject({ status: { state: 'exited' } });
    await expect(stopping).resolves.toBeUndefined();
  });

  it('should_make_an_unconfirmed_terminate_fatal_for_the_whole_owner', async () => {
    vi.useFakeTimers();
    const port = new FakePort();
    const onFatal = vi.fn();
    const owner = controller(port, { terminateGraceMs: 50, onFatal });
    await startRunning(owner, port);

    const terminating = owner.terminate('opaque-1');
    const rejected = expect(terminating).rejects.toMatchObject({
      code: 'process_terminate_unconfirmed',
    });
    port.terminate.resolve({});
    await flush();
    await vi.advanceTimersByTimeAsync(50);

    await rejected;
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(() => owner.status('opaque-1')).toThrowError(
      expect.objectContaining({ code: 'process_terminate_unconfirmed' }),
    );
    vi.useRealTimers();
  });

  it('should_fail_the_owner_when_a_stdin_control_request_is_ambiguous', async () => {
    const port = new FakePort();
    const onFatal = vi.fn();
    const owner = controller(port, { onFatal });
    await startRunning(owner, port);

    const writing = owner.writeStdin({
      handle: 'opaque-1',
      dataBase64: Buffer.from('one').toString('base64'),
    });
    await vi.waitFor(() => expect(port.writes).toHaveLength(1));
    const queued = owner.writeStdin({
      handle: 'opaque-1',
      dataBase64: Buffer.from('two').toString('base64'),
    });
    port.writes[0]!.reject(new Error('request timed out'));

    await expect(writing).rejects.toMatchObject({ code: 'process_stdin_ambiguous' });
    await expect(queued).rejects.toMatchObject({ code: 'process_stdin_ambiguous' });
    expect(port.writes).toHaveLength(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(() => owner.status('opaque-1')).toThrowError(
      expect.objectContaining({ code: 'process_stdin_ambiguous' }),
    );
  });

  it('should_fail_closed_on_an_invalid_exec_final_without_an_unhandled_rejection', async () => {
    const port = new FakePort();
    const onFatal = vi.fn();
    const owner = controller(port, { onFatal });
    await startRunning(owner, port);

    expect(() => port.respondExec({
      exitCode: 0,
      stdout: 'duplicate output',
      stderr: '',
    })).toThrowError(expect.objectContaining({ code: 'process_protocol_error' }));

    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
    expect(() => owner.status('opaque-1')).toThrowError(
      expect.objectContaining({ code: 'process_protocol_error' }),
    );
  });

  it('should_enforce_stdin_write_and_pending_byte_limits', async () => {
    const port = new FakePort();
    const owner = controller(port, {
      limits: {
        maxActiveProcesses: 4,
        maxTerminalRecords: 16,
        maxOutputBytes: 64,
        maxOutputChunks: 64,
        maxReadBytes: 64,
        maxIngressBytes: 64,
        maxStdinWriteBytes: 2,
        maxPendingStdinBytes: 2,
        maxPendingStdinWrites: 64,
      },
    });
    await startRunning(owner, port);

    await expect(owner.writeStdin({
      handle: 'opaque-1',
      dataBase64: Buffer.from('abc').toString('base64'),
    })).rejects.toMatchObject({ code: 'process_stdin_too_large' });
    await expect(owner.writeStdin({
      handle: 'opaque-1',
      dataBase64: '!'.repeat(8),
    })).rejects.toMatchObject({ code: 'process_stdin_too_large' });
    const pending = owner.writeStdin({
      handle: 'opaque-1',
      dataBase64: Buffer.from('ab').toString('base64'),
    });
    await expect(owner.writeStdin({
      handle: 'opaque-1',
      dataBase64: Buffer.from('c').toString('base64'),
    })).rejects.toMatchObject({ code: 'process_stdin_backpressure' });
    await vi.waitFor(() => expect(port.writes).toHaveLength(1));
    port.writes[0]!.resolve({});
    await expect(pending).resolves.toMatchObject({ acceptedBytes: 2 });
  });

  it('should_reject_empty_noop_stdin_and_bound_pending_write_operations', async () => {
    const port = new FakePort();
    const owner = controller(port, {
      limits: {
        maxActiveProcesses: 4,
        maxTerminalRecords: 16,
        maxOutputBytes: 64,
        maxOutputChunks: 64,
        maxReadBytes: 64,
        maxIngressBytes: 64,
        maxStdinWriteBytes: 64,
        maxPendingStdinBytes: 256,
        maxPendingStdinWrites: 1,
      },
    });
    await startRunning(owner, port);

    await expect(owner.writeStdin({
      handle: 'opaque-1',
      dataBase64: '',
    })).rejects.toMatchObject({ code: 'process_invalid_stdin' });

    const pending = owner.writeStdin({
      handle: 'opaque-1',
      dataBase64: Buffer.from('a').toString('base64'),
    });
    await expect(owner.writeStdin({
      handle: 'opaque-1',
      dataBase64: Buffer.from('b').toString('base64'),
    })).rejects.toMatchObject({ code: 'process_stdin_backpressure' });
    await vi.waitFor(() => expect(port.writes).toHaveLength(1));
    port.writes[0]!.resolve({});
    await expect(pending).resolves.toMatchObject({ acceptedBytes: 1 });
  });

  it('should_enforce_active_process_and_terminal_record_limits', async () => {
    const port = new MultiProcessPort();
    const owner = controller(port, {
      limits: {
        maxActiveProcesses: 2,
        maxTerminalRecords: 2,
        maxOutputBytes: 64,
        maxOutputChunks: 64,
        maxReadBytes: 64,
        maxIngressBytes: 64,
        maxStdinWriteBytes: 64,
        maxPendingStdinBytes: 256,
        maxPendingStdinWrites: 64,
      },
    });

    const first = await owner.start({ argv: ['/usr/bin/one'] });
    const second = await owner.start({ argv: ['/usr/bin/two'] });
    await expect(owner.start({ argv: ['/usr/bin/three'] })).rejects.toMatchObject({
      code: 'process_limit_reached',
    });

    port.complete('opaque-2');
    await vi.waitFor(() => expect(owner.status(first.handle).state).toBe('exited'));
    const third = await owner.start({ argv: ['/usr/bin/three'] });
    port.complete('opaque-4');
    port.complete('opaque-6');
    await vi.waitFor(() => expect(owner.status(third.handle).state).toBe('exited'));

    expect(() => owner.status(first.handle)).toThrowError(
      expect.objectContaining({ code: 'process_not_found' }),
    );
    expect(owner.status(second.handle).state).toBe('exited');
    expect(owner.status(third.handle).state).toBe('exited');
  });

  it('should_fail_closed_on_an_unknown_process_notification_without_leaking_the_id', async () => {
    const port = new FakePort();
    const onFatal = vi.fn();
    const owner = controller(port, { onFatal });
    const secret = 'foreign-secret-process-id';

    let failure: unknown;
    try {
      owner.handleNotification({
        method: 'command/exec/outputDelta',
        params: {
          processId: secret,
          stream: 'stdout',
          deltaBase64: '',
          capReached: false,
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CodexProcessError);
    expect((failure as Error).message).not.toContain(secret);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('should_reject_output_received_after_the_synchronous_final_response', async () => {
    const port = new FakePort();
    const onFatal = vi.fn();
    const owner = controller(port, { onFatal });
    await startRunning(owner, port);

    port.respondExec({ exitCode: 0, stdout: '', stderr: '' });

    expect(() => owner.handleNotification({
      method: 'command/exec/outputDelta',
      params: {
        processId: 'opaque-2',
        stream: 'stdout',
        deltaBase64: Buffer.from('late').toString('base64'),
        capReached: false,
      },
    })).toThrowError(expect.objectContaining({ code: 'process_protocol_error' }));
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('should_mark_transport_loss_as_lost_but_remote_exec_rejection_as_failed', async () => {
    const lostPort = new FakePort();
    const lostOwner = controller(lostPort);
    await startRunning(lostOwner, lostPort);
    lostPort.rejectExec(new RpcProtocolError('transport closed'));
    await vi.waitFor(() => expect(lostOwner.status('opaque-1')).toMatchObject({
      state: 'lost',
      failureCode: 'process_connection_lost',
    }));
    lostOwner.confirmHostStopped();
    expect(lostOwner.status('opaque-1').state).toBe('lost');

    const failedPort = new FakePort();
    const failedOwner = controller(failedPort);
    const starting = failedOwner.start({ argv: ['/usr/bin/tool'] });
    await vi.waitFor(() => expect(failedPort.requests).toHaveLength(2));
    failedPort.rejectExec(new RpcRemoteError(-32_000, 'exec rejected'));
    await expect(starting).rejects.toMatchObject({ code: 'process_exec_failed' });
    expect(failedOwner.status('opaque-1')).toMatchObject({
      state: 'failed',
      failureCode: 'process_exec_failed',
    });
  });

  it('should_return_the_same_not_found_error_for_unknown_handles', () => {
    const owner = controller(new FakePort());

    for (const operation of [
      () => owner.status('unknown'),
      () => owner.readOutput({ handle: 'unknown', cursor: 0 }),
    ]) {
      expect(operation).toThrowError(expect.objectContaining({ code: 'process_not_found' }));
    }
  });

  it('should_keep_handles_private_to_one_process_owner', async () => {
    const portA = new FakePort();
    const ownerA = controller(portA);
    const ownerB = controller(new FakePort());
    const started = await startRunning(ownerA, portA);

    expect(() => ownerB.status(started.handle)).toThrowError(
      expect.objectContaining({ code: 'process_not_found' }),
    );
    expect(ownerA.status(started.handle).state).toBe('running');
  });
});
