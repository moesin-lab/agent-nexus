import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionConfig, SessionKey } from '@agent-nexus/protocol';
import { AuthSnapshotManager } from './auth-snapshot.js';
import { buildCodexChildEnvironment } from './child-environment.js';
import type { CodexAppServerConfig } from './config.js';
import { AppServerController, type ControllerState, type TurnOutcome } from './controller.js';
import {
  ConversationRegistry,
  encodeSessionKeyAudit,
  type ConversationOwner,
} from './conversation-registry.js';
import {
  AppServerProcessHost,
  type ProcessHostCallbacks,
  type ProcessHostOptions,
} from './process-host.js';
import {
  AuthenticatedWebSocketProcessHost,
  type RemoteViewerAdmission,
  type WebSocketProcessHostOptions,
} from './websocket-process-host.js';
import type {
  CodexRemoteViewerHandle,
  CodexRemoteViewerPort,
} from './remote-viewer.js';
import {
  CodexProcessController,
  type CodexProcessOutputPage,
  type CodexProcessStatus,
  type CodexProcessTerminateResult,
  type CodexProcessWriteResult,
} from './process-controller.js';
import type { RpcId, RpcRequestOptions } from './rpc-transport.js';
import { decideServerRequest, type ServerRequestEffect } from './server-request-policy.js';
import type { CodexAppServerSessionEngine } from './runtime.js';

export interface CodexAppServerHostPort {
  start(): void | Promise<void>;
  pid(): number | undefined;
  request(method: string, params: unknown, options?: RpcRequestOptions): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  respondResult(id: RpcId, result: unknown): Promise<void>;
  respondError(id: RpcId, code: number, message: string): Promise<void>;
  stop(): Promise<void>;
}

export interface CodexAppServerViewerHostPort extends CodexAppServerHostPort {
  viewerAdmission(): RemoteViewerAdmission;
}

export interface CodexAppServerViewerHostLifecycle {
  beforeAuthDispose(): Promise<void>;
}

export interface DefaultCodexAppServerEngineDependencies {
  sourceCodexHome: string;
  persistenceRoot: string;
  agentName: string;
  clientVersion: string;
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  createHost?: (
    options: ProcessHostOptions,
    callbacks: ProcessHostCallbacks,
  ) => CodexAppServerHostPort;
  createWebSocketHost?: (
    options: WebSocketProcessHostOptions,
    callbacks: ProcessHostCallbacks,
    lifecycle: CodexAppServerViewerHostLifecycle,
  ) => CodexAppServerViewerHostPort;
  viewerAdapter?: CodexRemoteViewerPort;
  openRegistry?: (persistenceRoot: string) => Promise<ConversationRegistry>;
  onMaintenanceError?: (error: Error) => void;
}

export interface CodexAppServerEngineInput {
  key: SessionKey;
  sessionConfig: SessionConfig;
  backendConfig: CodexAppServerConfig;
}

export type CodexAppServerEngineFactory = (
  input: CodexAppServerEngineInput,
) => CodexAppServerSessionEngine;

export type PreparedCodexAppServerEngineFactory = CodexAppServerEngineFactory & {
  prepare(): Promise<void>;
};

export function createDefaultCodexAppServerEngineFactory(
  dependencies: DefaultCodexAppServerEngineDependencies,
): PreparedCodexAppServerEngineFactory {
  // One registry instance serializes mutations for all sessions owned by this runtime factory.
  let registry: Promise<ConversationRegistry> | null = null;
  let maintenanceTimer: NodeJS.Timeout | null = null;
  const environment = buildCodexChildEnvironment(dependencies.environment);
  const prepareRegistry = (): Promise<ConversationRegistry> => {
    if (registry) return registry;
    const openRegistry = dependencies.openRegistry ?? ((persistenceRoot: string) =>
      ConversationRegistry.open(persistenceRoot, {
        ...(dependencies.viewerAdapter
          ? {
              reconcileRemoteViewer: (conversationHome, binding) =>
                dependencies.viewerAdapter!.reconcileConversation(
                  conversationHome,
                  binding,
                ),
            }
          : {}),
      }));
    registry = openRegistry(dependencies.persistenceRoot);
    return registry;
  };
  return Object.assign(
    (input: CodexAppServerEngineInput): CodexAppServerSessionEngine => {
      const sharedRegistry = prepareRegistry();
      const retention = input.backendConfig.conversationRetentionMs;
      if (retention !== null && maintenanceTimer === null) {
        const intervalMs = Math.max(60_000, Math.min(Math.floor(retention / 4), 86_400_000));
        maintenanceTimer = setInterval(() => {
          void sharedRegistry
            .then((value) => value.collectExpired(retention))
            .catch((error) => dependencies.onMaintenanceError?.(asError(error)));
        }, intervalMs);
        maintenanceTimer.unref?.();
      }
      return new DefaultCodexAppServerSessionEngine(
        input,
        dependencies,
        sharedRegistry,
        environment,
      );
    },
    {
      prepare: async (): Promise<void> => {
        await prepareRegistry();
      },
    },
  );
}

class DefaultCodexAppServerSessionEngine implements CodexAppServerSessionEngine {
  private host: CodexAppServerHostPort | null = null;
  private controller: AppServerController | null = null;
  private processController: CodexProcessController | null = null;
  private auth: AuthSnapshotManager | null = null;
  private registry: ConversationRegistry | null = null;
  private threadId: string | null = null;
  private releaseLive: (() => void) | null = null;
  private startPromise: Promise<{ threadId: string; pid?: number }> | null = null;
  private startupRollbackPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private hostStopPromise: Promise<void> | null = null;
  private viewerHandle: CodexRemoteViewerHandle | null = null;
  private viewerStartPromise: Promise<void> | null = null;
  private viewerStopPromise: Promise<void> | null = null;
  private readonly fatalHandlers = new Set<(error: Error) => void>();
  private fatalError: Error | null = null;
  private starting = false;
  private running = false;
  private stopped = false;

  constructor(
    private readonly input: CodexAppServerEngineInput,
    private readonly dependencies: DefaultCodexAppServerEngineDependencies,
    private readonly registryPromise: Promise<ConversationRegistry>,
    private readonly environment: Record<string, string>,
  ) {}

  start(resumeThreadId?: string): Promise<{ threadId: string; pid?: number }> {
    if (this.starting || this.host || this.stopped) {
      return Promise.reject(new Error('session engine 已启动或停止'));
    }
    this.starting = true;
    const starting = this.startInternal(resumeThreadId).finally(() => {
      this.starting = false;
      if (this.startPromise === starting) this.startPromise = null;
    });
    this.startPromise = starting;
    return starting;
  }

  private async startInternal(
    resumeThreadId?: string,
  ): Promise<{ threadId: string; pid?: number }> {
    const registry = await this.registryPromise;
    this.assertNotStopped();
    this.registry = registry;
    if (this.input.backendConfig.conversationRetentionMs !== null) {
      await registry.collectExpired(this.input.backendConfig.conversationRetentionMs);
      this.assertNotStopped();
    }
    const owner: ConversationOwner = {
      backend: 'codex-app-server',
      agentName: this.dependencies.agentName,
    };
    const audit = encodeSessionKeyAudit(this.input.key);
    let provisionalHomeId: string | null = null;
    let homePath = '';
    let homeId = '';
    try {
      if (resumeThreadId) {
        const resolved = await registry.resolve(resumeThreadId, owner);
        this.assertNotStopped();
        homeId = resolved.homeId;
        homePath = resolved.homePath;
        this.releaseLive = await registry.acquireLive(homeId);
        this.assertNotStopped();
      } else {
        const provisional = await registry.createProvisional(owner, audit);
        provisionalHomeId = provisional.homeId;
        homeId = provisional.homeId;
        homePath = provisional.homePath;
        this.assertNotStopped();
      }
      this.auth = new AuthSnapshotManager(this.dependencies.sourceCodexHome, homePath);
      await this.auth.prepare();
      this.assertNotStopped();
      await ensureManagedConfig(homePath);
      this.assertNotStopped();
      let controller: AppServerController | null = null;
      let initialized = false;
      const initializingNotifications: Record<string, unknown>[] = [];
      const callbacks: ProcessHostCallbacks = {
        onNotification: (frame) => {
          if (!initialized) {
            if (initializingNotifications.length >= 1024) {
              controller?.fail('app-server initialization notification buffer exceeded');
              return;
            }
            initializingNotifications.push(frame);
            return;
          }
          this.routeNotification(controller, frame);
        },
        onServerRequest: (frame) => void this.handleServerRequest(frame),
        onFatal: (error) => controller?.fail(error.message),
        onExit: () => {
          if (!this.stopped) controller?.fail('Codex app-server process exited');
        },
      };
      const options: ProcessHostOptions = {
        bin: this.input.backendConfig.bin,
        cwd: this.input.sessionConfig.workingDir,
        codexHome: homePath,
        env: this.environment,
        requestTimeoutMs: this.input.backendConfig.requestTimeoutMs,
        terminateGraceMs: this.input.backendConfig.terminateGraceMs,
      };
      const viewerEnabled =
        this.input.backendConfig.supplementalViewer.enabled &&
        this.dependencies.viewerAdapter !== undefined;
      this.host = viewerEnabled
        ? (this.dependencies.createWebSocketHost ?? defaultCreateWebSocketHost)(
            {
              ...options,
              startupTimeoutMs: this.input.backendConfig.requestTimeoutMs,
            },
            callbacks,
            { beforeAuthDispose: () => this.stopViewer() },
          )
        : (this.dependencies.createHost ?? defaultCreateHost)(options, callbacks);
      this.hostStopPromise = null;
      await this.host.start();
      this.assertNotStopped();
      controller = new AppServerController(
        this.host,
        {
          clientVersion: this.dependencies.clientVersion,
          expectedCodexHome: homePath,
          workingDir: this.input.sessionConfig.workingDir,
          sandbox: this.input.backendConfig.sandbox,
          addDirs: this.input.backendConfig.addDirs,
        },
        { onFatal: (error) => this.reportFatal(error) },
      );
      this.controller = controller;
      this.processController = new CodexProcessController(this.host, {
        workingDir: this.input.sessionConfig.workingDir,
        sandbox: this.input.backendConfig.sandbox,
        addDirs: this.input.backendConfig.addDirs,
        terminateGraceMs: this.input.backendConfig.terminateGraceMs,
        onFatal: (error) => controller?.fail(error.message),
      });
      const threadId = await controller.initialize(resumeThreadId);
      this.assertNotStopped();
      initialized = true;
      for (const frame of initializingNotifications) {
        if (frame['method'] === 'command/exec/outputDelta') {
          this.processController.handleNotification(frame);
        } else {
          controller.handleInitializationNotification(frame);
        }
      }
      if (provisionalHomeId) {
        await registry.commit(provisionalHomeId, threadId);
        provisionalHomeId = null;
        this.releaseLive = await registry.acquireLive(homeId);
      } else {
        await registry.recordBindingAudit(threadId, audit, Date.now());
      }
      this.assertNotStopped();
      if (controller.status() !== 'Idle') {
        throw this.fatalError ?? new Error('app-server controller failed during startup');
      }
      if (viewerEnabled) {
        await this.startViewer(
          this.host as CodexAppServerViewerHostPort,
          homeId,
          homePath,
          threadId,
        );
        this.assertNotStopped();
        if (controller.status() !== 'Idle') {
          throw this.fatalError ?? new Error('app-server controller failed during viewer startup');
        }
      }
      this.threadId = threadId;
      this.running = true;
      return { threadId, ...(this.host.pid() === undefined ? {} : { pid: this.host.pid() }) };
    } catch (error) {
      const failedHost = this.host;
      this.controller?.stop();
      this.stopped = true;
      const rollback = (async () => {
        let viewerError: unknown;
        try {
          await this.stopViewer();
        } catch (error) {
          viewerError = error;
        }
        let hostError: unknown;
        if (failedHost) {
          try {
            await this.stopHost(failedHost);
          } catch (error) {
            hostError = error;
          }
        }
        if (!hostError && this.host === failedHost) {
          this.processController?.confirmHostStopped();
          this.host = null;
          this.controller = null;
          this.processController = null;
        }
        if (viewerError && hostError) {
          throw new AggregateError(
            [viewerError, hostError],
            'remote viewer and app-server startup cleanup both failed',
          );
        }
        if (viewerError) throw viewerError;
        if (hostError) throw hostError;
        this.releaseLive?.();
        this.releaseLive = null;
        if (provisionalHomeId) await registry.discardProvisional(provisionalHomeId);
      })();
      this.startupRollbackPromise = rollback;
      if (!this.stopPromise) this.stopPromise = rollback;
      try {
        await rollback;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Codex app-server startup failed and rollback cleanup was not confirmed',
        );
      }
      throw error;
    }
  }

  async runTurn(text: string, clientUserMessageId: string): Promise<TurnOutcome> {
    const outcome = await this.requireController().runTurn(text, clientUserMessageId);
    if (!this.registry || !this.threadId) throw new Error('session registry identity 缺失');
    await this.registry.touch(this.threadId);
    return outcome;
  }

  interrupt(): Promise<boolean> {
    return this.requireController().interrupt();
  }

  async startProcess(input: { argv: string[] }): Promise<CodexProcessStatus> {
    const status = await this.requireProcessController().start(input);
    if (this.registry && this.threadId) {
      void this.registry
        .touch(this.threadId)
        .catch((error) => this.dependencies.onMaintenanceError?.(asError(error)));
    }
    return status;
  }

  processStatus(handle: string): CodexProcessStatus {
    return this.requireProcessController().status(handle);
  }

  readProcessOutput(input: { handle: string; cursor: number }): CodexProcessOutputPage {
    return this.requireProcessController().readOutput(input);
  }

  writeProcessStdin(input: {
    handle: string;
    dataBase64?: string;
    closeStdin?: boolean;
  }): Promise<CodexProcessWriteResult> {
    return this.requireProcessController().writeStdin(input);
  }

  terminateProcess(handle: string): Promise<CodexProcessTerminateResult> {
    return this.requireProcessController().terminate(handle);
  }

  onFatal(handler: (error: Error) => void): () => void {
    this.fatalHandlers.add(handler);
    return () => this.fatalHandlers.delete(handler);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    this.controller?.stop();
    const startup = this.startPromise;
    const initialHost = this.host;
    try {
      await this.processController?.beginStop();
    } catch (error) {
      this.dependencies.onMaintenanceError?.(asError(error));
    }
    let viewerError: unknown;
    try {
      await this.stopViewer();
    } catch (error) {
      viewerError = error;
    }
    let hostError: unknown;
    if (initialHost) {
      try {
        await this.stopHost(initialHost);
        this.processController?.confirmHostStopped();
      } catch (error) {
        hostError = error;
      }
    }
    await startup?.catch(() => undefined);
    try {
      await this.startupRollbackPromise;
    } catch (error) {
      if (error !== viewerError && error !== hostError) {
        if (hostError) {
          hostError = new AggregateError(
            [hostError, error],
            'app-server stop and startup rollback both failed',
          );
        } else {
          hostError = error;
        }
      }
    }
    if (this.host && this.host !== initialHost) {
      try {
        await this.stopHost(this.host);
        this.processController?.confirmHostStopped();
      } catch (error) {
        hostError ??= error;
      }
    }
    if (viewerError && hostError) {
      throw new AggregateError(
        [viewerError, hostError],
        'remote viewer and app-server cleanup both failed',
      );
    }
    if (viewerError) throw viewerError;
    if (hostError) throw hostError;
    this.host = null;
    this.controller = null;
    this.processController = null;
    this.releaseLive?.();
    this.releaseLive = null;
    this.running = false;
  }

  status(): ControllerState {
    return this.controller?.status() ?? (this.stopped ? 'Stopped' : 'Spawning');
  }

  private requireController(): AppServerController {
    if (!this.controller || this.stopped) throw new Error('session engine 未运行');
    return this.controller;
  }

  private requireProcessController(): CodexProcessController {
    if (!this.processController || !this.running || this.stopped) {
      throw new Error('session process owner 未运行');
    }
    return this.processController;
  }

  private routeNotification(
    controller: AppServerController | null,
    frame: Record<string, unknown>,
  ): void {
    if (frame['method'] === 'command/exec/outputDelta') {
      const owner = this.processController;
      if (!owner) {
        controller?.fail('unowned command/exec output notification');
        return;
      }
      owner.handleNotification(frame);
      return;
    }
    controller?.handleNotification(frame);
  }

  private assertNotStopped(): void {
    if (this.stopped) throw new Error('session engine stopped during startup');
  }

  private stopHost(host: CodexAppServerHostPort): Promise<void> {
    if (this.hostStopPromise) return this.hostStopPromise;
    this.hostStopPromise = Promise.resolve().then(() => host.stop());
    return this.hostStopPromise;
  }

  private startViewer(
    host: CodexAppServerViewerHostPort,
    homeId: string,
    homePath: string,
    threadId: string,
  ): Promise<void> {
    const starting = this.startViewerInternal(host, homeId, homePath, threadId);
    this.viewerStartPromise = starting;
    return starting.finally(() => {
      if (this.viewerStartPromise === starting) this.viewerStartPromise = null;
    });
  }

  private async startViewerInternal(
    host: CodexAppServerViewerHostPort,
    homeId: string,
    homePath: string,
    threadId: string,
  ): Promise<void> {
    const viewer = this.dependencies.viewerAdapter;
    if (!viewer) return;
    let result;
    try {
      const admission = host.viewerAdmission();
      result = await viewer.start({
        binding: {
          homeId,
          appServerIncarnationId: admission.appServerIncarnationId,
          threadId,
        },
        admission,
        bin: this.input.backendConfig.bin,
        cwd: this.input.sessionConfig.workingDir,
        codexHome: homePath,
        environment: this.environment,
      });
    } catch (error) {
      this.dependencies.onMaintenanceError?.(asError(error));
      return;
    }
    if (result.kind === 'unavailable') {
      this.dependencies.onMaintenanceError?.(result.error);
      return;
    }
    this.viewerHandle = result.handle;
    if (result.kind === 'ambiguous') {
      this.dependencies.onMaintenanceError?.(result.error);
    }
  }

  private stopViewer(): Promise<void> {
    if (this.viewerStopPromise) return this.viewerStopPromise;
    const stopping = Promise.resolve().then(async () => {
      await this.viewerStartPromise;
      const handle = this.viewerHandle;
      const viewer = this.dependencies.viewerAdapter;
      if (!handle || !viewer) return;
      await viewer.stop(handle);
      if (this.viewerHandle === handle) this.viewerHandle = null;
    });
    this.viewerStopPromise = stopping;
    return stopping;
  }

  private async handleServerRequest(frame: Record<string, unknown>): Promise<void> {
    const host = this.host;
    const controller = this.controller;
    if (!host) return;
    const id = frame['id'];
    const method = frame['method'];
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof method !== 'string') {
      await this.stopForProtocol('invalid server request envelope');
      return;
    }
    const requestIdentity = controller?.activeIdentity() ?? null;
    const decision = decideServerRequest(
      { id, method, params: frame['params'] },
      requestIdentity,
    );
    try {
      if (decision.response.kind === 'result') {
        await host.respondResult(id, decision.response.result);
      } else {
        await host.respondError(id, decision.response.code, decision.response.message);
      }
      await this.applyServerRequestEffect(
        decision.effect,
        requestIdentity,
      );
    } catch (error) {
      await this.stopForProtocol(error instanceof Error ? error.message : String(error));
    }
  }

  private async applyServerRequestEffect(
    effect: ServerRequestEffect,
    identity: { threadId: string; turnId: string } | null,
  ): Promise<void> {
    if (effect === 'wait-terminal') return;
    if (effect === 'interrupt') {
      const current = this.controller?.activeIdentity();
      if (
        !identity ||
        current?.threadId !== identity.threadId ||
        current.turnId !== identity.turnId
      ) {
        return;
      }
      await this.controller?.interrupt();
      setTimeout(() => {
        const currentIdentity = this.controller?.activeIdentity();
        if (
          currentIdentity?.threadId === identity.threadId &&
          currentIdentity.turnId === identity.turnId
        ) {
          void this.stopForProtocol('interactive request interrupt grace expired');
        }
      }, this.input.backendConfig.interruptGraceMs).unref?.();
      return;
    }
    if (effect === 'stop-auth') await this.auth?.markStale();
    await this.stopForProtocol(
      effect === 'stop-auth' ? 'Codex authentication became stale' : 'unsupported Codex server request',
    );
  }

  private async stopForProtocol(message: string): Promise<void> {
    this.controller?.fail(message);
    await this.stop().catch(() => undefined);
  }

  private reportFatal(error: Error): void {
    if (this.stopped || this.fatalError) return;
    this.fatalError = error;
    for (const handler of this.fatalHandlers) handler(error);
  }
}

const MANAGED_CONFIG = [
  '# Managed by agent-nexus; user Codex config is intentionally not inherited.',
  // A supplemental viewer has no operator available to dismiss startup UI.
  'check_for_update_on_startup = false',
  '',
].join('\n');

async function ensureManagedConfig(homePath: string): Promise<void> {
  const path = join(homePath, 'config.toml');
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(MANAGED_CONFIG);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('managed config.toml 必须是 private non-symlink regular file');
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && info.uid !== currentUid) {
    throw new Error('managed config.toml owner 不是当前 uid');
  }
  if (await readFile(path, 'utf8') === MANAGED_CONFIG) return;

  const temporaryPath = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(MANAGED_CONFIG);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function defaultCreateHost(
  options: ProcessHostOptions,
  callbacks: ProcessHostCallbacks,
): CodexAppServerHostPort {
  return new AppServerProcessHost(options, {}, callbacks);
}

function defaultCreateWebSocketHost(
  options: WebSocketProcessHostOptions,
  callbacks: ProcessHostCallbacks,
  lifecycle: CodexAppServerViewerHostLifecycle,
): CodexAppServerViewerHostPort {
  return new AuthenticatedWebSocketProcessHost(
    options,
    { beforeAuthDispose: lifecycle.beforeAuthDispose },
    callbacks,
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
