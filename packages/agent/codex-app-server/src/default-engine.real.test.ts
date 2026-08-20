import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ExperimentalTmuxTerminalSessionHost } from '@agent-nexus/daemon';
import type { AgentEvent, SessionConfig, SessionKey } from '@agent-nexus/protocol';
import { createDefaultCodexAppServerEngineFactory } from './default-engine.js';
import type { CodexAppServerConfig } from './config.js';
import { CodexRemoteViewerAdapter } from './remote-viewer.js';
import { createCodexAppServerRuntime } from './runtime.js';
import {
  runCodexAppServerCompatibilityProbe,
  runCodexAppServerViewerCompatibilityProbe,
} from './probe.js';

const runReal = process.env['AGENT_NEXUS_RUN_CODEX_APP_SERVER_E2E'] === '1';
const runViewer = process.env['AGENT_NEXUS_RUN_CODEX_VIEWER_E2E'] === '1';
const roots: string[] = [];
const CRASH_WORKER_URL = new URL('../testdata/real-crash-worker.mjs', import.meta.url);

interface RealViewerMetadata {
  viewerId: string;
  binding: {
    homeId: string;
    appServerIncarnationId: string;
    threadId: string;
  };
  terminal: { sessionId: string; ownerToken: string };
  endpoint: string;
  tokenFile: string;
}

afterAll(async () => {
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!runReal)('Codex app-server real integration', () => {
  beforeAll(async () => {
    const bin = process.env['CODEX_BIN'] || 'codex';
    await runCodexAppServerCompatibilityProbe({ bin });
    if (runViewer) await runCodexAppServerViewerCompatibilityProbe({ bin });
  });

  it('should_run_two_turns_then_resume_the_same_durable_thread_in_a_new_child', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-nexus-real-app-server-'));
    roots.push(temporaryRoot);
    await chmod(temporaryRoot, 0o700);
    const persistenceRoot = await realpath(temporaryRoot);
    const workingDir = await realpath(process.cwd());
    const sourceCodexHome = await realpath(
      process.env['CODEX_HOME'] || join(homedir(), '.codex'),
    );
    const key: SessionKey = {
      platformName: 'real-e2e',
      platform: 'lark',
      channelId: 'chat-real',
      initiatorUserId: 'user-real',
    };
    const sessionConfig: SessionConfig = {
      sessionId: 'real-session',
      workingDir,
      timeoutMs: 120_000,
    };
    const backendConfig: CodexAppServerConfig = {
      bin: process.env['CODEX_BIN'] || 'codex',
      workingDir,
      sandbox: 'read-only',
      addDirs: [],
      maxInputBytes: 262_144,
      requestTimeoutMs: 30_000,
      interruptGraceMs: 5_000,
      terminateGraceMs: 5_000,
      conversationRetentionMs: null,
      supplementalViewer: { enabled: false },
    };
    const dependencies = {
      sourceCodexHome,
      persistenceRoot,
      agentName: 'real-codex',
      clientVersion: '0.1.0-e2e',
      environment: process.env,
    };
    const first = createDefaultCodexAppServerEngineFactory(dependencies)({
      key,
      sessionConfig,
      backendConfig,
    });
    const started = await first.start();
    await expect(first.runTurn('Reply with exactly FIRST_OK', 'real-message-1')).resolves.toMatchObject({
      status: 'completed',
      text: expect.stringContaining('FIRST_OK'),
    });
    await expect(first.runTurn('Reply with exactly SECOND_OK', 'real-message-2')).resolves.toMatchObject({
      status: 'completed',
      text: expect.stringContaining('SECOND_OK'),
    });
    await first.stop();

    const resumed = createDefaultCodexAppServerEngineFactory(dependencies)({
      key: { ...key, channelId: 'chat-rebound' },
      sessionConfig,
      backendConfig,
    });
    await expect(resumed.start(started.threadId)).resolves.toMatchObject({ threadId: started.threadId });
    await expect(
      resumed.runTurn('Reply with exactly RESUME_OK', 'real-message-3'),
    ).resolves.toMatchObject({
      status: 'completed',
      text: expect.stringContaining('RESUME_OK'),
    });
    const interrupted = resumed.runTurn(
      'Run the shell command `sleep 30`, wait for it, then reply with TOO_LATE.',
      'real-message-interrupt',
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await expect(resumed.interrupt()).resolves.toBe(true);
    await expect(interrupted).resolves.toMatchObject({ status: 'interrupted' });
    await resumed.stop();
  }, 180_000);

  it.skipIf(!runViewer)(
    'should_broadcast_to_the_authenticated_tmux_viewer_and_reject_the_previous_incarnation_token',
    async () => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-nexus-real-viewer-'));
      roots.push(temporaryRoot);
      await chmod(temporaryRoot, 0o700);
      const persistenceRoot = await realpath(temporaryRoot);
      const terminalRoot = join(persistenceRoot, 'terminal');
      await mkdir(terminalRoot, { mode: 0o700 });
      const workingDir = await realpath(process.cwd());
      const sourceCodexHome = await realpath(
        process.env['CODEX_HOME'] || join(homedir(), '.codex'),
      );
      const terminalHost = new ExperimentalTmuxTerminalSessionHost({
        rootDir: terminalRoot,
      });
      const viewerAdapter = new CodexRemoteViewerAdapter({
        terminalHost,
        pollIntervalMs: 100,
      });
      const key: SessionKey = {
        platformName: 'real-viewer-e2e',
        platform: 'lark',
        channelId: 'chat-viewer',
        initiatorUserId: 'user-viewer',
      };
      const sessionConfig: SessionConfig = {
        sessionId: 'real-viewer-session',
        workingDir,
        timeoutMs: 120_000,
      };
      const backendConfig: CodexAppServerConfig = {
        bin: process.env['CODEX_BIN'] || 'codex',
        workingDir,
        sandbox: 'read-only',
        addDirs: [],
        maxInputBytes: 262_144,
        requestTimeoutMs: 30_000,
        interruptGraceMs: 5_000,
        terminateGraceMs: 5_000,
        conversationRetentionMs: null,
        supplementalViewer: { enabled: true },
      };
      const factory = createDefaultCodexAppServerEngineFactory({
        sourceCodexHome,
        persistenceRoot,
        agentName: 'real-codex-viewer',
        clientVersion: '0.1.0-viewer-e2e',
        environment: process.env,
        viewerAdapter,
      });
      let first: ReturnType<typeof factory> | null = factory({
        key,
        sessionConfig,
        backendConfig,
      });
      let resumed: ReturnType<typeof factory> | null = null;
      try {
        const started = await first.start();
        await expect(
          first.runTurn(
            'Reply with exactly REAL_VIEWER_SEED_OK_731 and nothing else.',
            'real-viewer-seed-message',
          ),
        ).resolves.toMatchObject({ status: 'completed' });
        const firstViewer = await readViewerMetadata(persistenceRoot, started.threadId);
        const firstToken = (await readFile(firstViewer.tokenFile, 'utf8')).trim();
        const firstTerminal = terminalHost.recover(
          firstViewer.terminal.sessionId,
          firstViewer.terminal.ownerToken,
        );
        await waitForViewerReady(
          terminalHost,
          firstTerminal,
          'REAL_VIEWER_SEED_OK_731',
        );
        const firstMarker = 'REAL_VIEWER_BROADCAST_ONE_731';
        const firstPrompt =
          'Reply with exactly the concatenation of REAL_VIEWER_BROADCAST_ONE_ and the decimal result of 700 + 31, with nothing else.';
        expect(firstPrompt).not.toContain(firstMarker);
        await expect(
          first.runTurn(
            firstPrompt,
            'real-viewer-message-1',
          ),
        ).resolves.toMatchObject({
          status: 'completed',
          text: expect.stringContaining(firstMarker),
        });
        await expect.poll(
          () => terminalHost.snapshot(
            firstTerminal.sessionId,
            firstTerminal.ownerToken,
            firstTerminal.incarnationId,
            20_000,
          ).text,
          { timeout: 30_000, interval: 250 },
        ).toContain(firstMarker);

        await first.stop();
        first = null;
        await expect(lstat(join(firstViewer.tokenFile, '..'))).rejects.toMatchObject({
          code: 'ENOENT',
        });

        resumed = factory({
          key: { ...key, channelId: 'chat-viewer-rebound' },
          sessionConfig,
          backendConfig,
        });
        await expect(resumed.start(started.threadId)).resolves.toMatchObject({
          threadId: started.threadId,
        });
        const secondViewer = await readViewerMetadata(persistenceRoot, started.threadId);
        const secondToken = (await readFile(secondViewer.tokenFile, 'utf8')).trim();
        expect(secondViewer.binding.appServerIncarnationId).not.toBe(
          firstViewer.binding.appServerIncarnationId,
        );
        expect(secondToken).not.toBe(firstToken);
        await expect(webSocketStatus(secondViewer.endpoint, firstToken)).resolves.toBe(401);

        const secondTerminal = terminalHost.recover(
          secondViewer.terminal.sessionId,
          secondViewer.terminal.ownerToken,
        );
        await waitForViewerReady(terminalHost, secondTerminal, firstMarker);
        const secondMarker = 'REAL_VIEWER_BROADCAST_TWO_731';
        const secondPrompt =
          'Reply with exactly the concatenation of REAL_VIEWER_BROADCAST_TWO_ and the decimal result of 700 + 31, with nothing else.';
        expect(secondPrompt).not.toContain(secondMarker);
        await expect(
          resumed.runTurn(
            secondPrompt,
            'real-viewer-message-2',
          ),
        ).resolves.toMatchObject({
          status: 'completed',
          text: expect.stringContaining(secondMarker),
        });
        await expect.poll(
          () => terminalHost.snapshot(
            secondTerminal.sessionId,
            secondTerminal.ownerToken,
            secondTerminal.incarnationId,
            20_000,
          ).text,
          { timeout: 30_000, interval: 250 },
        ).toContain(secondMarker);
      } finally {
        if (resumed) await resumed.stop().catch(() => undefined);
        if (first) await first.stop().catch(() => undefined);
        terminalHost.shutdown();
      }
    },
    180_000,
  );

  it.skipIf(!runViewer)(
    'should_reap_the_previous_app_server_and_viewer_before_resuming_after_daemon_sigkill',
    async () => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-nexus-real-crash-'));
      roots.push(temporaryRoot);
      await chmod(temporaryRoot, 0o700);
      const persistenceRoot = await realpath(temporaryRoot);
      const terminalRoot = join(persistenceRoot, 'terminal');
      await mkdir(terminalRoot, { mode: 0o700 });
      const workingDir = await realpath(process.cwd());
      const sourceCodexHome = await realpath(
        process.env['CODEX_HOME'] || join(homedir(), '.codex'),
      );
      const worker = spawn(
        process.execPath,
        [
          '--conditions=development',
          '--import',
          'tsx',
          fileURLToPath(CRASH_WORKER_URL),
        ],
        {
          cwd: workingDir,
          env: {
            ...process.env,
            AGENT_NEXUS_E2E_PERSISTENCE_ROOT: persistenceRoot,
            AGENT_NEXUS_E2E_TERMINAL_ROOT: terminalRoot,
            AGENT_NEXUS_E2E_WORKING_DIR: workingDir,
            AGENT_NEXUS_E2E_SOURCE_CODEX_HOME: sourceCodexHome,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let workerExited = false;
      worker.once('exit', () => { workerExited = true; });
      let terminalHost: ExperimentalTmuxTerminalSessionHost | null = null;
      let resumed: ReturnType<ReturnType<typeof createDefaultCodexAppServerEngineFactory>> | null = null;
      try {
        const crashState = await readWorkerState(worker);
        expect(processGroupExists(crashState.appServerPgid)).toBe(true);
        expect(processGroupExists(crashState.viewerPgid)).toBe(true);

        worker.kill('SIGKILL');
        await waitForChildExit(worker);
        await expect.poll(
          () => processGroupExists(crashState.appServerPgid),
          { timeout: 5_000, interval: 50 },
        ).toBe(false);

        terminalHost = new ExperimentalTmuxTerminalSessionHost({ rootDir: terminalRoot });
        const viewerAdapter = new CodexRemoteViewerAdapter({
          terminalHost,
          pollIntervalMs: 100,
        });
        const factory = createDefaultCodexAppServerEngineFactory({
          sourceCodexHome,
          persistenceRoot,
          agentName: 'real-codex-crash-worker',
          clientVersion: '0.1.0-crash-e2e',
          environment: process.env,
          viewerAdapter,
        });
        await factory.prepare();
        await expect.poll(
          () => processGroupExists(crashState.viewerPgid),
          { timeout: 5_000, interval: 50 },
        ).toBe(false);
        await expect(lstat(crashState.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });

        const backendConfig: CodexAppServerConfig = {
          bin: process.env['CODEX_BIN'] || 'codex',
          workingDir,
          sandbox: 'read-only',
          addDirs: [],
          maxInputBytes: 262_144,
          requestTimeoutMs: 30_000,
          interruptGraceMs: 5_000,
          terminateGraceMs: 5_000,
          conversationRetentionMs: null,
          supplementalViewer: { enabled: true },
        };
        resumed = factory({
          key: {
            platformName: 'real-crash-e2e',
            platform: 'lark',
            channelId: 'chat-after-crash',
            initiatorUserId: 'user-crash',
          },
          sessionConfig: {
            sessionId: 'real-crash-session',
            workingDir,
            timeoutMs: 120_000,
          },
          backendConfig,
        });
        await expect(resumed.start(crashState.threadId)).resolves.toMatchObject({
          threadId: crashState.threadId,
        });
        await expect(
          resumed.runTurn(
            'Reply with exactly REAL_CRASH_RESUME_OK_731 and nothing else.',
            'real-crash-resume-message',
          ),
        ).resolves.toMatchObject({
          status: 'completed',
          text: expect.stringContaining('REAL_CRASH_RESUME_OK_731'),
        });
      } finally {
        if (resumed) await resumed.stop().catch(() => undefined);
        terminalHost?.shutdown();
        if (!workerExited) {
          worker.kill('SIGKILL');
          await waitForChildExit(worker).catch(() => undefined);
        }
      }
    },
    180_000,
  );

  it.skipIf(!runViewer)(
    'should_stop_without_platform_attribution_when_the_real_viewer_starts_a_foreign_turn',
    async () => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-nexus-real-foreign-'));
      roots.push(temporaryRoot);
      await chmod(temporaryRoot, 0o700);
      const persistenceRoot = await realpath(temporaryRoot);
      const terminalRoot = join(persistenceRoot, 'terminal');
      await mkdir(terminalRoot, { mode: 0o700 });
      const workingDir = await realpath(process.cwd());
      const sourceCodexHome = await realpath(
        process.env['CODEX_HOME'] || join(homedir(), '.codex'),
      );
      const terminalHost = new ExperimentalTmuxTerminalSessionHost({ rootDir: terminalRoot });
      const viewerAdapter = new CodexRemoteViewerAdapter({
        terminalHost,
        pollIntervalMs: 100,
      });
      const backendConfig: CodexAppServerConfig = {
        bin: process.env['CODEX_BIN'] || 'codex',
        workingDir,
        sandbox: 'read-only',
        addDirs: [],
        maxInputBytes: 262_144,
        requestTimeoutMs: 30_000,
        interruptGraceMs: 5_000,
        terminateGraceMs: 5_000,
        conversationRetentionMs: null,
        supplementalViewer: { enabled: true },
      };
      const factory = createDefaultCodexAppServerEngineFactory({
        sourceCodexHome,
        persistenceRoot,
        agentName: 'real-codex-foreign',
        clientVersion: '0.1.0-foreign-e2e',
        environment: process.env,
        viewerAdapter,
      });
      const runtime = createCodexAppServerRuntime(backendConfig, {
        createEngine: factory,
      });
      const session = runtime.startSession(
        {
          platformName: 'real-foreign-e2e',
          platform: 'lark',
          channelId: 'chat-foreign',
          initiatorUserId: 'user-foreign',
        },
        {
          sessionId: 'real-foreign-session',
          workingDir,
          timeoutMs: 120_000,
        },
      );
      const events: AgentEvent[] = [];
      runtime.onEvent(session, (event) => { events.push(event); });
      try {
        await expect.poll(() => session.state, { timeout: 30_000 }).toBe('Idle');
        const threadId = session.agentSessionId;
        if (!threadId) throw new Error('real foreign-turn session has no thread id');
        const metadata = await readViewerMetadata(persistenceRoot, threadId);
        const terminal = terminalHost.recover(
          metadata.terminal.sessionId,
          metadata.terminal.ownerToken,
        );
        await runtime.sendInput(session, {
          type: 'user_message',
          traceId: 'real-foreign-seed-trace',
          text: 'Reply with exactly REAL_FOREIGN_SEED_OK_731 and nothing else.',
        });
        expect(events).toContainEqual(expect.objectContaining({
          type: 'text_final',
          traceId: 'real-foreign-seed-trace',
        }));
        events.length = 0;
        await waitForViewerReady(
          terminalHost,
          terminal,
          'REAL_FOREIGN_SEED_OK_731',
        );
        const viewerPgid = await waitForProcessGroupId(
          join(terminalRoot, `child-${terminal.sessionId}.pid`),
        );

        terminalHost.write(
          terminal.sessionId,
          terminal.ownerToken,
          terminal.incarnationId,
          {
            mode: 'BracketedPaste',
            text: 'Reply with exactly FOREIGN_TURN_MUST_NOT_BE_ATTRIBUTED_731.',
          },
        );

        await expect.poll(
          () => events.some((event) => event.type === 'session_stopped'),
          { timeout: 30_000, interval: 100 },
        ).toBe(true);
        expect(events.map((event) => event.type)).toEqual(['session_stopped']);
        expect(events.at(-1)).toMatchObject({
          type: 'session_stopped',
          traceId: 'system',
          payload: { reason: 'error' },
        });
        await expect(lstat(metadata.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect.poll(
          () => processGroupExists(viewerPgid),
          { timeout: 5_000, interval: 50 },
        ).toBe(false);
        await expect.poll(
          () => processGroupExists(session.pid!),
          { timeout: 5_000, interval: 50 },
        ).toBe(false);
      } finally {
        await runtime.stopSession(session).catch(() => undefined);
        terminalHost.shutdown();
      }
    },
    180_000,
  );
});

async function readViewerMetadata(
  persistenceRoot: string,
  threadId: string,
): Promise<RealViewerMetadata> {
  const registry = JSON.parse(
    await readFile(join(persistenceRoot, 'registry.json'), 'utf8'),
  ) as {
    records: Array<{ homeId: string; threadId: string | null }>;
  };
  const record = registry.records.find((candidate) => candidate.threadId === threadId);
  if (!record) throw new Error(`missing real viewer registry record for ${threadId}`);
  const runtimeRoot = join(
    persistenceRoot,
    'homes',
    record.homeId,
    'agent-nexus-runtime',
  );
  for (const entry of await readdir(runtimeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadataPath = join(runtimeRoot, entry.name, 'codex-remote-viewer-owner.json');
    try {
      return JSON.parse(await readFile(metadataPath, 'utf8')) as RealViewerMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`missing real viewer metadata for ${threadId}`);
}

function webSocketStatus(endpoint: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      followRedirects: false,
      headers: { Authorization: `Bearer ${token}` },
    });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('real viewer WebSocket admission timed out'));
    }, 5_000);
    socket.once('open', () => {
      clearTimeout(timeout);
      socket.close();
      resolve(101);
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

interface CrashWorkerState {
  threadId: string;
  appServerPgid: number;
  viewerPgid: number;
  tokenFile: string;
}

function readWorkerState(worker: ChildProcessWithoutNullStreams): Promise<CrashWorkerState> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`real crash worker startup timed out: ${stderr}`));
    }, 30_000);
    worker.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    worker.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)) as CrashWorkerState);
      } catch (error) {
        reject(error);
      }
    });
    worker.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(
        `real crash worker exited before ready code=${String(code)} signal=${String(signal)}: ${stderr}`,
      ));
    });
  });
}

function waitForChildExit(worker: ChildProcessWithoutNullStreams): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => worker.once('exit', () => resolve()));
}

function processGroupExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error(`invalid process-group id: ${String(pid)}`);
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessGroupId(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (
        value &&
        typeof value === 'object' &&
        Number.isSafeInteger((value as { pid?: unknown }).pid) &&
        ((value as { pid: number }).pid > 0) &&
        typeof (value as { identity?: unknown }).identity === 'string' &&
        (value as { identity: string }).identity.length > 0
      ) {
        return (value as { pid: number }).pid;
      }
    } catch {
      // The launcher publishes intermediate spawning/numeric states first.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('terminal child process identity did not become ready');
}

async function waitForViewerReady(
  terminalHost: ExperimentalTmuxTerminalSessionHost,
  terminal: ReturnType<ExperimentalTmuxTerminalSessionHost['recover']>,
  expectedHistory: string,
): Promise<void> {
  await expect.poll(
    () => {
      const text = terminalHost.snapshot(
        terminal.sessionId,
        terminal.ownerToken,
        terminal.incarnationId,
        20_000,
      ).text;
      return text.includes(expectedHistory) && text.includes('›');
    },
    { timeout: 30_000, interval: 250 },
  ).toBe(true);
}
