import type { CodexAppServerSandbox } from './config.js';
import type { RpcRequestOptions } from './rpc-transport.js';
import {
  isServerNotificationMethod0_146,
  SERVER_NOTIFICATION_OWNERSHIP_0_146,
  type ServerNotificationMethod0_146,
} from './protocol-contract-0-146.js';

export interface AppServerRpcPort {
  request(method: string, params: unknown, options?: RpcRequestOptions): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
}

export type { RpcRequestOptions } from './rpc-transport.js';

export interface AppServerControllerOptions {
  clientVersion: string;
  expectedCodexHome: string;
  workingDir: string;
  sandbox: CodexAppServerSandbox;
  addDirs: string[];
}

export interface AppServerControllerCallbacks {
  onFinal?: (text: string) => void;
  onStatus?: (state: ControllerState) => void;
  onFatal?: (error: AppServerControllerError) => void;
}

export type ControllerState = 'Spawning' | 'Idle' | 'Busy' | 'Errored' | 'Stopped';
export type TurnOutcomeStatus = 'completed' | 'interrupted' | 'failed';
export interface TurnOutcome {
  status: TurnOutcomeStatus;
  text: string | null;
}

interface ActiveTurn {
  id: string;
  itemIds: Set<string>;
  finalCandidates: Array<{ text: string; phase: unknown }>;
  resolve: (outcome: TurnOutcome) => void;
  reject: (error: Error) => void;
  terminal: boolean;
  interruptRequested: boolean;
  startedObserved: boolean;
}

export class AppServerControllerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppServerControllerError';
  }
}

export class AppServerForeignTurnError extends AppServerControllerError {
  constructor(message: string) {
    super(message);
    this.name = 'AppServerForeignTurnError';
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppServerControllerError(`${name} 必须是 object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppServerControllerError(`${name} 必须是非空字符串`);
  }
  return value;
}

export class AppServerController {
  private state: ControllerState = 'Spawning';
  private threadId: string | null = null;
  private readonly ownedTurnIds = new Set<string>();
  private active: ActiveTurn | null = null;
  private fatalError: AppServerControllerError | null = null;
  private turnStartPending = false;
  private pendingStartedTurnId: string | null = null;

  constructor(
    private readonly port: AppServerRpcPort,
    private readonly options: AppServerControllerOptions,
    private readonly callbacks: AppServerControllerCallbacks = {},
  ) {}

  status(): ControllerState {
    return this.state;
  }

  threadIdentity(): { threadId: string } | null {
    return this.threadId ? { threadId: this.threadId } : null;
  }

  activeIdentity(): { threadId: string; turnId: string; itemIds: string[] } | null {
    if (!this.threadId || !this.active || this.active.terminal) return null;
    return {
      threadId: this.threadId,
      turnId: this.active.id,
      itemIds: [...this.active.itemIds],
    };
  }

  fail(message: string): void {
    if (this.fatalError || this.state === 'Stopped') return;
    try {
      this.throwFatal(message);
    } catch (error) {
      if (error !== this.fatalError) throw error;
    }
  }

  stop(): void {
    if (this.state === 'Stopped') return;
    const active = this.active;
    this.active = null;
    this.turnStartPending = false;
    this.pendingStartedTurnId = null;
    this.state = 'Stopped';
    this.callbacks.onStatus?.('Stopped');
    if (active && !active.terminal) {
      active.terminal = true;
      active.resolve({ status: 'interrupted', text: null });
    }
  }

  async initialize(resumeThreadId?: string): Promise<string> {
    this.assertUsable();
    if (this.threadId !== null || this.state !== 'Spawning') {
      throw new AppServerControllerError('controller 已初始化');
    }
    try {
      const initialized = object(
        await this.port.request('initialize', {
          clientInfo: {
            name: 'agent-nexus',
            title: 'agent-nexus',
            version: this.options.clientVersion,
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            optOutNotificationMethods: [],
          },
        }),
        'initialize response',
      );
      if (initialized['codexHome'] !== this.options.expectedCodexHome) {
        throw new AppServerControllerError('initialize codexHome 与注入路径不匹配');
      }
      const userAgent = nonEmptyString(initialized['userAgent'], 'initialize.userAgent');
      if (!/^agent-nexus\/0\.146\.0(?:$|[ (])/.test(userAgent)) {
        throw new AppServerControllerError('initialize version evidence 不是 0.146.0');
      }
      const expectedPlatformOs = process.platform === 'darwin'
        ? 'macos'
        : process.platform === 'linux'
          ? 'linux'
          : null;
      if (
        expectedPlatformOs === null ||
        initialized['platformFamily'] !== 'unix' ||
        initialized['platformOs'] !== expectedPlatformOs
      ) {
        throw new AppServerControllerError('initialize platform evidence 与当前 runtime 不匹配');
      }
      await this.port.notify('initialized', {});

      const common = {
        cwd: this.options.workingDir,
        approvalPolicy: 'never',
        sandbox: this.options.sandbox,
        config:
          this.options.sandbox === 'workspace-write' && this.options.addDirs.length > 0
            ? { sandbox_workspace_write: { writable_roots: [...this.options.addDirs] } }
            : {},
      };
      const response = object(
        await this.port.request(
          resumeThreadId ? 'thread/resume' : 'thread/start',
          resumeThreadId
            ? { threadId: resumeThreadId, ...common }
            : { ...common, ephemeral: false },
        ),
        'thread response',
      );
      const thread = object(response['thread'], 'thread response.thread');
      const id = nonEmptyString(thread['id'], 'thread.id');
      if (resumeThreadId && id !== resumeThreadId) {
        throw new AppServerControllerError('resumed thread id 不匹配');
      }
      if (thread['ephemeral'] !== false) {
        throw new AppServerControllerError('thread 必须 durable (ephemeral=false)');
      }
      if (thread['cwd'] !== this.options.workingDir) {
        throw new AppServerControllerError('thread cwd 与配置不匹配');
      }
      if (resumeThreadId) {
        const historicalTurns = thread['turns'];
        if (!Array.isArray(historicalTurns)) {
          throw new AppServerControllerError('resumed thread.turns 必须是 array');
        }
        for (const historicalTurn of historicalTurns) {
          const turn = object(historicalTurn, 'resumed thread.turns[]');
          this.ownedTurnIds.add(nonEmptyString(turn['id'], 'resumed thread.turns[].id'));
        }
      }
      this.threadId = id;
      this.setState('Idle');
      return id;
    } catch (error) {
      this.throwFatal(error instanceof Error ? error.message : String(error));
    }
  }

  async runTurn(text: string, clientUserMessageId: string): Promise<TurnOutcome> {
    this.assertUsable();
    if (this.state !== 'Idle' || this.active) {
      throw new AppServerControllerError('controller Busy: active turn 已存在');
    }
    if (!this.threadId) throw new AppServerControllerError('controller 未初始化');
    if (!text || text.includes('\u0000')) {
      throw new AppServerControllerError('turn text 非法');
    }

    try {
      this.turnStartPending = true;
      this.pendingStartedTurnId = null;
      const response = object(
        await this.port.request('turn/start', {
          threadId: this.threadId,
          clientUserMessageId,
          input: [{ type: 'text', text, text_elements: [] }],
        }),
        'turn/start response',
      );
      const turn = object(response['turn'], 'turn/start response.turn');
      const turnId = nonEmptyString(turn['id'], 'turn.id');
      if (turn['status'] !== 'inProgress') {
        return this.throwFatal('turn/start 初始状态不是 inProgress');
      }
      if (this.pendingStartedTurnId && this.pendingStartedTurnId !== turnId) {
        return this.throwForeignTurnFatal('turn/started ownership mismatch during dispatch');
      }
      this.ownedTurnIds.add(turnId);

      const terminal = new Promise<TurnOutcome>((resolve, reject) => {
        this.active = {
          id: turnId,
          itemIds: new Set(),
          finalCandidates: [],
          resolve,
          reject,
          terminal: false,
          interruptRequested: false,
          startedObserved: this.pendingStartedTurnId === turnId,
        };
      });
      this.turnStartPending = false;
      this.pendingStartedTurnId = null;
      this.setState('Busy');
      return terminal;
    } catch (error) {
      this.turnStartPending = false;
      this.pendingStartedTurnId = null;
      if (error instanceof AppServerControllerError && this.fatalError === error) throw error;
      this.throwFatal(error instanceof Error ? error.message : String(error));
    }
  }

  async interrupt(): Promise<boolean> {
    this.assertUsable();
    if (!this.active || !this.threadId || this.active.terminal) return false;
    if (this.active.interruptRequested) return true;
    this.active.interruptRequested = true;
    await this.port.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.active.id,
    });
    return true;
  }

  handleInitializationNotification(frame: Record<string, unknown>): void {
    this.handleNotification(frame);
  }

  handleNotification(frame: Record<string, unknown>): void {
    this.assertUsable();
    try {
      const method = nonEmptyString(frame['method'], 'notification.method');
      const params = object(frame['params'], 'notification.params');
      if (method === 'thread/status/changed') {
        this.assertThread(params['threadId']);
        const status = object(params['status'], 'thread status');
        if (status['type'] === 'active') this.setState('Busy');
        else if (status['type'] === 'idle') this.setState(this.active ? 'Busy' : 'Idle');
        else this.throwFatal(`未知 thread status: ${String(status['type'])}`);
        return;
      }
      if (method === 'turn/started') {
        if (!this.threadId || params['threadId'] !== this.threadId) {
          this.throwForeignTurnFatal('turn/started thread ownership mismatch');
        }
        const turn = object(params['turn'], 'turn/started.turn');
        const id = nonEmptyString(turn['id'], 'turn.id');
        if (turn['status'] !== 'inProgress') {
          this.throwFatal('turn/started 初始状态不是 inProgress');
        }
        if (this.active) {
          if (this.active.id !== id) {
            this.throwForeignTurnFatal(`turn/started ownership mismatch: ${id}`);
          }
          if (this.active.terminal || this.active.startedObserved) {
            this.throwFatal(`turn/started duplicate mismatch: ${id}`);
          }
          this.active.startedObserved = true;
          return;
        }
        if (this.turnStartPending && this.pendingStartedTurnId === null) {
          this.pendingStartedTurnId = id;
          return;
        }
        this.throwForeignTurnFatal(`unsupported foreign turn/started ownership: ${id}`);
      }
      if (method === 'item/completed') {
        this.assertActiveOwnership(params);
        const item = object(params['item'], 'item/completed.item');
        const itemId = nonEmptyString(item['id'], 'item/completed.item.id');
        if (!this.active!.itemIds.has(itemId)) {
          this.throwFatal('item/completed item ownership mismatch');
        }
        if (item['type'] === 'agentMessage') {
          const text = nonEmptyString(item['text'], 'agentMessage.text');
          this.active!.finalCandidates.push({ text, phase: item['phase'] });
        }
        return;
      }
      if (method === 'item/started') {
        this.assertActiveOwnership(params);
        const item = object(params['item'], 'item/started.item');
        const itemId = nonEmptyString(item['id'], 'item/started.item.id');
        if (this.active!.itemIds.has(itemId)) {
          this.throwFatal('item/started duplicate item id');
        }
        this.active!.itemIds.add(itemId);
        return;
      }
      if (method === 'item/agentMessage/delta') {
        this.assertActiveOwnership(params);
        const itemId = nonEmptyString(params['itemId'], 'item/agentMessage/delta.itemId');
        if (!this.active!.itemIds.has(itemId)) {
          this.throwFatal('item/agentMessage/delta item ownership mismatch');
        }
        if (typeof params['delta'] !== 'string') {
          this.throwFatal('item/agentMessage/delta.delta 必须是字符串');
        }
        // 首版只保留 final 文本；delta 仍须先完成 ownership 与 schema 校验。
        return;
      }
      if (method === 'turn/completed') {
        this.assertThread(params['threadId']);
        const turn = object(params['turn'], 'turn/completed.turn');
        const id = nonEmptyString(turn['id'], 'turn.id');
        if (!this.active || this.active.id !== id || this.active.terminal) {
          this.throwFatal(`turn terminal ownership/duplicate mismatch: ${id}`);
        }
        const status = turn['status'];
        if (status !== 'completed' && status !== 'interrupted' && status !== 'failed') {
          this.throwFatal(`未知 turn terminal status: ${String(status)}`);
        }
        const active = this.active;
        active.terminal = true;
        const final = this.selectFinal(active);
        if (status === 'completed' && final === null) {
          this.throwFatal('completed turn 缺少 final agentMessage');
        }
        this.active = null;
        this.setState('Idle');
        if (final !== null) this.callbacks.onFinal?.(final);
        active.resolve({ status, text: final });
        return;
      }
      if (
        method === 'command/exec/outputDelta' ||
        method === 'process/outputDelta' ||
        method === 'process/exited'
      ) {
        this.throwFatal('unowned or disabled process notification');
      }
      if (!isServerNotificationMethod0_146(method)) {
        this.throwFatal('unsupported notification outside 0.146.0 snapshot');
      }
      this.assertIgnoredNotificationOwnership(method, params);
      // Known stable telemetry/tool notifications not promoted by the first release are ignored.
    } catch (error) {
      if (error instanceof AppServerControllerError && this.fatalError === error) throw error;
      this.throwFatal(error instanceof Error ? error.message : String(error));
    }
  }

  private selectFinal(active: ActiveTurn): string | null {
    const explicit = active.finalCandidates.filter((candidate) => candidate.phase === 'final_answer');
    const selected = explicit.at(-1) ?? active.finalCandidates.at(-1);
    return selected?.text ?? null;
  }

  private assertActiveOwnership(
    params: Record<string, unknown>,
    notificationMethod = 'notification',
  ): void {
    this.assertThread(params['threadId']);
    if (!this.active || params['turnId'] !== this.active.id) {
      this.throwFatal(`${notificationMethod} turn ownership mismatch`);
    }
  }

  private assertIgnoredNotificationOwnership(
    method: ServerNotificationMethod0_146,
    params: Record<string, unknown>,
  ): void {
    if (method === 'thread/tokenUsage/updated') {
      this.assertThread(params['threadId']);
      const turnId = nonEmptyString(params['turnId'], `${method}.turnId`);
      if (!this.ownedTurnIds.has(turnId)) {
        this.throwFatal(`${method} turn ownership mismatch`);
      }
      return;
    }
    const scope = SERVER_NOTIFICATION_OWNERSHIP_0_146[method];
    if (scope === 'connection') return;
    if (scope === 'thread') {
      this.assertThread(params['threadId']);
      return;
    }
    if (scope === 'optional-thread') {
      if (params['threadId'] !== undefined && params['threadId'] !== null) {
        this.assertThread(params['threadId']);
      }
      return;
    }
    if (scope === 'turn') {
      this.assertActiveOwnership(params, method);
      return;
    }
    if (scope === 'optional-turn') {
      this.assertThread(params['threadId']);
      if (params['turnId'] !== undefined && params['turnId'] !== null) {
        this.assertActiveOwnership(params, method);
      }
      return;
    }
    if (scope === 'item') {
      this.assertActiveOwnership(params, method);
      const itemId = nonEmptyString(params['itemId'], `${method}.itemId`);
      if (!this.active!.itemIds.has(itemId)) {
        this.throwFatal(`${method} item ownership mismatch`);
      }
      return;
    }
    if (scope === 'thread-object') {
      const thread = object(params['thread'], `${method}.thread`);
      this.assertThread(nonEmptyString(thread['id'], `${method}.thread.id`));
      return;
    }
    // Nested turn/item notifications have explicit handlers above. Reaching
    // this branch means a future refactor lost a required ownership check.
    this.throwFatal(`${method} requires an explicit ownership handler`);
  }

  private assertThread(value: unknown): void {
    if (!this.threadId || value !== this.threadId) {
      this.throwFatal('notification thread ownership mismatch');
    }
  }

  private setState(state: ControllerState): void {
    this.state = state;
    this.callbacks.onStatus?.(state);
  }

  private assertUsable(): void {
    if (this.fatalError) throw this.fatalError;
    if (this.state === 'Stopped') throw new AppServerControllerError('controller 已停止');
  }

  private throwFatal(message: string): never {
    return this.setFatal(new AppServerControllerError(message));
  }

  private throwForeignTurnFatal(message: string): never {
    return this.setFatal(new AppServerForeignTurnError(message));
  }

  private setFatal(error: AppServerControllerError): never {
    if (!this.fatalError) {
      this.fatalError = error;
      this.state = 'Errored';
      this.active?.reject(this.fatalError);
      this.active = null;
      this.turnStartPending = false;
      this.pendingStartedTurnId = null;
      this.callbacks.onFatal?.(this.fatalError);
    }
    throw this.fatalError;
  }
}
