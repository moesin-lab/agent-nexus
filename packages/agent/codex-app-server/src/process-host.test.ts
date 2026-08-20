import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  AppServerProcessHost,
  ProcessHostError,
  type SpawnedAppServer,
} from './process-host.js';

class FakeChild extends EventEmitter implements SpawnedAppServer {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

class FailedChild extends EventEmitter implements SpawnedAppServer {
  readonly pid = undefined;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('AppServerProcessHost', () => {
  it.skipIf(process.platform === 'win32')(
    'should_cleanup_the_stdio_app_server_group_after_a_daemon_sigkill',
    async () => {
      const worker = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          new URL('../testdata/stdio-hard-crash-worker.mjs', import.meta.url).pathname,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let supervisorPid = 0;
      let workerRoot = '';
      let stderr = '';
      worker.stderr.setEncoding('utf8');
      worker.stderr.on('data', (chunk: string) => { stderr += chunk; });
      try {
        ({ pid: supervisorPid, rootDir: workerRoot } = await readWorkerInfo(worker.stdout));
        expect(processGroupExists(supervisorPid), stderr).toBe(true);

        worker.kill('SIGKILL');
        await new Promise<void>((resolve) => worker.once('exit', () => resolve()));

        await vi.waitFor(
          () => expect(processGroupExists(supervisorPid), stderr).toBe(false),
          { timeout: 3_000 },
        );
      } finally {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
        if (supervisorPid > 0 && processGroupExists(supervisorPid)) {
          try { process.kill(-supervisorPid, 'SIGKILL'); } catch {}
        }
        if (workerRoot) rmSync(workerRoot, { force: true, recursive: true });
      }
    },
    8_000,
  );

  it('should_spawn_anonymous_stdio_app_server_and_exchange_jsonl', async () => {
    const child = new FakeChild();
    const written: string[] = [];
    child.stdin.on('data', (chunk) => written.push(chunk.toString()));
    const spawn = vi.fn(() => child);
    const host = new AppServerProcessHost(
      {
        bin: '/usr/local/bin/codex',
        cwd: '/workspace',
        codexHome: '/runtime/home',
        env: { PATH: '/usr/bin' },
        requestTimeoutMs: 1000,
        terminateGraceMs: 100,
      },
      { spawn, signalProcessGroup: vi.fn() },
    );

    host.start();
    expect(host.pid()).toBe(4242);
    const response = host.request('thread/read', { threadId: 'thr_1' });
    await vi.waitFor(() => expect(written).toHaveLength(1));
    child.stdout.write('{"id":1,"result":{"ok":true}}\n');

    await expect(response).resolves.toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      ['app-server', '--listen', 'stdio://'],
      expect.objectContaining({
        cwd: '/workspace',
        env: { PATH: '/usr/bin', CODEX_HOME: '/runtime/home' },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  it('should_route_notifications_and_server_requests_from_split_stdout', async () => {
    const child = new FakeChild();
    const notifications: unknown[] = [];
    const serverRequests: unknown[] = [];
    const host = new AppServerProcessHost(
      baseOptions(),
      { spawn: () => child, signalProcessGroup: vi.fn() },
      {
        onNotification: (frame) => notifications.push(frame),
        onServerRequest: (frame) => serverRequests.push(frame),
      },
    );
    host.start();

    child.stdout.write('{"method":"thread/status/');
    child.stdout.write('changed","params":{}}\n');
    child.stdout.write('{"id":"s1","method":"attestation/generate","params":{}}\n');
    await flush();

    expect(notifications).toHaveLength(1);
    expect(serverRequests).toHaveLength(1);
  });

  it('should_fail_closed_on_truncated_stdout_eof', async () => {
    const child = new FakeChild();
    const fatal = vi.fn();
    const host = new AppServerProcessHost(
      baseOptions(),
      { spawn: () => child, signalProcessGroup: vi.fn() },
      { onFatal: fatal },
    );
    host.start();
    child.stdout.write('{"id":');
    child.stdout.end();
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledTimes(1));

    expect(host.isFailed()).toBe(true);
  });

  it('should_redact_stderr_diagnostics_without_forwarding_it_as_protocol', async () => {
    const child = new FakeChild();
    const host = new AppServerProcessHost(
      { ...baseOptions(), maxStderrBytes: 16 },
      { spawn: () => child, signalProcessGroup: vi.fn() },
    );
    host.start();

    child.stderr.write('sensitive-stderr secret-capability-token');
    await flush();

    expect(host.stderrDiagnostic()).toMatch(/^\[redacted app-server stderr: \d+ bytes\]$/);
    expect(host.stderrDiagnostic()).not.toMatch(/sensitive-stderr|secret-capability-token/);
  });

  it('should_fail_safely_when_spawn_emits_error_without_exit', async () => {
    const child = new FailedChild();
    const fatal = vi.fn();
    const host = new AppServerProcessHost(
      baseOptions(),
      { spawn: () => child, signalProcessGroup: vi.fn() },
      { onFatal: fatal },
    );
    host.start();

    expect(() => {
      child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
      child.emit('error', Object.assign(new Error('spawn failed again'), { code: 'ENOENT' }));
    }).not.toThrow();

    await vi.waitFor(() => expect(fatal).toHaveBeenCalledTimes(1));
    expect(host.isFailed()).toBe(true);
    await expect(host.request('thread/read', {})).rejects.toBeInstanceOf(ProcessHostError);
  });

  it('should_escalate_from_sigterm_to_sigkill_when_child_does_not_exit', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const signalProcessGroup = vi.fn();
    const host = new AppServerProcessHost(
      { ...baseOptions(), terminateGraceMs: 50 },
      { spawn: () => child, signalProcessGroup },
    );
    host.start();

    const stopped = host.stop();
    expect(signalProcessGroup).toHaveBeenCalledWith(child, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(50);
    expect(signalProcessGroup).toHaveBeenCalledWith(child, 'SIGKILL');
    child.emit('exit', null, 'SIGKILL');
    await expect(stopped).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('should_reject_stop_when_process_group_exit_cannot_be_confirmed', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const host = new AppServerProcessHost(
        { ...baseOptions(), terminateGraceMs: 50 },
        { spawn: () => child, signalProcessGroup: vi.fn() },
      );
      host.start();
      let settlement: 'pending' | 'resolved' | 'rejected' = 'pending';

      void host.stop().then(
        () => { settlement = 'resolved'; },
        () => { settlement = 'rejected'; },
      );
      await vi.advanceTimersByTimeAsync(100);

      expect(settlement).toBe('rejected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should_keep_the_cleanup_deadline_timer_referenced', async () => {
    const child = new FakeChild();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const host = new AppServerProcessHost(
        { ...baseOptions(), terminateGraceMs: 10_000 },
        {
          spawn: () => child,
          signalProcessGroup: vi.fn(),
          isProcessGroupAlive: () => false,
        },
      );
      host.start();

      const stopped = host.stop();
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
      const child = new FakeChild();
      let groupAlive = true;
      const signalProcessGroup = vi.fn(
        (target: FakeChild, signal: NodeJS.Signals) => {
          if (signal === 'SIGTERM') target.emit('exit', 0, null);
          if (signal === 'SIGKILL') groupAlive = false;
        },
      );
      const host = new AppServerProcessHost(
        { ...baseOptions(), terminateGraceMs: 50 },
        {
          spawn: () => child,
          signalProcessGroup,
          isProcessGroupAlive: () => groupAlive,
        },
      );
      host.start();

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
      const child = new FakeChild();
      let groupAlive = true;
      const signalProcessGroup = vi.fn(
        (_target: FakeChild, signal: NodeJS.Signals) => {
          if (signal === 'SIGKILL') groupAlive = false;
        },
      );
      const host = new AppServerProcessHost(
        { ...baseOptions(), terminateGraceMs: 50 },
        {
          spawn: () => child,
          signalProcessGroup,
          isProcessGroupAlive: () => groupAlive,
        },
      );
      host.start();

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
      const child = new FakeChild();
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
      const host = new AppServerProcessHost(
        { ...baseOptions(), terminateGraceMs: 50 },
        { spawn: () => child, signalProcessGroup },
      );
      host.start();

      const stopped = host.stop();
      await vi.advanceTimersByTimeAsync(50);

      expect(signalProcessGroup).toHaveBeenCalledWith(child, 'SIGKILL');
      await expect(stopped).resolves.toBeUndefined();
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('should_reject_pending_rpc_immediately_when_stopped', async () => {
    const child = new FakeChild();
    const signalProcessGroup = vi.fn((target: FakeChild) => target.emit('exit', 0, null));
    const host = new AppServerProcessHost(baseOptions(), {
      spawn: () => child,
      signalProcessGroup,
    });
    host.start();
    const pending = host.request('thread/read', { threadId: 'thr_pending' });
    await flush();
    const rejected = expect(pending).rejects.toThrow(/stopped/);

    await host.stop();

    await rejected;
  });

  it('should_reject_use_before_start_or_after_fatal_exit', async () => {
    const child = new FakeChild();
    const host = new AppServerProcessHost(baseOptions(), {
      spawn: () => child,
      signalProcessGroup: vi.fn(),
    });
    await expect(host.request('thread/read', {})).rejects.toBeInstanceOf(ProcessHostError);
    host.start();
    child.emit('exit', 1, null);
    await expect(host.request('thread/read', {})).rejects.toBeInstanceOf(ProcessHostError);
  });

  it('should_treat_an_unrequested_clean_exit_as_fatal_and_escalate_a_protocol_fatal', async () => {
    vi.useFakeTimers();
    try {
      const cleanChild = new FakeChild();
      const cleanFatal = vi.fn();
      const cleanHost = new AppServerProcessHost(
        baseOptions(),
        { spawn: () => cleanChild, signalProcessGroup: vi.fn() },
        { onFatal: cleanFatal },
      );
      cleanHost.start();
      cleanChild.emit('exit', 0, null);
      expect(cleanFatal).toHaveBeenCalledTimes(1);

      const stuckChild = new FakeChild();
      const signal = vi.fn();
      const stuckHost = new AppServerProcessHost(
        { ...baseOptions(), terminateGraceMs: 25 },
        { spawn: () => stuckChild, signalProcessGroup: signal },
      );
      stuckHost.start();
      stuckChild.stdout.write('{invalid}\n');
      await vi.runAllTicks();
      expect(signal).toHaveBeenCalledWith(stuckChild, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(25);
      expect(signal).toHaveBeenCalledWith(stuckChild, 'SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });
});

function baseOptions() {
  return {
    bin: 'codex',
    cwd: '/workspace',
    codexHome: '/runtime/home',
    env: { PATH: '/usr/bin' },
    requestTimeoutMs: 1000,
    terminateGraceMs: 100,
  };
}

function readWorkerInfo(
  stdout: NodeJS.ReadableStream,
): Promise<{ pid: number; rootDir: string }> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('worker pid timeout')), 3_000);
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      const parsed = JSON.parse(buffered.slice(0, newline)) as {
        pid?: unknown;
        rootDir?: unknown;
      };
      if (
        !Number.isInteger(parsed.pid) ||
        Number(parsed.pid) <= 0 ||
        typeof parsed.rootDir !== 'string'
      ) {
        reject(new Error('worker returned invalid process pid'));
        return;
      }
      resolve({ pid: Number(parsed.pid), rootDir: parsed.rootDir });
    });
  });
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
