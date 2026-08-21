import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteAppServerAuth } from './remote-auth.js';
import {
  AuthenticatedWebSocketProcessHost,
  spawnSupervisedWebSocketAppServer,
  type AppServerWebSocket,
  type SpawnedWebSocketAppServer,
} from './websocket-process-host.js';

class FakeChild extends EventEmitter implements SpawnedWebSocketAppServer {
  constructor(readonly pid?: number) {
    super();
  }
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

class FakeSocket extends EventEmitter implements AppServerWebSocket {
  readonly sent: string[] = [];
  closed = false;
  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    callback();
  }
  close(): void {
    this.closed = true;
    this.emit('close', 1000, Buffer.alloc(0));
  }
}

function fakeAuth(
  dispose = vi.fn(async () => undefined),
  revoke = vi.fn(async () => undefined),
): RemoteAppServerAuth {
  return {
    endpoint: 'ws://127.0.0.1:0',
    appServerIncarnationId: '0123456789abcdef0123456789abcdef',
    token: 'secret-capability-token',
    tokenEnvName: 'AGENT_NEXUS_CODEX_REMOTE_TOKEN',
    tokenFile: '/runtime/private/capability-token',
    runtimeDir: '/runtime/private',
    serverArgs: [
      'app-server', '--listen', 'ws://127.0.0.1:0', '--ws-auth',
      'capability-token', '--ws-token-file', '/runtime/private/capability-token',
    ],
    revoke,
    dispose,
  };
}

describe('AuthenticatedWebSocketProcessHost', () => {
  it.skipIf(process.platform === 'win32')(
    'kills_the_supervised_app_server_group_when_the_daemon_control_pipe_closes',
    async () => {
      const child = spawnSupervisedWebSocketAppServer(
        '/bin/sh',
        ['-c', 'sleep 1000 & wait'],
        {
          cwd: process.cwd(),
          env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        },
      );
      const pid = child.pid;
      expect(pid).toBeTypeOf('number');
      await vi.waitFor(() => expect(processGroupExists(pid!)).toBe(true));
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });

      child.stdin.end();

      await exited;
      await vi.waitFor(() => expect(processGroupExists(pid!)).toBe(false));
    },
    5_000,
  );

  it.skipIf(process.platform === 'win32')(
    'kills_remaining_group_members_when_the_supervised_root_exits_first',
    async () => {
      const child = spawnSupervisedWebSocketAppServer(
        '/bin/sh',
        ['-c', 'sleep 1000 &'],
        {
          cwd: process.cwd(),
          env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        },
      );
      const pid = child.pid;
      expect(pid).toBeTypeOf('number');
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });

      await exited;
      await vi.waitFor(() => expect(processGroupExists(pid!)).toBe(false));
    },
    5_000,
  );

  it('waits for the allocated loopback endpoint and authenticates without argv token leakage', async () => {
    const child = new FakeChild();
    const socket = new FakeSocket();
    const spawn = vi.fn(() => child);
    const connect = vi.fn(async () => socket);
    const host = new AuthenticatedWebSocketProcessHost(baseOptions(), {
      createAuth: async () => fakeAuth(),
      spawn,
      connect,
      signalProcessGroup: vi.fn(),
    });

    const started = host.start();
    child.stderr.write('codex app-server (WebSockets)\n  listening on: ws://127.0.0.1:54321\n');
    await started;

    expect(spawn).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      expect.arrayContaining(['--listen', 'ws://127.0.0.1:0', '--ws-token-file']),
      expect.objectContaining({ cwd: '/workspace', shell: false }),
    );
    expect(JSON.stringify(spawn.mock.calls)).not.toContain('secret-capability-token');
    expect(connect).toHaveBeenCalledWith('ws://127.0.0.1:54321', 'secret-capability-token');

    const response = host.request('thread/read', { threadId: 'thr_1' });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent[0]).not.toContain('\n');
    socket.emit('message', '{"id":1,"result":{"ok":true}}');
    await expect(response).resolves.toEqual({ ok: true });
  });

  it('exposes_only_a_secret_free_viewer_admission_for_the_live_incarnation', async () => {
    const child = new FakeChild(8100);
    const socket = new FakeSocket();
    const signalProcessGroup = vi.fn((target: FakeChild) => target.emit('exit', 0, null));
    const host = new AuthenticatedWebSocketProcessHost(baseOptions(), {
      createAuth: async () => fakeAuth(),
      spawn: () => child,
      connect: async () => socket,
      signalProcessGroup,
    });
    const started = host.start();
    child.stderr.write('listening on: ws://127.0.0.1:54333\n');
    await started;

    const admission = host.viewerAdmission();

    expect(admission).toEqual({
      endpoint: 'ws://127.0.0.1:54333',
      appServerIncarnationId: '0123456789abcdef0123456789abcdef',
      tokenEnvName: 'AGENT_NEXUS_CODEX_REMOTE_TOKEN',
      tokenFile: '/runtime/private/capability-token',
      runtimeDir: '/runtime/private',
    });
    expect(JSON.stringify(admission)).not.toContain('secret-capability-token');
    await host.stop();
    expect(() => host.viewerAdmission()).toThrow(/not available|unavailable|不可用/);
  });

  it('fails closed on non-loopback readiness output and disposes the token', async () => {
    const child = new FakeChild();
    const dispose = vi.fn(async () => undefined);
    const signal = vi.fn();
    const host = new AuthenticatedWebSocketProcessHost(baseOptions(), {
      createAuth: async () => fakeAuth(dispose),
      spawn: () => child,
      connect: vi.fn(),
      signalProcessGroup: signal,
    });

    const started = host.start();
    child.stderr.write('listening on: ws://0.0.0.0:54321\n');
    await expect(started).rejects.toThrow(/loopback/);
    expect(signal).toHaveBeenCalledWith(child, 'SIGTERM');
    child.emit('exit', null, 'SIGTERM');
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });

  it('routes notifications and ServerRequests and writes exactly one response message', async () => {
    const child = new FakeChild();
    const socket = new FakeSocket();
    const notifications: Record<string, unknown>[] = [];
    const serverRequests: Record<string, unknown>[] = [];
    const host = new AuthenticatedWebSocketProcessHost(
      baseOptions(),
      {
        createAuth: async () => fakeAuth(),
        spawn: () => child,
        connect: async () => socket,
        signalProcessGroup: vi.fn(),
      },
      {
        onNotification: (frame) => notifications.push(frame),
        onServerRequest: (frame) => serverRequests.push(frame),
      },
    );
    const started = host.start();
    child.stderr.write('listening on: ws://127.0.0.1:54323\n');
    await started;

    socket.emit('message', '{"method":"thread/status/changed","params":{"threadId":"thr_1"}}');
    socket.emit('message', '{"id":"server-1","method":"attestation/generate","params":{}}');
    await host.respondError('server-1', -32601, 'unsupported');

    expect(notifications).toHaveLength(1);
    expect(serverRequests).toHaveLength(1);
    expect(socket.sent).toEqual([
      '{"jsonrpc":"2.0","id":"server-1","error":{"code":-32601,"message":"unsupported"}}',
    ]);
  });

  it('rejects pending RPC and terminates the incarnation when the socket closes unexpectedly', async () => {
    const child = new FakeChild();
    const socket = new FakeSocket();
    const dispose = vi.fn(async () => undefined);
    const signal = vi.fn();
    const host = new AuthenticatedWebSocketProcessHost(baseOptions(), {
      createAuth: async () => fakeAuth(dispose),
      spawn: () => child,
      connect: async () => socket,
      signalProcessGroup: signal,
    });
    const started = host.start();
    child.stderr.write('listening on: ws://127.0.0.1:54324\n');
    await started;
    const pending = host.request('thread/read', { threadId: 'thr_1' });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    socket.close();

    await expect(pending).rejects.toThrow(/closed unexpectedly/);
    expect(signal).toHaveBeenCalledWith(child, 'SIGTERM');
    child.emit('exit', null, 'SIGTERM');
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });

  it('waits_for_viewer_cleanup_before_terminating_on_a_foreign_turn_notification', async () => {
    const child = new FakeChild(8133);
    const socket = new FakeSocket();
    let releaseViewer!: () => void;
    const viewerStopped = new Promise<void>((resolve) => { releaseViewer = resolve; });
    const signalProcessGroup = vi.fn((target: FakeChild) => target.emit('exit', 0, null));
    const host = new AuthenticatedWebSocketProcessHost(
      baseOptions(),
      {
        createAuth: async () => fakeAuth(),
        spawn: () => child,
        connect: async () => socket,
        beforeAuthDispose: () => viewerStopped,
        signalProcessGroup,
        isProcessGroupAlive: () => false,
      },
      {
        onNotification: () => { throw new Error('foreign turn/started'); },
      },
    );
    const started = host.start();
    child.stderr.write('listening on: ws://127.0.0.1:54337\n');
    await started;

    socket.emit('message', JSON.stringify({
      method: 'turn/started',
      params: { threadId: 'foreign', turn: { id: 'foreign-turn' } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signalProcessGroup).not.toHaveBeenCalled();

    releaseViewer();
    await vi.waitFor(() => expect(signalProcessGroup).toHaveBeenCalledWith(child, 'SIGTERM'));
    await expect(host.stop()).resolves.toBeUndefined();
  });

  it('stops_the_viewer_before_revoking_auth_after_an_unexpected_exit', async () => {
    const child = new FakeChild(8130);
    const socket = new FakeSocket();
    const order: string[] = [];
    const beforeAuthDispose = vi.fn(async () => { order.push('viewer'); });
    const dispose = vi.fn(async () => { order.push('auth'); });
    const host = new AuthenticatedWebSocketProcessHost(baseOptions(), {
      createAuth: async () => fakeAuth(dispose),
      spawn: () => child,
      connect: async () => socket,
      beforeAuthDispose,
      signalProcessGroup: vi.fn(),
      isProcessGroupAlive: () => false,
    });
    const started = host.start();
    child.stderr.write('listening on: ws://127.0.0.1:54334\n');
    await started;

    child.emit('exit', 1, null);

    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(beforeAuthDispose).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['viewer', 'auth']);
  });

  it('continues_auth_revocation_but_rejects_cleanup_when_viewer_stop_fails', async () => {
    const child = new FakeChild(8131);
    const socket = new FakeSocket();
    const viewerError = new Error('viewer stop failed');
    const dispose = vi.fn(async () => undefined);
    const revoke = vi.fn(async () => undefined);
    const host = new AuthenticatedWebSocketProcessHost(baseOptions(), {
      createAuth: async () => fakeAuth(dispose, revoke),
      spawn: () => child,
      connect: async () => socket,
      beforeAuthDispose: async () => { throw viewerError; },
      signalProcessGroup: vi.fn(),
      isProcessGroupAlive: () => false,
    });
    const started = host.start();
    child.stderr.write('listening on: ws://127.0.0.1:54335\n');
    await started;

    child.emit('exit', 1, null);
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));

    await expect(host.stop()).rejects.toBe(viewerError);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('aggregates_viewer_and_auth_cleanup_failures_without_skipping_either', async () => {
    const child = new FakeChild(8132);
    const socket = new FakeSocket();
    const viewerError = new Error('viewer cleanup failed');
    const authError = new Error('auth revocation failed');
    const dispose = vi.fn(async () => undefined);
    const revoke = vi.fn(async () => { throw authError; });
    const host = new AuthenticatedWebSocketProcessHost(baseOptions(), {
      createAuth: async () => fakeAuth(dispose, revoke),
      spawn: () => child,
      connect: async () => socket,
      beforeAuthDispose: async () => { throw viewerError; },
      signalProcessGroup: vi.fn((target: FakeChild) => target.emit('exit', 0, null)),
      isProcessGroupAlive: () => false,
    });
    const started = host.start();
    child.stderr.write('listening on: ws://127.0.0.1:54336\n');
    await started;

    const failure = await host.stop().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([viewerError, authError]);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('closes the websocket, process group, and token incarnation on stop', async () => {
    const child = new FakeChild();
    const socket = new FakeSocket();
    const dispose = vi.fn(async () => undefined);
    const signal = vi.fn((target: FakeChild) => target.emit('exit', 0, null));
    const host = new AuthenticatedWebSocketProcessHost(baseOptions(), {
      createAuth: async () => fakeAuth(dispose),
      spawn: () => child,
      connect: async () => socket,
      signalProcessGroup: signal,
    });
    const started = host.start();
    child.stderr.write('listening on: ws://127.0.0.1:54322\n');
    await started;
    const pending = host.request('thread/read', { threadId: 'thr_pending' });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const rejected = expect(pending).rejects.toThrow(/stopped/);

    await host.stop();

    await rejected;
    expect(socket.closed).toBe(true);
    expect(signal).toHaveBeenCalledWith(child, 'SIGTERM');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('fails startup safely when the child emits a spawn error without an exit event', async () => {
    const child = new FakeChild(undefined);
    const dispose = vi.fn(async () => undefined);
    const spawn = vi.fn(() => child);
    const host = new AuthenticatedWebSocketProcessHost(baseOptions(), {
      createAuth: async () => fakeAuth(dispose),
      spawn,
      connect: vi.fn(),
      signalProcessGroup: vi.fn(),
    });

    const started = host.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(() => {
      child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
      child.emit('error', Object.assign(new Error('spawn failed again'), { code: 'ENOENT' }));
    }).not.toThrow();

    await expect(started).rejects.toThrow(/process error/);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });

  it('propagates an auth creation rollback failure through the stop barrier', async () => {
    const creationError = new Error('token creation failed');
    const cleanupError = new Error('token rollback failed');
    const rollbackError = new AggregateError([creationError, cleanupError]);
    const spawn = vi.fn(() => new FakeChild());
    const host = new AuthenticatedWebSocketProcessHost(baseOptions(), {
      createAuth: async () => {
        throw rollbackError;
      },
      spawn,
      connect: vi.fn(),
      signalProcessGroup: vi.fn(),
    });

    await expect(host.start()).rejects.toBeInstanceOf(Error);
    await expect(host.stop()).rejects.toBe(rollbackError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('contains process-group signal errors instead of throwing from the grace timer', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(8123);
      const socket = new FakeSocket();
      const fatal = vi.fn();
      const signal = vi.fn((_target: FakeChild, signalName: NodeJS.Signals) => {
        if (signalName === 'SIGKILL') {
          throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        }
      });
      const host = new AuthenticatedWebSocketProcessHost(
        { ...baseOptions(), terminateGraceMs: 25 },
        {
          createAuth: async () => fakeAuth(),
          spawn: () => child,
          connect: async () => socket,
          signalProcessGroup: signal,
        },
        { onFatal: fatal },
      );
      const started = host.start();
      child.stderr.write('listening on: ws://127.0.0.1:54325\n');
      await started;

      const stopped = host.stop();
      await vi.advanceTimersByTimeAsync(25);

      expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/signal/) }));
      child.emit('exit', null, 'SIGKILL');
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects unconfirmed process cleanup after revoking the token incarnation', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(8124);
      const socket = new FakeSocket();
      const dispose = vi.fn(async () => undefined);
      const host = new AuthenticatedWebSocketProcessHost(
        { ...baseOptions(), terminateGraceMs: 50 },
        {
          createAuth: async () => fakeAuth(dispose),
          spawn: () => child,
          connect: async () => socket,
          signalProcessGroup: vi.fn(),
        },
      );
      const started = host.start();
      child.stderr.write('listening on: ws://127.0.0.1:54328\n');
      await started;
      let settlement: 'pending' | 'resolved' | 'rejected' = 'pending';

      void host.stop().then(
        () => { settlement = 'resolved'; },
        () => { settlement = 'rejected'; },
      );
      await vi.advanceTimersByTimeAsync(100);

      expect(settlement).toBe('rejected');
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the cleanup deadline timer referenced', async () => {
    const child = new FakeChild(8128);
    const socket = new FakeSocket();
    const host = new AuthenticatedWebSocketProcessHost(
      { ...baseOptions(), terminateGraceMs: 10_000 },
      {
        createAuth: async () => fakeAuth(),
        spawn: () => child,
        connect: async () => socket,
        signalProcessGroup: vi.fn(),
        isProcessGroupAlive: () => false,
      },
    );
    const started = host.start();
    child.stderr.write('listening on: ws://127.0.0.1:54332\n');
    await started;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      try {
        const stopped = host.stop();
        await vi.waitFor(() => expect(setTimeoutSpy).toHaveBeenCalled());
        const deadline = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout;

      expect(deadline.hasRef()).toBe(true);
      child.emit('exit', 0, null);
      await expect(stopped).resolves.toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('should_kill_remaining_process_group_members_after_the_root_exits', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(8125);
      const socket = new FakeSocket();
      let groupAlive = true;
      const signalProcessGroup = vi.fn(
        (target: FakeChild, signal: NodeJS.Signals) => {
          if (signal === 'SIGTERM') target.emit('exit', 0, null);
          if (signal === 'SIGKILL') groupAlive = false;
        },
      );
      const host = new AuthenticatedWebSocketProcessHost(
        { ...baseOptions(), terminateGraceMs: 50 },
        {
          createAuth: async () => fakeAuth(),
          spawn: () => child,
          connect: async () => socket,
          signalProcessGroup,
          isProcessGroupAlive: () => groupAlive,
        },
      );
      const started = host.start();
      child.stderr.write('listening on: ws://127.0.0.1:54329\n');
      await started;

      const stopped = host.stop();
      await vi.advanceTimersByTimeAsync(50);

      expect(signalProcessGroup).toHaveBeenCalledWith(child, 'SIGKILL');
      await expect(stopped).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should_cleanup_remaining_process_group_members_after_an_unexpected_root_exit', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(8126);
      const socket = new FakeSocket();
      let groupAlive = true;
      const signalProcessGroup = vi.fn(
        (_target: FakeChild, signal: NodeJS.Signals) => {
          if (signal === 'SIGKILL') groupAlive = false;
        },
      );
      const host = new AuthenticatedWebSocketProcessHost(
        { ...baseOptions(), terminateGraceMs: 50 },
        {
          createAuth: async () => fakeAuth(),
          spawn: () => child,
          connect: async () => socket,
          signalProcessGroup,
          isProcessGroupAlive: () => groupAlive,
        },
      );
      const started = host.start();
      child.stderr.write('listening on: ws://127.0.0.1:54330\n');
      await started;

      child.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(100);

      expect(signalProcessGroup).toHaveBeenCalledWith(child, 'SIGKILL');
      await expect(host.stop()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should_not_treat_an_unknown_process_group_probe_error_as_exit', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill');
    try {
      const child = new FakeChild(8127);
      const socket = new FakeSocket();
      let groupKilled = false;
      kill.mockImplementation(((_pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0) {
          throw Object.assign(new Error('probe denied'), {
            code: groupKilled ? 'ESRCH' : 'EACCES',
          });
        }
        return true;
      }) as typeof process.kill);
      const signalProcessGroup = vi.fn(
        (target: FakeChild, signal: NodeJS.Signals) => {
          if (signal === 'SIGTERM') target.emit('exit', 0, null);
          if (signal === 'SIGKILL') groupKilled = true;
        },
      );
      const host = new AuthenticatedWebSocketProcessHost(
        { ...baseOptions(), terminateGraceMs: 50 },
        {
          createAuth: async () => fakeAuth(),
          spawn: () => child,
          connect: async () => socket,
          signalProcessGroup,
        },
      );
      const started = host.start();
      child.stderr.write('listening on: ws://127.0.0.1:54331\n');
      await started;

      const stopped = host.stop();
      await vi.advanceTimersByTimeAsync(50);

      expect(signalProcessGroup).toHaveBeenCalledWith(child, 'SIGKILL');
      await expect(stopped).resolves.toBeUndefined();
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not expose stderr or malformed-frame contents through diagnostics and fatal errors', async () => {
    const child = new FakeChild();
    const socket = new FakeSocket();
    const fatal = vi.fn();
    const host = new AuthenticatedWebSocketProcessHost(
      baseOptions(),
      {
        createAuth: async () => fakeAuth(),
        spawn: () => child,
        connect: async () => socket,
        signalProcessGroup: vi.fn(),
      },
      { onFatal: fatal },
    );
    const started = host.start();
    child.stderr.write('listening on: ws://127.0.0.1:54326\n');
    await started;
    child.stderr.write('sensitive-stderr secret-capability-token\n');

    socket.emit('message', '{"id":sensitive-frame-fragment');

    expect(host.stderrDiagnostic()).not.toMatch(/sensitive-stderr|secret-capability-token/);
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.not.stringMatching(/sensitive-frame-fragment/) }),
    );
    child.emit('exit', null, 'SIGTERM');
  });

  it('does not spawn after stop wins the auth creation race and still disposes the token', async () => {
    let releaseAuth!: (auth: RemoteAppServerAuth) => void;
    const authReady = new Promise<RemoteAppServerAuth>((resolve) => {
      releaseAuth = resolve;
    });
    const dispose = vi.fn(async () => undefined);
    const spawn = vi.fn(() => new FakeChild());
    const host = new AuthenticatedWebSocketProcessHost(baseOptions(), {
      createAuth: () => authReady,
      spawn,
      connect: vi.fn(),
      signalProcessGroup: vi.fn(),
    });

    const started = host.start();
    const stopped = host.stop();
    releaseAuth(fakeAuth(dispose));

    await stopped;
    await expect(started).rejects.toThrow(/stopped/);
    expect(spawn).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('retries token cleanup after a transient disposal failure', async () => {
    const child = new FakeChild();
    const socket = new FakeSocket();
    const dispose = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      .mockResolvedValueOnce(undefined);
    const signal = vi.fn((target: FakeChild) => target.emit('exit', 0, null));
    const host = new AuthenticatedWebSocketProcessHost(baseOptions(), {
      createAuth: async () => fakeAuth(dispose),
      spawn: () => child,
      connect: async () => socket,
      signalProcessGroup: signal,
    });
    const started = host.start();
    child.stderr.write('listening on: ws://127.0.0.1:54327\n');
    await started;

    await expect(host.stop()).rejects.toMatchObject({ code: 'EBUSY' });
    await expect(host.stop()).resolves.toBeUndefined();

    expect(dispose).toHaveBeenCalledTimes(2);
  });
});

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function baseOptions() {
  return {
    bin: '/usr/local/bin/codex',
    cwd: '/workspace',
    codexHome: '/runtime/home',
    env: { PATH: '/usr/bin' },
    requestTimeoutMs: 1_000,
    terminateGraceMs: 100,
    startupTimeoutMs: 1_000,
  };
}
