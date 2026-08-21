import { randomBytes } from 'node:crypto';
import type { CodexAppServerSandbox } from './config.js';
import type { AppServerRpcPort } from './controller.js';
import { RpcRemoteError } from './rpc-transport.js';

export type CodexProcessState =
  | 'starting'
  | 'running'
  | 'terminating'
  | 'exited'
  | 'failed'
  | 'lost';

export interface CodexProcessStatus {
  handle: string;
  state: CodexProcessState;
  nextCursor: number;
  oldestCursor: number;
  stdinOpen: boolean;
  exitCode?: number;
  failureCode?: string;
}

export interface CodexProcessOutputChunk {
  stream: 'stdout' | 'stderr';
  startCursor: number;
  endCursor: number;
  dataBase64: string;
}

export interface CodexProcessOutputPage {
  status: CodexProcessStatus;
  requestedCursor: number;
  oldestCursor: number;
  nextCursor: number;
  truncatedBefore: boolean;
  chunks: CodexProcessOutputChunk[];
}

export interface CodexProcessLimits {
  maxActiveProcesses: number;
  maxTerminalRecords: number;
  maxOutputBytes: number;
  maxOutputChunks: number;
  maxReadBytes: number;
  maxIngressBytes: number;
  maxStdinWriteBytes: number;
  maxPendingStdinBytes: number;
  maxPendingStdinWrites: number;
}

export interface CodexProcessControllerOptions {
  workingDir: string;
  sandbox: CodexAppServerSandbox;
  addDirs: string[];
  terminateGraceMs: number;
  idFactory?: () => string;
  onFatal?: (error: CodexProcessError) => void;
  limits?: CodexProcessLimits;
}

export interface CodexProcessWriteResult {
  acceptedBytes: number;
  stdinOpen: boolean;
}

export interface CodexProcessTerminateResult {
  alreadyTerminal: boolean;
  status: CodexProcessStatus;
}

interface OutputChunk {
  stream: 'stdout' | 'stderr';
  startCursor: number;
  endCursor: number;
  bytes: Buffer;
}

interface ProcessRecord {
  handle: string;
  processId: string;
  state: CodexProcessState;
  stdinOpen: boolean;
  exitCode?: number;
  failureCode?: string;
  nextCursor: number;
  oldestCursor: number;
  ingressBytes: number;
  chunks: OutputChunk[];
  chunkHead: number;
  outputBytes: number;
  pendingStdinBytes: number;
  pendingStdinWrites: number;
  cappedStreams: Set<'stdout' | 'stderr'>;
  writeTail: Promise<void>;
  terminalPromise: Promise<CodexProcessStatus>;
  resolveTerminal: (status: CodexProcessStatus) => void;
  terminalResolved: boolean;
  terminationPromise: Promise<CodexProcessTerminateResult> | null;
  terminalOrder: number | null;
}

const DEFAULT_LIMITS: CodexProcessLimits = {
  maxActiveProcesses: 4,
  maxTerminalRecords: 16,
  maxOutputBytes: 1024 * 1024,
  maxOutputChunks: 4096,
  maxReadBytes: 64 * 1024,
  maxIngressBytes: 64 * 1024 * 1024,
  maxStdinWriteBytes: 64 * 1024,
  maxPendingStdinBytes: 256 * 1024,
  maxPendingStdinWrites: 64,
};

const TERMINAL_STATES = new Set<CodexProcessState>(['exited', 'failed', 'lost']);

export class CodexProcessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CodexProcessError';
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validateEmptyResponse(value: unknown, method: string): void {
  const response = object(value);
  if (!response || Object.keys(response).length !== 0) {
    throw new CodexProcessError('process_protocol_error', `${method} response 非法`);
  }
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new CodexProcessError('process_invalid_base64', 'process dataBase64 非法');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new CodexProcessError('process_invalid_base64', 'process dataBase64 非法');
  }
  return bytes;
}

function isTerminal(state: CodexProcessState): boolean {
  return TERMINAL_STATES.has(state);
}

function validateLimits(limits: CodexProcessLimits): CodexProcessLimits {
  const names = Object.keys(DEFAULT_LIMITS) as Array<keyof CodexProcessLimits>;
  for (const name of names) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new CodexProcessError('process_invalid_limits', `${name} 必须是正整数`);
    }
  }
  return { ...limits };
}

export class CodexProcessController {
  private readonly records = new Map<string, ProcessRecord>();
  private readonly byProcessId = new Map<string, ProcessRecord>();
  private readonly limits: CodexProcessLimits;
  private readonly idFactory: () => string;
  private accepting = true;
  private stopping = false;
  private fatalError: CodexProcessError | null = null;
  private terminalSequence = 0;

  constructor(
    private readonly port: AppServerRpcPort,
    private readonly options: CodexProcessControllerOptions,
  ) {
    this.limits = validateLimits(options.limits ?? DEFAULT_LIMITS);
    this.idFactory = options.idFactory ?? (() => randomBytes(24).toString('hex'));
  }

  async start(input: { argv: string[] }): Promise<CodexProcessStatus> {
    this.assertUsable();
    if (!this.accepting) {
      throw new CodexProcessError('process_owner_stopping', 'process owner 正在停止');
    }
    this.validateArgv(input.argv);
    const active = [...this.records.values()].filter((record) => !isTerminal(record.state));
    if (active.length >= this.limits.maxActiveProcesses) {
      throw new CodexProcessError('process_limit_reached', 'process active limit reached');
    }

    const handle = this.nextUniqueId((candidate) => this.records.has(candidate));
    const processId = this.nextUniqueId((candidate) =>
      candidate === handle || this.byProcessId.has(candidate));
    let resolveTerminal!: (status: CodexProcessStatus) => void;
    const terminalPromise = new Promise<CodexProcessStatus>((resolve) => {
      resolveTerminal = resolve;
    });
    const record: ProcessRecord = {
      handle,
      processId,
      state: 'starting',
      stdinOpen: true,
      nextCursor: 0,
      oldestCursor: 0,
      ingressBytes: 0,
      chunks: [],
      chunkHead: 0,
      outputBytes: 0,
      pendingStdinBytes: 0,
      pendingStdinWrites: 0,
      cappedStreams: new Set(),
      writeTail: Promise.resolve(),
      terminalPromise,
      resolveTerminal,
      terminalResolved: false,
      terminationPromise: null,
      terminalOrder: null,
    };
    this.records.set(handle, record);
    this.byProcessId.set(processId, record);

    const exec = this.port.request(
      'command/exec',
      {
        command: [...input.argv],
        processId,
        cwd: this.options.workingDir,
        streamStdin: true,
        streamStdoutStderr: true,
        disableTimeout: true,
        disableOutputCap: true,
        // The app-server needs its private CODEX_HOME; spawned tools must not inherit auth.
        env: { CODEX_HOME: null },
        sandboxPolicy: this.sandboxPolicy(),
      },
      {
        timeoutMs: null,
        onResponse: (response) => {
          if (response.kind === 'result') this.finishExited(record, response.result);
          else this.finishFailed(record, 'process_exec_failed');
        },
      },
    );
    void exec.then(
      (response) => {
        try {
          this.finishExited(record, response);
        } catch (error) {
          if (error !== this.fatalError) {
            this.recordFatal('process_internal_error', 'process final handling failed');
          }
        }
      },
      (error) => {
        if (error instanceof RpcRemoteError) {
          this.finishFailed(record, 'process_exec_failed', 'failed');
        } else {
          this.finishFailed(record, 'process_connection_lost', 'lost');
        }
      },
    );

    const admission = this.port.request('command/exec/write', {
      processId,
      deltaBase64: '',
    });
    const winner = await Promise.race([
      admission.then(
        (response) => ({ kind: 'admitted' as const, response }),
        (error) => ({ kind: 'admission_failed' as const, error }),
      ),
      record.terminalPromise.then((status) => ({ kind: 'terminal' as const, status })),
    ]);

    if (winner.kind === 'terminal') {
      void admission.catch(() => undefined);
      if (winner.status.state === 'failed' || winner.status.state === 'lost') {
        throw new CodexProcessError(
          winner.status.failureCode ?? 'process_start_failed',
          'process start failed',
        );
      }
      return winner.status;
    }
    if (winner.kind === 'admission_failed') {
      if (isTerminal(record.state)) {
        const status = this.statusSnapshot(record);
        if (status.state === 'failed' || status.state === 'lost') {
          throw new CodexProcessError(
            status.failureCode ?? 'process_start_failed',
            'process start failed',
          );
        }
        return status;
      }
      this.finishFailed(record, 'process_start_admission_failed');
      this.failFatal('process_start_ambiguous', 'process start admission 未确认');
    }
    try {
      validateEmptyResponse(winner.response, 'command/exec/write');
    } catch {
      this.finishFailed(record, 'process_start_admission_invalid');
      this.failFatal('process_protocol_error', 'process start admission response 非法');
    }
    if (record.state === 'starting') record.state = 'running';
    return this.statusSnapshot(record);
  }

  status(handle: string): CodexProcessStatus {
    this.assertUsable();
    return this.statusSnapshot(this.requireRecord(handle));
  }

  readOutput(input: { handle: string; cursor: number }): CodexProcessOutputPage {
    this.assertUsable();
    const record = this.requireRecord(input.handle);
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 || input.cursor > record.nextCursor) {
      throw new CodexProcessError('process_invalid_cursor', 'process output cursor 非法');
    }
    const requestedCursor = input.cursor;
    let cursor = Math.max(requestedCursor, record.oldestCursor);
    let remaining = this.limits.maxReadBytes;
    const chunks: CodexProcessOutputChunk[] = [];
    for (let index = record.chunkHead; index < record.chunks.length; index += 1) {
      if (remaining === 0) break;
      const chunk = record.chunks[index]!;
      if (chunk.endCursor <= cursor) continue;
      const startCursor = Math.max(cursor, chunk.startCursor);
      const offset = startCursor - chunk.startCursor;
      const take = Math.min(chunk.bytes.length - offset, remaining);
      if (take <= 0) continue;
      const endCursor = startCursor + take;
      chunks.push({
        stream: chunk.stream,
        startCursor,
        endCursor,
        dataBase64: chunk.bytes.subarray(offset, offset + take).toString('base64'),
      });
      cursor = endCursor;
      remaining -= take;
    }
    return {
      status: this.statusSnapshot(record),
      requestedCursor,
      oldestCursor: record.oldestCursor,
      nextCursor: cursor,
      truncatedBefore: requestedCursor < record.oldestCursor,
      chunks,
    };
  }

  writeStdin(input: {
    handle: string;
    dataBase64?: string;
    closeStdin?: boolean;
  }): Promise<CodexProcessWriteResult> {
    this.assertUsable();
    const record = this.requireRecord(input.handle);
    const hasData = input.dataBase64 !== undefined;
    const closeStdin = input.closeStdin === true;
    if (!hasData && !closeStdin) {
      return Promise.reject(
        new CodexProcessError('process_invalid_stdin', 'stdin data 或 closeStdin 必须存在'),
      );
    }
    if (
      hasData &&
      typeof input.dataBase64 === 'string' &&
      input.dataBase64.length > Math.ceil(this.limits.maxStdinWriteBytes / 3) * 4
    ) {
      return Promise.reject(
        new CodexProcessError('process_stdin_too_large', 'stdin write 超过单次上限'),
      );
    }
    const bytes = hasData ? decodeCanonicalBase64(input.dataBase64) : Buffer.alloc(0);
    if (bytes.length === 0 && !closeStdin) {
      return Promise.reject(
        new CodexProcessError('process_invalid_stdin', 'empty stdin write 没有作用'),
      );
    }
    if (bytes.length > this.limits.maxStdinWriteBytes) {
      return Promise.reject(
        new CodexProcessError('process_stdin_too_large', 'stdin write 超过单次上限'),
      );
    }
    if (record.state !== 'running') {
      return Promise.reject(
        new CodexProcessError('process_not_running', 'process 不接受 stdin'),
      );
    }
    if (!record.stdinOpen) {
      if (closeStdin && bytes.length === 0) {
        return Promise.resolve({ acceptedBytes: 0, stdinOpen: false });
      }
      return Promise.reject(
        new CodexProcessError('process_stdin_closed', 'process stdin 已关闭'),
      );
    }
    if (
      record.pendingStdinBytes + bytes.length > this.limits.maxPendingStdinBytes ||
      record.pendingStdinWrites + 1 > this.limits.maxPendingStdinWrites
    ) {
      return Promise.reject(
        new CodexProcessError('process_stdin_backpressure', 'process stdin pending quota exceeded'),
      );
    }
    record.pendingStdinBytes += bytes.length;
    record.pendingStdinWrites += 1;
    if (closeStdin) record.stdinOpen = false;

    const operation = record.writeTail.then(async () => {
      this.assertUsable();
      if (record.state !== 'running') {
        throw new CodexProcessError('process_not_running', 'process 不接受 stdin');
      }
      let response: unknown;
      try {
        response = await this.port.request('command/exec/write', {
          processId: record.processId,
          ...(hasData ? { deltaBase64: input.dataBase64 } : {}),
          ...(closeStdin ? { closeStdin: true } : {}),
        });
      } catch {
        if (isTerminal(record.state)) {
          throw new CodexProcessError('process_not_running', 'process 不接受 stdin');
        }
        throw this.recordFatal(
          'process_stdin_ambiguous',
          'process stdin control 未确认',
        );
      }
      try {
        validateEmptyResponse(response, 'command/exec/write');
      } catch {
        throw this.recordFatal(
          'process_protocol_error',
          'command/exec/write response 非法',
        );
      }
      return { acceptedBytes: bytes.length, stdinOpen: record.stdinOpen };
    }).finally(() => {
      record.pendingStdinBytes -= bytes.length;
      record.pendingStdinWrites -= 1;
    });
    record.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  terminate(handle: string): Promise<CodexProcessTerminateResult> {
    this.assertUsable();
    const record = this.requireRecord(handle);
    if (isTerminal(record.state)) {
      return Promise.resolve({ alreadyTerminal: true, status: this.statusSnapshot(record) });
    }
    return this.ensureTermination(record);
  }

  handleNotification(frame: Record<string, unknown>): void {
    this.assertUsable();
    if (frame['method'] !== 'command/exec/outputDelta') {
      this.failFatal('process_protocol_error', 'process notification method 非法');
    }
    const params = object(frame['params']);
    if (!params || typeof params['processId'] !== 'string') {
      this.failFatal('process_protocol_error', 'process notification params 非法');
    }
    const record = this.byProcessId.get(params['processId']);
    if (!record) {
      this.failFatal('process_notification_ownership', 'unknown process notification');
    }
    if (isTerminal(record.state)) {
      this.failFatal('process_protocol_error', 'terminal process 收到 output');
    }
    const stream = params['stream'];
    if (stream !== 'stdout' && stream !== 'stderr') {
      this.failFatal('process_protocol_error', 'process output stream 非法');
    }
    let bytes: Buffer;
    try {
      bytes = decodeCanonicalBase64(params['deltaBase64']);
    } catch {
      this.failFatal('process_protocol_error', 'process output base64 非法');
    }
    if (typeof params['capReached'] !== 'boolean') {
      this.failFatal('process_protocol_error', 'process output capReached 非法');
    }
    if (record.cappedStreams.has(stream)) {
      this.failFatal('process_protocol_error', 'capped process stream 收到额外 output');
    }
    if (params['capReached']) record.cappedStreams.add(stream);
    this.appendOutput(record, stream, bytes);
    if (params['capReached'] || record.ingressBytes >= this.limits.maxIngressBytes) {
      record.failureCode ??= params['capReached']
        ? 'process_upstream_output_truncated'
        : 'process_output_limit_reached';
      void this.terminate(record.handle).catch(() => undefined);
    }
  }

  async beginStop(): Promise<void> {
    if (this.stopping) return;
    this.accepting = false;
    this.stopping = true;
    const requests = [...this.records.values()]
      .filter((record) => !isTerminal(record.state))
      .map((record) => this.ensureTermination(record).then(() => undefined));
    if (requests.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(requests).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.terminateGraceMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  confirmHostStopped(): void {
    this.accepting = false;
    this.stopping = true;
    for (const record of this.records.values()) {
      if (!isTerminal(record.state)) {
        this.finishFailed(record, 'process_connection_lost', 'lost');
      }
    }
  }

  private async terminateInternal(record: ProcessRecord): Promise<CodexProcessTerminateResult> {
    const control = this.port.request('command/exec/terminate', {
      processId: record.processId,
    });
    const first = await Promise.race([
      control.then(
        (response) => ({ kind: 'control' as const, response }),
        () => ({ kind: 'control_failed' as const }),
      ),
      record.terminalPromise.then((status) => ({ kind: 'terminal' as const, status })),
    ]);
    if (first.kind === 'terminal') {
      void control.catch(() => undefined);
      return { alreadyTerminal: false, status: first.status };
    }
    if (first.kind === 'control_failed') {
      if (isTerminal(record.state)) {
        return { alreadyTerminal: false, status: this.statusSnapshot(record) };
      }
      this.failFatal('process_terminate_ambiguous', 'process terminate control 未确认');
    }
    try {
      validateEmptyResponse(first.response, 'command/exec/terminate');
    } catch {
      this.failFatal('process_protocol_error', 'process terminate response 非法');
    }
    const status = await this.waitForTerminal(record);
    return { alreadyTerminal: false, status };
  }

  private ensureTermination(record: ProcessRecord): Promise<CodexProcessTerminateResult> {
    if (record.terminationPromise) return record.terminationPromise;
    record.state = 'terminating';
    record.stdinOpen = false;
    record.terminationPromise = this.terminateInternal(record);
    return record.terminationPromise;
  }

  private waitForTerminal(record: ProcessRecord): Promise<CodexProcessStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      record.terminalPromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = this.recordFatal(
            'process_terminate_unconfirmed',
            'process terminate terminal 未确认',
          );
          reject(error);
        }, this.options.terminateGraceMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private finishExited(record: ProcessRecord, response: unknown): void {
    if (record.terminalResolved) return;
    const result = object(response);
    const exitCode = result?.['exitCode'];
    if (
      !result ||
      !Number.isInteger(exitCode) ||
      (exitCode as number) < -2_147_483_648 ||
      (exitCode as number) > 2_147_483_647 ||
      result['stdout'] !== '' ||
      result['stderr'] !== ''
    ) {
      this.finishFailed(record, 'process_invalid_final');
      this.failFatal('process_protocol_error', 'command/exec final response 非法');
    }
    record.state = 'exited';
    record.exitCode = exitCode as number;
    record.stdinOpen = false;
    this.finishTerminal(record);
  }

  private finishFailed(
    record: ProcessRecord,
    code: string,
    state: 'failed' | 'lost' = 'failed',
  ): void {
    if (record.terminalResolved) return;
    record.state = state;
    record.failureCode = code;
    record.stdinOpen = false;
    this.finishTerminal(record);
  }

  private finishTerminal(record: ProcessRecord): void {
    if (record.terminalResolved) return;
    record.terminalResolved = true;
    record.terminalOrder = this.terminalSequence++;
    record.resolveTerminal(this.statusSnapshot(record));
    this.trimTerminalRecords();
  }

  private appendOutput(
    record: ProcessRecord,
    stream: 'stdout' | 'stderr',
    bytes: Buffer,
  ): void {
    if (bytes.length === 0) return;
    const startCursor = record.nextCursor;
    const endCursor = startCursor + bytes.length;
    record.nextCursor = endCursor;
    record.ingressBytes += bytes.length;
    record.chunks.push({ stream, startCursor, endCursor, bytes });
    record.outputBytes += bytes.length;
    while (
      record.outputBytes > this.limits.maxOutputBytes ||
      record.chunks.length - record.chunkHead > this.limits.maxOutputChunks
    ) {
      const first = record.chunks[record.chunkHead];
      if (!first) break;
      const excess = record.outputBytes - this.limits.maxOutputBytes;
      const tooManyChunks =
        record.chunks.length - record.chunkHead > this.limits.maxOutputChunks;
      if (tooManyChunks || excess >= first.bytes.length) {
        record.chunkHead += 1;
        record.outputBytes -= first.bytes.length;
      } else {
        first.bytes = first.bytes.subarray(excess);
        first.startCursor += excess;
        record.outputBytes -= excess;
      }
    }
    const compactThreshold = Math.min(1024, this.limits.maxOutputChunks);
    if (
      record.chunkHead >= compactThreshold &&
      record.chunkHead * 2 >= record.chunks.length
    ) {
      record.chunks.splice(0, record.chunkHead);
      record.chunkHead = 0;
    }
    record.oldestCursor = record.chunks[record.chunkHead]?.startCursor ?? record.nextCursor;
  }

  private statusSnapshot(record: ProcessRecord): CodexProcessStatus {
    return {
      handle: record.handle,
      state: record.state,
      nextCursor: record.nextCursor,
      oldestCursor: record.oldestCursor,
      stdinOpen: record.stdinOpen,
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
    };
  }

  private requireRecord(handle: string): ProcessRecord {
    const record = this.records.get(handle);
    if (!record) throw new CodexProcessError('process_not_found', 'process not found');
    return record;
  }

  private sandboxPolicy(): Record<string, unknown> {
    if (this.options.sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
    if (this.options.sandbox === 'read-only') {
      return { type: 'readOnly', networkAccess: false };
    }
    return {
      type: 'workspaceWrite',
      writableRoots: [this.options.workingDir, ...this.options.addDirs],
      networkAccess: false,
    };
  }

  private validateArgv(argv: string[]): void {
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.length > 256 ||
      argv.some((argument) =>
        typeof argument !== 'string' ||
        argument.length === 0 ||
        argument.includes('\u0000') ||
        Buffer.byteLength(argument) > 64 * 1024) ||
      argv.reduce((total, argument) => total + Buffer.byteLength(argument), 0) > 256 * 1024
    ) {
      throw new CodexProcessError('process_invalid_argv', 'process argv 非法');
    }
  }

  private nextUniqueId(conflicts: (candidate: string) => boolean): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.idFactory();
      if (typeof candidate === 'string' && candidate.length >= 8 && !conflicts(candidate)) {
        return candidate;
      }
    }
    throw new CodexProcessError('process_id_generation_failed', 'process id generation failed');
  }

  private trimTerminalRecords(): void {
    const terminal = [...this.records.values()]
      .filter((record) => record.terminalOrder !== null)
      .sort((left, right) => left.terminalOrder! - right.terminalOrder!);
    while (terminal.length > this.limits.maxTerminalRecords) {
      const record = terminal.shift()!;
      this.records.delete(record.handle);
      this.byProcessId.delete(record.processId);
    }
  }

  private assertUsable(): void {
    if (this.fatalError) throw this.fatalError;
  }

  private failFatal(code: string, message: string): never {
    throw this.recordFatal(code, message);
  }

  private recordFatal(code: string, message: string): CodexProcessError {
    if (!this.fatalError) {
      this.fatalError = new CodexProcessError(code, message);
      this.accepting = false;
      try {
        this.options.onFatal?.(this.fatalError);
      } catch {
        // Owner state is already fail-closed; callback failures cannot reopen it.
      }
    }
    return this.fatalError;
  }
}
