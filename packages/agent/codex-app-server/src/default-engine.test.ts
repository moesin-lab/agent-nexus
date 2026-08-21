import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SessionConfig, SessionKey } from '@agent-nexus/protocol';
import {
  ProcessHostError,
  type ProcessHostCallbacks,
  type ProcessHostOptions,
} from './process-host.js';
import { ConversationRegistry } from './conversation-registry.js';
import {
  createDefaultCodexAppServerEngineFactory,
  type CodexAppServerHostPort,
  type CodexAppServerViewerHostPort,
} from './default-engine.js';
import type { CodexAppServerConfig } from './config.js';
import type { RpcRequestOptions } from './rpc-transport.js';
import type {
  CodexRemoteViewerHandle,
  CodexRemoteViewerPort,
  CodexRemoteViewerStartInput,
} from './remote-viewer.js';
import { createCodexAppServerRuntime } from './runtime.js';

const roots: string[] = [];

async function privateDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  await chmod(path, 0o700);
  return realpath(path);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true })));
});

class FakeHost implements CodexAppServerHostPort {
  readonly requests: string[] = [];
  readonly requestDetails: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: RpcRequestOptions;
  }> = [];
  stopped = false;
  private turnNumber = 0;
  private readonly processes = new Map<string, (response: unknown) => void>();

  constructor(
    readonly options: ProcessHostOptions,
    readonly callbacks: ProcessHostCallbacks,
  ) {}

  start(): void | Promise<void> {}
  pid(): number { return 9001; }
  status = 'unused';

  async request(
    method: string,
    params: unknown,
    options?: RpcRequestOptions,
  ): Promise<unknown> {
    this.requests.push(method);
    this.requestDetails.push({
      method,
      params: params as Record<string, unknown>,
      ...(options === undefined ? {} : { options }),
    });
    if (method === 'initialize') {
      return {
        codexHome: this.options.codexHome,
        userAgent: 'agent-nexus/0.146.0 (test)',
        platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
        platformOs: process.platform === 'darwin' ? 'macos' : process.platform,
      };
    }
    if (method === 'thread/start') {
      return { thread: { id: 'thr_durable', ephemeral: false, cwd: this.options.cwd } };
    }
    if (method === 'thread/resume') {
      const threadId = (params as { threadId: string }).threadId;
      this.callbacks.onNotification?.({
        method: 'thread/status/changed',
        params: { threadId, status: { type: 'idle' } },
      });
      this.callbacks.onNotification?.({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId,
          turnId: 'turn_previous',
          tokenUsage: { last: {}, total: {} },
        },
      });
      return {
        thread: {
          id: threadId,
          ephemeral: false,
          cwd: this.options.cwd,
          turns: [{ id: 'turn_previous', status: 'completed', items: [], error: null }],
        },
      };
    }
    if (method === 'turn/start') {
      this.turnNumber += 1;
      return { turn: { id: `turn_${this.turnNumber}`, status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') return {};
    if (method === 'command/exec') {
      const processId = (params as { processId: string }).processId;
      return new Promise<unknown>((resolve) => this.processes.set(processId, resolve));
    }
    if (method === 'command/exec/write') {
      const input = params as { processId: string; deltaBase64?: string };
      if (!this.processes.has(input.processId)) throw new Error('process not found');
      if (input.deltaBase64) {
        this.callbacks.onNotification?.({
          method: 'command/exec/outputDelta',
          params: {
            processId: input.processId,
            stream: 'stdout',
            deltaBase64: input.deltaBase64,
            capReached: false,
          },
        });
      }
      return {};
    }
    if (method === 'command/exec/terminate') {
      const processId = (params as { processId: string }).processId;
      const resolve = this.processes.get(processId);
      if (!resolve) throw new Error('process not found');
      this.processes.delete(processId);
      resolve({ exitCode: 137, stdout: '', stderr: '' });
      return {};
    }
    throw new Error(`unexpected ${method}`);
  }

  async notify(): Promise<void> {}
  async respondResult(): Promise<void> {}
  async respondError(): Promise<void> {}
  async stop(): Promise<void> { this.stopped = true; }
}

class FakeViewerHost extends FakeHost implements CodexAppServerViewerHostPort {
  viewerAdmission() {
    return {
      endpoint: 'ws://127.0.0.1:54321',
      appServerIncarnationId: '0123456789abcdef0123456789abcdef',
      tokenEnvName: 'AGENT_NEXUS_CODEX_REMOTE_TOKEN' as const,
      tokenFile: join(this.options.codexHome, 'agent-nexus-runtime', 'remote-live', 'capability-token'),
      runtimeDir: join(this.options.codexHome, 'agent-nexus-runtime', 'remote-live'),
    };
  }
}

const key: SessionKey = {
  platformName: 'lark-main',
  platform: 'lark',
  channelId: 'chat-1',
  initiatorUserId: 'user-1',
};

const sessionConfig: SessionConfig = {
  sessionId: 'routing-session-1',
  workingDir: '/workspace',
  timeoutMs: 30_000,
};

const backendConfig: CodexAppServerConfig = {
  bin: 'codex',
  workingDir: '/workspace',
  sandbox: 'read-only',
  addDirs: [],
  maxInputBytes: 262_144,
  requestTimeoutMs: 30_000,
  interruptGraceMs: 5_000,
  terminateGraceMs: 5_000,
  conversationRetentionMs: null,
  supplementalViewer: { enabled: false },
};

describe('createDefaultCodexAppServerEngineFactory', () => {
  it('should_keep_stdio_as_the_default_without_creating_a_viewer_or_websocket_host', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const createHost = vi.fn((options, callbacks) => new FakeHost(options, callbacks));
    const createWebSocketHost = vi.fn((options, callbacks) => new FakeViewerHost(options, callbacks));
    const viewerAdapter: CodexRemoteViewerPort = {
      start: vi.fn(),
      stop: vi.fn(),
      reconcileConversation: vi.fn(async () => undefined),
    };
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      createHost,
      createWebSocketHost,
      viewerAdapter,
    });

    const engine = factory({ key, sessionConfig, backendConfig });
    await engine.start();
    await engine.stop();

    expect(createHost).toHaveBeenCalledTimes(1);
    expect(createWebSocketHost).not.toHaveBeenCalled();
    expect(viewerAdapter.start).not.toHaveBeenCalled();
  });

  it('should_start_the_viewer_after_commit_and_live_lease_then_stop_it_before_the_host', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const registry = await ConversationRegistry.open(persistenceRoot);
    const order: string[] = [];
    let viewerHandle!: CodexRemoteViewerHandle;
    const viewerAdapter: CodexRemoteViewerPort = {
      start: vi.fn(async (input: CodexRemoteViewerStartInput) => {
        const persisted = JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8'));
        expect(persisted.records).toEqual([
          expect.objectContaining({
            homeId: input.binding.homeId,
            threadId: input.binding.threadId,
            status: 'committed',
          }),
        ]);
        await expect(registry.acquireLive(input.binding.homeId)).rejects.toThrow(/live owner/);
        order.push('viewer.start');
        viewerHandle = {
          viewerId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          binding: input.binding,
          state: 'Running',
        };
        return { kind: 'running' as const, handle: viewerHandle };
      }),
      stop: vi.fn(async (handle) => {
        expect(handle).toBe(viewerHandle);
        order.push('viewer.stop');
      }),
      reconcileConversation: vi.fn(async () => undefined),
    };
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      openRegistry: async () => registry,
      viewerAdapter,
      createHost: vi.fn(),
      createWebSocketHost: (options, callbacks) => {
        const host = new FakeViewerHost(options, callbacks);
        host.stop = vi.fn(async () => {
          order.push('host.stop');
          host.stopped = true;
        });
        return host;
      },
    });
    const engine = factory({
      key,
      sessionConfig,
      backendConfig: { ...backendConfig, supplementalViewer: { enabled: true } },
    });

    await expect(engine.start()).resolves.toMatchObject({ threadId: 'thr_durable' });
    await engine.stop();

    expect(viewerAdapter.start).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['viewer.start', 'viewer.stop', 'host.stop']);
  });

  it('should_wait_for_a_pending_viewer_start_before_stopping_the_host', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    let resolveViewer!: (result: Awaited<ReturnType<CodexRemoteViewerPort['start']>>) => void;
    const viewerReady = new Promise<Awaited<ReturnType<CodexRemoteViewerPort['start']>>>((resolve) => {
      resolveViewer = resolve;
    });
    const order: string[] = [];
    let host!: FakeViewerHost;
    const viewerAdapter: CodexRemoteViewerPort = {
      start: vi.fn(() => viewerReady),
      stop: vi.fn(async () => { order.push('viewer.stop'); }),
      reconcileConversation: vi.fn(async () => undefined),
    };
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      viewerAdapter,
      createWebSocketHost: (options, callbacks) => {
        host = new FakeViewerHost(options, callbacks);
        host.stop = vi.fn(async () => {
          order.push('host.stop');
          host.stopped = true;
        });
        return host;
      },
    });
    const engine = factory({
      key,
      sessionConfig,
      backendConfig: { ...backendConfig, supplementalViewer: { enabled: true } },
    });

    const starting = engine.start();
    await vi.waitFor(() => expect(viewerAdapter.start).toHaveBeenCalledTimes(1));
    const stopping = engine.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.stopped).toBe(false);
    const binding = vi.mocked(viewerAdapter.start).mock.calls[0]![0].binding;
    resolveViewer({
      kind: 'running',
      handle: {
        viewerId: 'ffffffffffffffffffffffffffffffff',
        binding,
        state: 'Running',
      },
    });

    await expect(starting).rejects.toThrow(/stopped during startup/);
    await expect(stopping).resolves.toBeUndefined();
    expect(order).toEqual(['viewer.stop', 'host.stop']);
  });

  it('should_start_a_resumed_viewer_only_after_binding_audit_and_live_lease', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const registry = await ConversationRegistry.open(persistenceRoot);
    const provisional = await registry.createProvisional(
      { backend: 'codex-app-server', agentName: 'codex-dev' },
      'original-audit',
    );
    await registry.commit(provisional.homeId, 'thr_resume');
    const viewerAdapter: CodexRemoteViewerPort = {
      start: vi.fn(async (input) => {
        const persisted = JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8'));
        expect(persisted.records[0].bindingAudits.at(-1).sessionKey).toBe(
          JSON.stringify(['lark-main', 'lark', 'chat-rebound', 'user-1']),
        );
        await expect(registry.acquireLive(input.binding.homeId)).rejects.toThrow(/live owner/);
        return {
          kind: 'running' as const,
          handle: {
            viewerId: 'cccccccccccccccccccccccccccccccc',
            binding: input.binding,
            state: 'Running' as const,
          },
        };
      }),
      stop: vi.fn(async () => undefined),
      reconcileConversation: vi.fn(async () => undefined),
    };
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      openRegistry: async () => registry,
      viewerAdapter,
      createWebSocketHost: (options, callbacks) => new FakeViewerHost(options, callbacks),
    });
    const engine = factory({
      key: { ...key, channelId: 'chat-rebound' },
      sessionConfig,
      backendConfig: { ...backendConfig, supplementalViewer: { enabled: true } },
    });

    await expect(engine.start('thr_resume')).resolves.toMatchObject({ threadId: 'thr_resume' });
    expect(viewerAdapter.start).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  it('should_keep_structured_control_running_when_viewer_start_is_confirmed_unavailable', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const maintenance = vi.fn();
    const unavailable = new Error('tmux unavailable');
    const viewerAdapter: CodexRemoteViewerPort = {
      start: vi.fn(async () => ({ kind: 'unavailable' as const, error: unavailable })),
      stop: vi.fn(async () => undefined),
      reconcileConversation: vi.fn(async () => undefined),
    };
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      viewerAdapter,
      onMaintenanceError: maintenance,
      createWebSocketHost: (options, callbacks) => new FakeViewerHost(options, callbacks),
    });
    const engine = factory({
      key,
      sessionConfig,
      backendConfig: { ...backendConfig, supplementalViewer: { enabled: true } },
    });

    await expect(engine.start()).resolves.toMatchObject({ threadId: 'thr_durable' });
    expect(maintenance).toHaveBeenCalledWith(unavailable);
    expect(engine.status()).toBe('Idle');
    await engine.stop();
    expect(viewerAdapter.stop).not.toHaveBeenCalled();
  });

  it('should_rollback_a_viewer_when_the_structured_host_fails_during_viewer_start', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    let resolveViewer!: (result: Awaited<ReturnType<CodexRemoteViewerPort['start']>>) => void;
    const viewerReady = new Promise<Awaited<ReturnType<CodexRemoteViewerPort['start']>>>((resolve) => {
      resolveViewer = resolve;
    });
    let host!: FakeViewerHost;
    const viewerAdapter: CodexRemoteViewerPort = {
      start: vi.fn(() => viewerReady),
      stop: vi.fn(async () => undefined),
      reconcileConversation: vi.fn(async () => undefined),
    };
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      viewerAdapter,
      createWebSocketHost: (options, callbacks) => {
        host = new FakeViewerHost(options, callbacks);
        return host;
      },
    });
    const engine = factory({
      key,
      sessionConfig,
      backendConfig: { ...backendConfig, supplementalViewer: { enabled: true } },
    });

    const starting = engine.start();
    await vi.waitFor(() => expect(viewerAdapter.start).toHaveBeenCalledTimes(1));
    const binding = vi.mocked(viewerAdapter.start).mock.calls[0]![0].binding;
    host.callbacks.onFatal?.(new ProcessHostError('host failed during viewer start'));
    resolveViewer({
      kind: 'running',
      handle: {
        viewerId: 'dddddddddddddddddddddddddddddddd',
        binding,
        state: 'Running',
      },
    });

    await expect(starting).rejects.toThrow(/host failed during viewer start/);
    expect(viewerAdapter.stop).toHaveBeenCalledTimes(1);
    expect(host.stopped).toBe(true);
  });

  it('should_keep_an_ambiguous_viewer_handle_in_the_session_stop_barrier', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const ambiguousError = new Error('viewer start acknowledgement lost');
    let ambiguousHandle!: CodexRemoteViewerHandle;
    const viewerAdapter: CodexRemoteViewerPort = {
      start: vi.fn(async (input) => {
        ambiguousHandle = {
          viewerId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          binding: input.binding,
          state: 'StartAmbiguous',
        };
        return { kind: 'ambiguous' as const, handle: ambiguousHandle, error: ambiguousError };
      }),
      stop: vi.fn(async () => undefined),
      reconcileConversation: vi.fn(async () => undefined),
    };
    const maintenance = vi.fn();
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      viewerAdapter,
      onMaintenanceError: maintenance,
      createWebSocketHost: (options, callbacks) => new FakeViewerHost(options, callbacks),
    });
    const engine = factory({
      key,
      sessionConfig,
      backendConfig: { ...backendConfig, supplementalViewer: { enabled: true } },
    });

    await expect(engine.start()).resolves.toMatchObject({ threadId: 'thr_durable' });
    expect(maintenance).toHaveBeenCalledWith(ambiguousError);
    await engine.stop();

    expect(viewerAdapter.stop).toHaveBeenCalledWith(ambiguousHandle);
  });

  it('should_continue_host_cleanup_but_reject_stop_when_viewer_force_stop_fails', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const viewerStopError = new Error('viewer exit not confirmed');
    const viewerAdapter: CodexRemoteViewerPort = {
      start: vi.fn(async (input) => ({
        kind: 'running' as const,
        handle: {
          viewerId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          binding: input.binding,
          state: 'Running' as const,
        },
      })),
      stop: vi.fn(async () => { throw viewerStopError; }),
      reconcileConversation: vi.fn(async () => undefined),
    };
    let host!: FakeViewerHost;
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      viewerAdapter,
      createWebSocketHost: (options, callbacks) => {
        host = new FakeViewerHost(options, callbacks);
        return host;
      },
    });
    const engine = factory({
      key,
      sessionConfig,
      backendConfig: { ...backendConfig, supplementalViewer: { enabled: true } },
    });
    await engine.start();

    await expect(engine.stop()).rejects.toBe(viewerStopError);

    expect(viewerAdapter.stop).toHaveBeenCalledTimes(1);
    expect(host.stopped).toBe(true);
  });

  it('should_reconcile_the_registry_during_backend_prepare_before_any_session_starts', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    const creatingHomeId = '0123456789abcdef0123456789abcdef';
    const committedHomeId = 'fedcba9876543210fedcba9876543210';
    const creatingHome = join(persistenceRoot, 'homes', creatingHomeId);
    const committedHome = join(persistenceRoot, 'homes', committedHomeId);
    const staleRuntime = join(committedHome, 'agent-nexus-runtime', 'remote-stale');
    await Promise.all([
      chmod(sourceCodexHome, 0o700),
      mkdir(creatingHome, { recursive: true, mode: 0o700 }),
      mkdir(committedHome, { recursive: true, mode: 0o700 }),
      mkdir(staleRuntime, { recursive: true, mode: 0o700 }),
    ]);
    const creatingRecord = registryRecord(creatingHomeId, 'creating', null);
    const committedRecord = registryRecord(committedHomeId, 'committed', 'thr_committed');
    await Promise.all([
      writeFile(join(creatingHome, 'owner.json'), JSON.stringify(creatingRecord), { mode: 0o600 }),
      writeFile(join(committedHome, 'owner.json'), JSON.stringify(committedRecord), { mode: 0o600 }),
      writeFile(join(committedHome, 'rollout.jsonl'), 'durable rollout', { mode: 0o600 }),
      writeFile(join(staleRuntime, 'capability-token'), 'stale-secret', { mode: 0o600 }),
      writeFile(
        join(persistenceRoot, 'registry.json'),
        JSON.stringify({ version: 1, records: [creatingRecord, committedRecord] }),
        { mode: 0o600 },
      ),
    ]);
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
    });

    await factory.prepare();

    await expect(stat(creatingHome)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(committedHome)).resolves.toBeDefined();
    await expect(stat(join(committedHome, 'agent-nexus-runtime'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(committedHome, 'rollout.jsonl'), 'utf8')).resolves.toBe(
      'durable rollout',
    );
    const registry = JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8'));
    expect(registry.records).toEqual([committedRecord]);
  });

  it('should_commit_a_private_home_before_exposure_and_resume_the_exact_home', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const hosts: FakeHost[] = [];
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: { PATH: '/usr/bin', FEISHU_APP_SECRET: 'must-not-leak' },
      createHost: (options, callbacks) => {
        const host = new FakeHost(options, callbacks);
        hosts.push(host);
        return host;
      },
    });

    const first = factory({ key, sessionConfig, backendConfig });
    await expect(first.start()).resolves.toEqual({ threadId: 'thr_durable', pid: 9001 });
    const registry = JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8'));
    expect(registry.records[0]).toMatchObject({ status: 'committed', threadId: 'thr_durable' });
    const firstHome = hosts[0]!.options.codexHome;
    expect(hosts[0]!.options.env).toEqual({ PATH: '/usr/bin' });
    expect(await readFile(join(firstHome, 'auth.json'), 'utf8')).toContain('secret');
    expect((await stat(join(firstHome, 'config.toml'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(firstHome, 'config.toml'), 'utf8')).toContain(
      'check_for_update_on_startup = false',
    );
    await first.stop();
    await writeFile(
      join(firstHome, 'config.toml'),
      '# Legacy agent-nexus managed config.\n',
      { mode: 0o600 },
    );

    const resumed = factory({ key: { ...key, channelId: 'chat-rebound' }, sessionConfig, backendConfig });
    await expect(resumed.start('thr_durable')).resolves.toEqual({ threadId: 'thr_durable', pid: 9001 });
    expect(hosts[1]!.options.codexHome).toBe(firstHome);
    expect(hosts[1]!.requests).toContain('thread/resume');
    expect(await readFile(join(firstHome, 'config.toml'), 'utf8')).toContain(
      'check_for_update_on_startup = false',
    );
  });

  it('should_wait_for_an_async_host_listener_before_sending_initialize', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    let releaseHost!: () => void;
    const hostReady = new Promise<void>((resolve) => {
      releaseHost = resolve;
    });
    const hosts: FakeHost[] = [];
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      createHost: (options, callbacks) => {
        const host = new FakeHost(options, callbacks);
        host.start = vi.fn(() => hostReady);
        hosts.push(host);
        return host;
      },
    });

    const starting = factory({ key, sessionConfig, backendConfig }).start();
    await vi.waitFor(() => expect(hosts).toHaveLength(1));
    expect(hosts[0]!.requests).toEqual([]);

    releaseHost();
    await expect(starting).resolves.toEqual({ threadId: 'thr_durable', pid: 9001 });
    expect(hosts[0]!.requests[0]).toBe('initialize');
  });

  it('should_keep_one_sandboxed_process_live_across_completed_turns_and_route_its_output', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    let host!: FakeHost;
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      createHost: (options, callbacks) => {
        host = new FakeHost(options, callbacks);
        return host;
      },
    });
    const engine = factory({ key, sessionConfig, backendConfig: {
      ...backendConfig,
      sandbox: 'workspace-write',
      addDirs: ['/extra'],
    } });
    await engine.start();

    const processStatus = await engine.startProcess({ argv: ['/usr/bin/tool', '--serve'] });
    const exec = host.requestDetails.find((request) => request.method === 'command/exec')!;
    expect(exec).toMatchObject({
      params: {
        command: ['/usr/bin/tool', '--serve'],
        cwd: '/workspace',
        env: { CODEX_HOME: null },
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/workspace', '/extra'],
          networkAccess: false,
        },
      },
      options: { timeoutMs: null },
    });
    const processId = exec.params['processId'] as string;
    host.callbacks.onNotification?.({
      method: 'command/exec/outputDelta',
      params: {
        processId,
        stream: 'stdout',
        deltaBase64: Buffer.from('before-turn\n').toString('base64'),
        capReached: false,
      },
    });
    const beforeTurnCursor = engine.processStatus(processStatus.handle).nextCursor;

    const turn = engine.runTurn('first', 'message-process-turn-1');
    await vi.waitFor(() => expect(host.requests.filter((method) => method === 'turn/start')).toHaveLength(1));
    host.callbacks.onNotification?.({
      method: 'item/started',
      params: {
        threadId: 'thr_durable',
        turnId: 'turn_1',
        item: { id: 'item_process_turn_1', type: 'agentMessage' },
      },
    });
    host.callbacks.onNotification?.({
      method: 'item/completed',
      params: {
        threadId: 'thr_durable',
        turnId: 'turn_1',
        item: {
          id: 'item_process_turn_1',
          type: 'agentMessage',
          text: 'turn complete',
          phase: 'final_answer',
        },
      },
    });
    host.callbacks.onNotification?.({
      method: 'turn/completed',
      params: {
        threadId: 'thr_durable',
        turn: { id: 'turn_1', status: 'completed', items: [], error: null },
      },
    });
    await expect(turn).resolves.toMatchObject({ status: 'completed', text: 'turn complete' });

    host.callbacks.onNotification?.({
      method: 'command/exec/outputDelta',
      params: {
        processId,
        stream: 'stderr',
        deltaBase64: Buffer.from('after-turn\n').toString('base64'),
        capReached: false,
      },
    });
    const page = engine.readProcessOutput({
      handle: processStatus.handle,
      cursor: beforeTurnCursor,
    });
    expect(Buffer.concat(page.chunks.map((chunk) =>
      Buffer.from(chunk.dataBase64, 'base64'))).toString()).toBe('after-turn\n');

    await expect(engine.writeProcessStdin({
      handle: processStatus.handle,
      dataBase64: Buffer.from('PING\n').toString('base64'),
    })).resolves.toMatchObject({ acceptedBytes: 5 });
    expect(engine.processStatus(processStatus.handle).state).toBe('running');
    await expect(engine.terminateProcess(processStatus.handle)).resolves.toMatchObject({
      status: { state: 'exited', exitCode: 137 },
    });
    await engine.stop();
  });

  it('should_deliver_the_process_handle_even_when_registry_touch_maintenance_fails', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const registry = await ConversationRegistry.open(persistenceRoot);
    const maintenance = vi.fn();
    let host!: FakeHost;
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      openRegistry: async () => registry,
      onMaintenanceError: maintenance,
      createHost: (options, callbacks) => {
        host = new FakeHost(options, callbacks);
        return host;
      },
    });
    const engine = factory({ key, sessionConfig, backendConfig });
    await engine.start();
    const touchFailure = new Error('registry touch unavailable');
    vi.spyOn(registry, 'touch').mockRejectedValueOnce(touchFailure);

    const started = await engine.startProcess({ argv: ['/usr/bin/tool'] });

    expect(engine.processStatus(started.handle).state).toBe('running');
    await vi.waitFor(() => expect(maintenance).toHaveBeenCalledWith(touchFailure));
    const exec = host.requestDetails.find((request) => request.method === 'command/exec');
    expect(exec).toBeDefined();
    await engine.terminateProcess(started.handle);
    await engine.stop();
  });

  it('should_not_apply_a_delayed_interactive_request_effect_to_the_next_turn', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    let host!: FakeHost;
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      createHost: (options, callbacks) => {
        host = new FakeHost(options, callbacks);
        return host;
      },
    });
    const engine = factory({ key, sessionConfig, backendConfig });
    await engine.start();
    let releaseResponse!: () => void;
    const responsePending = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const respondError = vi.spyOn(host, 'respondError').mockImplementation(
      async () => responsePending,
    );

    const first = engine.runTurn('first', 'message-1');
    await vi.waitFor(() => expect(host.requests.filter((method) => method === 'turn/start')).toHaveLength(1));
    host.callbacks.onNotification?.({
      method: 'item/started',
      params: {
        threadId: 'thr_durable',
        turnId: 'turn_1',
        item: { id: 'item_1', type: 'commandExecution' },
      },
    });
    host.callbacks.onServerRequest?.({
      id: 'request-1',
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thr_durable', turnId: 'turn_1', itemId: 'item_1' },
    });
    await vi.waitFor(() => expect(respondError).toHaveBeenCalledTimes(1));
    host.callbacks.onNotification?.({
      method: 'turn/completed',
      params: {
        threadId: 'thr_durable',
        turn: { id: 'turn_1', status: 'failed', items: [], error: null },
      },
    });
    await expect(first).resolves.toMatchObject({ status: 'failed' });

    const second = engine.runTurn('second', 'message-2');
    await vi.waitFor(() => expect(host.requests.filter((method) => method === 'turn/start')).toHaveLength(2));
    releaseResponse();
    await responsePending;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(host.requests.filter((method) => method === 'turn/interrupt')).toEqual([]);
    expect(engine.status()).toBe('Busy');
    host.callbacks.onNotification?.({
      method: 'turn/completed',
      params: {
        threadId: 'thr_durable',
        turn: { id: 'turn_2', status: 'failed', items: [], error: null },
      },
    });
    await expect(second).resolves.toMatchObject({ status: 'failed' });
    await engine.stop();
  });

  it('should_propagate_an_idle_host_fatal_to_runtime_cleanup_without_polling', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    let host!: FakeHost;
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      createHost: (options, callbacks) => {
        host = new FakeHost(options, callbacks);
        return host;
      },
    });
    const runtime = createCodexAppServerRuntime(backendConfig, { createEngine: factory });
    const session = runtime.startSession(key, sessionConfig);
    const events: AgentEvent[] = [];
    runtime.onEvent(session, (event) => events.push(event));
    await vi.waitFor(() => expect(session.state).toBe('Idle'));

    host.callbacks.onFatal?.(new ProcessHostError('app-server process exited'));

    await vi.waitFor(() => expect(host.stopped).toBe(true));
    expect(session.state).toBe('Errored');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({ code: 'codex_app_server_host_fatal' }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'session_stopped', payload: { reason: 'error' } }),
    );
  });

  it('should_abort_before_spawn_when_stop_wins_the_registry_prepare_race', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const registry = await ConversationRegistry.open(persistenceRoot);
    let releaseRegistry!: (value: ConversationRegistry) => void;
    const registryReady = new Promise<ConversationRegistry>((resolve) => {
      releaseRegistry = resolve;
    });
    const createHost = vi.fn((options, callbacks) => new FakeHost(options, callbacks));
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      openRegistry: () => registryReady,
      createHost,
    });
    const engine = factory({ key, sessionConfig, backendConfig });

    const starting = engine.start();
    const stopping = engine.stop();
    releaseRegistry(registry);

    await expect(stopping).resolves.toBeUndefined();
    await expect(starting).rejects.toThrow(/stopped/);
    expect(createHost).not.toHaveBeenCalled();
  });

  it('should_stop_an_async_host_start_and_remove_the_provisional_home', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    let rejectHostStart!: (error: Error) => void;
    const hosts: FakeHost[] = [];
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      createHost: (options, callbacks) => {
        const host = new FakeHost(options, callbacks);
        host.start = vi.fn(
          () => new Promise<void>((_resolve, reject) => {
            rejectHostStart = reject;
          }),
        );
        host.stop = vi.fn(async () => {
          host.stopped = true;
          rejectHostStart(new Error('host stopped during startup'));
        });
        hosts.push(host);
        return host;
      },
    });
    const engine = factory({ key, sessionConfig, backendConfig });

    const starting = engine.start();
    await vi.waitFor(() => expect(hosts).toHaveLength(1));
    await engine.stop();

    await expect(starting).rejects.toThrow(/stopped/);
    expect(hosts[0]!.requests).toEqual([]);
    const registry = JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8'));
    expect(registry.records).toEqual([]);
    expect(await readdir(join(persistenceRoot, 'homes'))).toEqual([]);
  });

  it('should_propagate_provisional_cleanup_failure_through_a_concurrent_stop', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const cleanupError = Object.assign(new Error('provisional home cleanup failed'), {
      code: 'EBUSY',
    });
    const registry = await ConversationRegistry.open(persistenceRoot, {
      removePath: async (path, options) => {
        if (path.startsWith(join(persistenceRoot, 'homes'))) throw cleanupError;
        await rm(path, options);
      },
    });
    let rejectHostStart!: (error: Error) => void;
    let host!: FakeHost;
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      openRegistry: async () => registry,
      createHost: (options, callbacks) => {
        host = new FakeHost(options, callbacks);
        host.start = () => new Promise<void>((_resolve, reject) => {
          rejectHostStart = reject;
        });
        host.stop = vi.fn(async () => {
          host.stopped = true;
          rejectHostStart(new Error('host stopped during startup'));
        });
        return host;
      },
    });
    const engine = factory({ key, sessionConfig, backendConfig });

    const starting = engine.start();
    await vi.waitFor(() => expect(host).toBeDefined());
    const stopping = engine.stop();

    await expect(starting).rejects.toBeInstanceOf(AggregateError);
    await expect(stopping).rejects.toBe(cleanupError);
  });

  it('should_reject_a_second_resume_before_spawning_on_the_same_committed_home', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const hosts: FakeHost[] = [];
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      createHost: (options, callbacks) => {
        const host = new FakeHost(options, callbacks);
        hosts.push(host);
        return host;
      },
    });
    const original = factory({ key, sessionConfig, backendConfig });
    await original.start();
    await original.stop();
    const hostCountBeforeResume = hosts.length;

    const attempts = await Promise.allSettled([
      factory({ key, sessionConfig, backendConfig }).start('thr_durable'),
      factory({ key: { ...key, channelId: 'chat-2' }, sessionConfig, backendConfig })
        .start('thr_durable'),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(hosts).toHaveLength(hostCountBeforeResume + 1);
  });

  it('should_delete_the_provisional_home_when_thread_start_fails', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      createHost: (options, callbacks) => {
        const host = new FakeHost(options, callbacks);
        host.request = vi.fn(async (method: string) => {
          if (method === 'initialize') {
            return {
              codexHome: options.codexHome,
              userAgent: 'agent-nexus/0.146.0 (test)',
              platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
              platformOs: process.platform === 'darwin' ? 'macos' : process.platform,
            };
          }
          throw new Error('thread start failed');
        });
        return host;
      },
    });

    await expect(factory({ key, sessionConfig, backendConfig }).start()).rejects.toThrow(
      'thread start failed',
    );
    const registry = JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8'));
    expect(registry.records).toEqual([]);
    expect(await readdir(join(persistenceRoot, 'homes'))).toEqual([]);
  });

  it('should_preserve_a_rejected_startup_rollback_barrier_through_the_runtime', async () => {
    const sourceCodexHome = await privateDirectory('agent-nexus-codex-source-');
    const persistenceRoot = await privateDirectory('agent-nexus-codex-persistence-');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    const rollbackError = new Error('host rollback exit not confirmed');
    let host!: FakeHost;
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'codex-dev',
      clientVersion: '0.1.0',
      environment: {},
      createHost: (options, callbacks) => {
        host = new FakeHost(options, callbacks);
        host.request = vi.fn(async (method: string) => {
          if (method === 'initialize') throw new Error('initialize failed');
          return FakeHost.prototype.request.call(host, method, {});
        });
        host.stop = vi.fn(async () => {
          throw rollbackError;
        });
        return host;
      },
    });
    const runtime = createCodexAppServerRuntime(backendConfig, {
      createEngine: factory,
    });
    const session = runtime.startSession(key, sessionConfig);
    const events: AgentEvent[] = [];
    runtime.onEvent(session, (event) => events.push(event));

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'error')).toBe(true);
    });
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'session_stopped')).toBe(false);

    await expect(runtime.stopSession(session)).rejects.toBe(rollbackError);
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'session_stopped')).toBe(false);
    const registry = JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8'));
    expect(registry.records).toEqual([
      expect.objectContaining({ status: 'creating', threadId: null }),
    ]);
    expect(await readdir(join(persistenceRoot, 'homes'))).toHaveLength(1);
  });
});

function registryRecord(
  homeId: string,
  status: 'creating' | 'committed',
  threadId: string | null,
) {
  return {
    backend: 'codex-app-server',
    agentName: 'codex-dev',
    homeId,
    status,
    threadId,
    createdAt: 100,
    lastUsedAt: 100,
    bindingAudits: [{ sessionKey: '["p","lark","c","u"]', at: 100 }],
  };
}
