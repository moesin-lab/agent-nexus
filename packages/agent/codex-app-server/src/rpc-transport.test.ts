import { describe, expect, it, vi } from 'vitest';
import {
  RpcProtocolError,
  RpcRequestTimeoutError,
  RpcTransport,
  type RpcFrameSink,
} from './rpc-transport.js';

class ControlledSink implements RpcFrameSink {
  readonly frames: string[] = [];
  readonly releases: Array<() => void> = [];

  async write(frame: string): Promise<void> {
    this.frames.push(frame);
    await new Promise<void>((resolve) => this.releases.push(resolve));
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('RpcTransport', () => {
  it('should_assign_monotonic_ids_and_wait_for_write_backpressure', async () => {
    const sink = new ControlledSink();
    const transport = new RpcTransport(sink, { requestTimeoutMs: 1000 });

    const first = transport.request('thread/read', { threadId: 'a' });
    const second = transport.request('thread/read', { threadId: 'b' });
    await flush();

    expect(sink.frames).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"thread/read","params":{"threadId":"a"}}\n',
    ]);

    sink.releases.shift()?.();
    await vi.waitFor(() => expect(sink.frames).toHaveLength(2));
    expect(JSON.parse(sink.frames[1]!)).toMatchObject({ id: 2, method: 'thread/read' });

    sink.releases.shift()?.();
    transport.receive({ id: 1, result: { thread: 'a' } });
    transport.receive({ id: 2, result: { thread: 'b' } });
    await expect(first).resolves.toEqual({ thread: 'a' });
    await expect(second).resolves.toEqual({ thread: 'b' });
  });

  it('should_reject_request_with_remote_error_without_failing_connection', async () => {
    const sink: RpcFrameSink = { write: vi.fn().mockResolvedValue(undefined) };
    const transport = new RpcTransport(sink, { requestTimeoutMs: 1000 });
    const request = transport.request('thread/read', { threadId: 'missing' });
    await flush();

    transport.receive({ id: 1, error: { code: -32000, message: 'missing' } });

    await expect(request).rejects.toMatchObject({
      code: -32000,
      message: 'RPC remote error code=-32000',
    });
    expect(transport.isFailed()).toBe(false);
  });

  it('should_timeout_only_after_frame_write_has_completed', async () => {
    vi.useFakeTimers();
    const sink = new ControlledSink();
    const transport = new RpcTransport(sink, { requestTimeoutMs: 50 });
    const request = transport.request('turn/start', { threadId: 't' });
    await flush();

    await vi.advanceTimersByTimeAsync(100);
    let settled = false;
    void request.catch(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    sink.releases.shift()?.();
    await flush();
    await vi.advanceTimersByTimeAsync(50);
    await expect(request).rejects.toBeInstanceOf(RpcRequestTimeoutError);
    vi.useRealTimers();
  });

  it('should_fail_closed_on_unknown_duplicate_or_late_response_id', async () => {
    const failures: Error[] = [];
    const sink: RpcFrameSink = { write: vi.fn().mockResolvedValue(undefined) };
    const transport = new RpcTransport(sink, {
      requestTimeoutMs: 1000,
      onFatal: (error) => failures.push(error),
    });

    expect(() => transport.receive({ id: 999, result: {} })).toThrow(
      RpcProtocolError,
    );
    expect(transport.isFailed()).toBe(true);
    expect(failures).toHaveLength(1);
  });

  it('should_reject_all_pending_requests_when_protocol_fails', async () => {
    const sink: RpcFrameSink = { write: vi.fn().mockResolvedValue(undefined) };
    const transport = new RpcTransport(sink, { requestTimeoutMs: 1000 });
    const one = transport.request('thread/read', { threadId: 'a' });
    const two = transport.request('thread/read', { threadId: 'b' });
    await flush();

    expect(() => transport.receive({ id: 1, result: {}, error: {} })).toThrow(
      RpcProtocolError,
    );
    await expect(one).rejects.toBeInstanceOf(RpcProtocolError);
    await expect(two).rejects.toBeInstanceOf(RpcProtocolError);
  });

  it('should_close_pending_requests_without_reporting_an_expected_shutdown_as_fatal', async () => {
    const fatal = vi.fn();
    const sink: RpcFrameSink = { write: vi.fn().mockResolvedValue(undefined) };
    const transport = new RpcTransport(sink, {
      requestTimeoutMs: 1000,
      onFatal: fatal,
    });
    const pending = transport.request('thread/read', { threadId: 'a' });
    await flush();

    transport.close(new RpcProtocolError('RPC transport stopped'));

    await expect(pending).rejects.toThrow(/stopped/);
    expect(transport.isFailed()).toBe(true);
    expect(fatal).not.toHaveBeenCalled();
  });

  it('should_not_dispatch_a_write_that_was_queued_before_close', async () => {
    const sink = new ControlledSink();
    const transport = new RpcTransport(sink, { requestTimeoutMs: 1000 });
    const first = transport.request('thread/read', { threadId: 'a' });
    const second = transport.request('thread/read', { threadId: 'b' });
    const firstRejected = expect(first).rejects.toThrow(/closed/);
    const secondRejected = expect(second).rejects.toThrow(/closed/);
    await flush();
    expect(sink.frames).toHaveLength(1);

    transport.close(new RpcProtocolError('RPC transport closed'));
    sink.releases.shift()?.();
    await flush();

    await Promise.all([firstRejected, secondRejected]);
    expect(sink.frames).toHaveLength(1);
  });

  it('should_fail_closed_on_wrong_jsonrpc_version_or_unhandled_ServerRequest', () => {
    const sink: RpcFrameSink = { write: vi.fn().mockResolvedValue(undefined) };
    const wrongVersion = new RpcTransport(sink, { requestTimeoutMs: 1000 });
    expect(() => wrongVersion.receive({ jsonrpc: '1.0', method: 'notification', params: {} }))
      .toThrow(/jsonrpc/);

    const unhandledRequest = new RpcTransport(sink, { requestTimeoutMs: 1000 });
    expect(() => unhandledRequest.receive({ id: 'server-1', method: 'approval', params: {} }))
      .toThrow(/handler/);
  });

  it('should_fail_closed_on_a_duplicate_ServerRequest_id', () => {
    const sink: RpcFrameSink = { write: vi.fn().mockResolvedValue(undefined) };
    const handler = vi.fn();
    const transport = new RpcTransport(sink, {
      requestTimeoutMs: 1000,
      onServerRequest: handler,
    });

    transport.receive({ id: 'server-1', method: 'approval', params: {} });
    expect(() => transport.receive({ id: 'server-1', method: 'approval', params: {} }))
      .toThrow(/duplicate/);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should_not_expose_string_ServerRequest_ids_in_protocol_errors', async () => {
    const secretId = 'secret-bearing-server-request-id';
    const sink: RpcFrameSink = { write: vi.fn().mockResolvedValue(undefined) };
    const receiving = new RpcTransport(sink, {
      requestTimeoutMs: 1000,
      onServerRequest: vi.fn(),
    });
    receiving.receive({ id: secretId, method: 'approval', params: {} });

    let receiveError: unknown;
    try {
      receiving.receive({ id: secretId, method: 'approval', params: {} });
    } catch (error) {
      receiveError = error;
    }
    expect(receiveError).toBeInstanceOf(RpcProtocolError);
    expect((receiveError as Error).message).not.toContain(secretId);

    const responding = new RpcTransport(sink, { requestTimeoutMs: 1000 });
    await responding.respondResult(secretId, {});
    await expect(responding.respondResult(secretId, {})).rejects.not.toThrow(secretId);
  });

  it('should_route_notifications_and_server_requests_without_confusing_responses', () => {
    const notifications: unknown[] = [];
    const serverRequests: unknown[] = [];
    const sink: RpcFrameSink = { write: vi.fn().mockResolvedValue(undefined) };
    const transport = new RpcTransport(sink, {
      requestTimeoutMs: 1000,
      onNotification: (frame) => notifications.push(frame),
      onServerRequest: (frame) => serverRequests.push(frame),
    });

    transport.receive({ method: 'thread/status/changed', params: { threadId: 't' } });
    transport.receive({ id: 'server-1', method: 'item/tool/requestUserInput', params: {} });

    expect(notifications).toHaveLength(1);
    expect(serverRequests).toHaveLength(1);
  });

  it('should_write_exactly_one_result_or_error_for_each_server_request', async () => {
    const sink: RpcFrameSink = { write: vi.fn().mockResolvedValue(undefined) };
    const transport = new RpcTransport(sink, { requestTimeoutMs: 1000 });

    await transport.respondResult('server-1', { decision: 'decline' });
    await expect(
      transport.respondError('server-1', -32601, 'duplicate'),
    ).rejects.toBeInstanceOf(RpcProtocolError);
    expect(sink.write).toHaveBeenCalledTimes(1);
  });

  it('should_write_a_notification_without_allocating_a_request_id', async () => {
    const sink: RpcFrameSink = { write: vi.fn().mockResolvedValue(undefined) };
    const transport = new RpcTransport(sink, { requestTimeoutMs: 1000 });

    await transport.notify('initialized', {});

    expect(sink.write).toHaveBeenCalledWith(
      '{"jsonrpc":"2.0","method":"initialized","params":{}}\n',
    );
  });
});
