export type RpcId = number | string;

export interface RpcFrameSink {
  write(frame: string): Promise<void>;
}

export interface RpcTransportOptions {
  requestTimeoutMs: number;
  onFatal?: (error: Error) => void;
  onNotification?: (frame: Record<string, unknown>) => void;
  onServerRequest?: (frame: Record<string, unknown>) => void;
}

export class RpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcProtocolError';
  }
}

export class RpcRequestTimeoutError extends Error {
  constructor(readonly method: string, readonly id: number) {
    super(`RPC request ${method} (${id}) 超时`);
    this.name = 'RpcRequestTimeoutError';
  }
}

export class RpcRemoteError extends Error {
  constructor(readonly code: number, _remoteMessage: string, _remoteData?: unknown) {
    super(`RPC remote error code=${code}`);
    this.name = 'RpcRemoteError';
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function validId(value: unknown): value is RpcId {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && value.length > 0)
  );
}

function idKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function line(frame: Record<string, unknown>): string {
  return `${JSON.stringify(frame)}\n`;
}

export class RpcTransport {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly receivedServerIds = new Set<string>();
  private readonly respondedServerIds = new Set<string>();
  private writeTail: Promise<void> = Promise.resolve();
  private fatalError: RpcProtocolError | null = null;

  constructor(
    private readonly sink: RpcFrameSink,
    private readonly options: RpcTransportOptions,
  ) {
    if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) {
      throw new RpcProtocolError('requestTimeoutMs 必须是正整数');
    }
  }

  isFailed(): boolean {
    return this.fatalError !== null;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (typeof method !== 'string' || method.length === 0) {
      return Promise.reject(new RpcProtocolError('RPC method 必须是非空字符串'));
    }
    const id = this.nextId;
    this.nextId += 1;

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    const frame = line({ jsonrpc: '2.0', id, method, params });

    void this.enqueueWrite(frame)
      .then(() => {
        const pending = this.pending.get(id);
        if (!pending || this.fatalError) return;
        pending.timer = setTimeout(() => {
          const active = this.pending.get(id);
          if (!active) return;
          this.pending.delete(id);
          active.reject(new RpcRequestTimeoutError(method, id));
        }, this.options.requestTimeoutMs);
      })
      .catch((error: unknown) => {
        this.fail(
          new RpcProtocolError(
            `RPC pipe write 失败: ${error instanceof Error ? error.message : 'unknown'}`,
          ),
          false,
        );
      });

    return promise;
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.assertOpen();
    if (typeof method !== 'string' || method.length === 0) {
      throw new RpcProtocolError('RPC notification method 必须是非空字符串');
    }
    try {
      await this.enqueueWrite(line({ jsonrpc: '2.0', method, params }));
    } catch (error) {
      this.fail(
        new RpcProtocolError(
          `RPC notification write 失败: ${error instanceof Error ? error.message : 'unknown'}`,
        ),
        false,
      );
      throw this.fatalError;
    }
  }

  receive(frame: Record<string, unknown>): void {
    this.assertOpen();
    if (
      Object.prototype.hasOwnProperty.call(frame, 'jsonrpc') &&
      frame['jsonrpc'] !== '2.0'
    ) {
      this.throwFatal('RPC jsonrpc 必须是 "2.0"');
    }
    const method = frame['method'];
    const id = frame['id'];

    if (method !== undefined) {
      if (typeof method !== 'string' || method.length === 0) {
        this.throwFatal('RPC method 非法');
      }
      if (id === undefined) {
        this.options.onNotification?.(frame);
        return;
      }
      if (!validId(id)) this.throwFatal('ServerRequest id 非法');
      const key = idKey(id);
      if (this.receivedServerIds.has(key)) {
        this.throwFatal('ServerRequest id duplicate');
      }
      const handler = this.options.onServerRequest;
      if (!handler) this.throwFatal('ServerRequest handler 缺失');
      this.receivedServerIds.add(key);
      try {
        handler(frame);
      } catch {
        this.throwFatal('ServerRequest handler 抛出异常');
      }
      return;
    }

    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      this.throwFatal('RPC response 缺少有效 numeric id');
    }
    const hasResult = Object.prototype.hasOwnProperty.call(frame, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(frame, 'error');
    if (hasResult === hasError) {
      this.throwFatal('RPC response 必须恰有 result 或 error');
    }
    const pending = this.pending.get(id);
    if (!pending) this.throwFatal(`RPC response id ${id} unknown/duplicate/late`);
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);

    if (hasError) {
      const error = frame['error'];
      if (!error || typeof error !== 'object' || Array.isArray(error)) {
        this.throwFatal('RPC error payload 非法');
      }
      const body = error as Record<string, unknown>;
      if (typeof body['code'] !== 'number' || typeof body['message'] !== 'string') {
        this.throwFatal('RPC error 缺少 code/message');
      }
      pending.reject(new RpcRemoteError(body['code'], body['message'], body['data']));
      return;
    }
    pending.resolve(frame['result']);
  }

  async respondResult(id: RpcId, result: unknown): Promise<void> {
    await this.respond(id, { result });
  }

  async respondError(
    id: RpcId,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    await this.respond(id, {
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  close(error: RpcProtocolError = new RpcProtocolError('RPC transport closed')): void {
    this.terminate(error, false);
  }

  fail(error: RpcProtocolError, shouldThrow = true): never | void {
    this.terminate(error, true);
    if (shouldThrow) throw this.fatalError;
  }

  private terminate(error: RpcProtocolError, notifyFatal: boolean): void {
    if (!this.fatalError) {
      this.fatalError = error;
      for (const pending of this.pending.values()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      if (notifyFatal) this.options.onFatal?.(error);
    }
  }

  private async respond(id: RpcId, payload: Record<string, unknown>): Promise<void> {
    this.assertOpen();
    if (!validId(id)) throw new RpcProtocolError('ServerRequest response id 非法');
    const key = idKey(id);
    if (this.respondedServerIds.has(key)) {
      throw new RpcProtocolError('ServerRequest 已响应');
    }
    this.respondedServerIds.add(key);
    try {
      await this.enqueueWrite(line({ jsonrpc: '2.0', id, ...payload }));
    } catch (error) {
      this.fail(
        new RpcProtocolError(
          `ServerRequest response write 失败: ${error instanceof Error ? error.message : 'unknown'}`,
        ),
        false,
      );
      throw this.fatalError;
    }
  }

  private enqueueWrite(frame: string): Promise<void> {
    const write = this.writeTail.then(() => {
      this.assertOpen();
      return this.sink.write(frame);
    });
    this.writeTail = write.catch(() => undefined);
    return write;
  }

  private assertOpen(): void {
    if (this.fatalError) throw this.fatalError;
  }

  private throwFatal(message: string): never {
    return this.fail(new RpcProtocolError(message)) as never;
  }
}
