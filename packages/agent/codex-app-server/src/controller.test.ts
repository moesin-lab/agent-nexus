import { describe, expect, it, vi } from 'vitest';
import {
  AppServerController,
  AppServerControllerError,
  AppServerForeignTurnError,
  type AppServerRpcPort,
} from './controller.js';

const EXPECTED_PLATFORM_FAMILY = process.platform === 'win32' ? 'windows' : 'unix';
const EXPECTED_PLATFORM_OS = process.platform === 'darwin'
  ? 'macos'
  : process.platform;

class FakePort implements AppServerRpcPort {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  private turnNumber = 0;

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === 'initialize') {
      return {
        userAgent: 'agent-nexus/0.146.0 (test)',
        codexHome: '/private/runtime/home',
        platformFamily: EXPECTED_PLATFORM_FAMILY,
        platformOs: EXPECTED_PLATFORM_OS,
      };
    }
    if (method === 'thread/start') return { thread: thread('thr_1', false) };
    if (method === 'thread/resume') {
      return { thread: thread('thr_resume', false, [turn('turn_previous', 'completed')]) };
    }
    if (method === 'turn/start') {
      this.turnNumber += 1;
      return { turn: turn(`turn_${this.turnNumber}`, 'inProgress') };
    }
    if (method === 'turn/interrupt') return {};
    throw new Error(`unexpected method ${method}`);
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.notifications.push({ method, params });
  }
}

const thread = (id: string, ephemeral: boolean, turns: unknown[] = []) => ({
  id,
  ephemeral,
  cwd: '/workspace',
  status: { type: 'idle' },
  turns,
});

const turn = (id: string, status: string) => ({
  id,
  status,
  items: [],
  error: null,
});

const options = {
  clientVersion: '0.1.0',
  expectedCodexHome: '/private/runtime/home',
  workingDir: '/workspace',
  sandbox: 'workspace-write' as const,
  addDirs: ['/extra'],
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('AppServerController', () => {
  it('should_fail_closed_if_a_process_notification_bypasses_its_owner', async () => {
    const controller = new AppServerController(new FakePort(), options);
    await controller.initialize();

    expect(() => controller.handleNotification({
      method: 'command/exec/outputDelta',
      params: {
        processId: 'foreign',
        stream: 'stdout',
        deltaBase64: '',
        capReached: false,
      },
    })).toThrow(/process notification/);
    expect(controller.status()).toBe('Errored');
  });

  it('should_expose_only_initialized_thread_and_active_turn_identity', async () => {
    const port = new FakePort();
    const controller = new AppServerController(port, options);

    expect(controller.threadIdentity()).toBeNull();
    expect(controller.activeIdentity()).toBeNull();
    await controller.initialize();
    expect(controller.threadIdentity()).toEqual({ threadId: 'thr_1' });

    const turnWork = controller.runTurn('hello', 'client-message-1');
    await vi.waitFor(() => expect(port.requests.some((request) => request.method === 'turn/start')).toBe(true));
    await flush();
    expect(controller.activeIdentity()).toEqual({
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemIds: [],
    });

    controller.handleNotification({
      method: 'item/started',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { type: 'agentMessage', id: 'item_1' },
      },
    });
    controller.handleNotification({
      method: 'item/completed',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { type: 'agentMessage', id: 'item_1', text: 'answer', phase: 'final_answer' },
      },
    });
    controller.handleNotification({
      method: 'turn/completed',
      params: { threadId: 'thr_1', turn: turn('turn_1', 'completed') },
    });
    await turnWork;
    expect(controller.activeIdentity()).toBeNull();
  });
  it('should_settle_an_active_turn_when_stopped_by_the_host', async () => {
    const port = new FakePort();
    const controller = new AppServerController(port, options);
    await controller.initialize();
    const turnWork = controller.runTurn('hello', 'client-message-1');
    await flush();

    controller.stop();

    await expect(turnWork).resolves.toEqual({ status: 'interrupted', text: null });
    expect(controller.status()).toBe('Stopped');
    expect(controller.activeIdentity()).toBeNull();
  });
  it('should_initialize_and_start_a_durable_thread_with_fixed_security_params', async () => {
    const port = new FakePort();
    const controller = new AppServerController(port, options);

    await expect(controller.initialize()).resolves.toBe('thr_1');

    expect(port.requests[0]).toEqual({
      method: 'initialize',
      params: {
        clientInfo: { name: 'agent-nexus', title: 'agent-nexus', version: '0.1.0' },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      },
    });
    expect(port.notifications).toEqual([{ method: 'initialized', params: {} }]);
    expect(port.requests[1]).toEqual({
      method: 'thread/start',
      params: {
        cwd: '/workspace',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        config: { sandbox_workspace_write: { writable_roots: ['/extra'] } },
        ephemeral: false,
      },
    });
    expect(controller.status()).toBe('Idle');
  });

  it.each([
    ['userAgent', 'agent-nexus/0.147.0 (test)'],
    ['platformFamily', 'unexpected-family'],
    ['platformOs', 'unexpected-os'],
  ])('should_fail_closed_when_initialize_%s_does_not_match_the_pinned_runtime', async (field, value) => {
    const port = new FakePort();
    vi.spyOn(port, 'request').mockImplementation(async (method, params) => {
      const response = await FakePort.prototype.request.call(port, method, params);
      return method === 'initialize'
        ? { ...(response as Record<string, unknown>), [field]: value }
        : response;
    });
    const controller = new AppServerController(port, options);

    await expect(controller.initialize()).rejects.toThrow(/initialize|version|platform/i);
    expect(controller.status()).toBe('Errored');
  });

  it('should_resume_only_the_requested_thread', async () => {
    const port = new FakePort();
    const controller = new AppServerController(port, options);

    await expect(controller.initialize('thr_resume')).resolves.toBe('thr_resume');
    expect(port.requests[1]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'thr_resume', cwd: '/workspace', approvalPolicy: 'never' },
    });
  });

  it('should_accept_delayed_usage_only_for_proven_same_thread_turns', async () => {
    const controller = new AppServerController(new FakePort(), options);
    await controller.initialize('thr_resume');
    const historicalUsage = {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thr_resume',
        turnId: 'turn_previous',
        tokenUsage: { last: {}, total: {} },
      },
    };

    expect(() => controller.handleInitializationNotification(historicalUsage)).not.toThrow();

    const unknownTurnController = new AppServerController(new FakePort(), options);
    await unknownTurnController.initialize('thr_resume');
    expect(() => unknownTurnController.handleInitializationNotification({
      ...historicalUsage,
      params: { ...historicalUsage.params, turnId: 'turn_foreign' },
    })).toThrow(/turn ownership/i);

    const foreignThreadController = new AppServerController(new FakePort(), options);
    await foreignThreadController.initialize('thr_resume');
    expect(() => foreignThreadController.handleInitializationNotification({
      ...historicalUsage,
      params: { ...historicalUsage.params, threadId: 'thr_foreign' },
    })).toThrow(/thread ownership/i);

    const liveController = new AppServerController(new FakePort(), options);
    await liveController.initialize('thr_resume');
    expect(() => liveController.handleNotification(historicalUsage)).not.toThrow();
    expect(() => liveController.handleNotification({
      ...historicalUsage,
      params: { ...historicalUsage.params, turnId: 'turn_unknown' },
    })).toThrow(/turn ownership/i);
  });

  it('should_run_two_turns_serially_and_emit_one_final_per_turn', async () => {
    const port = new FakePort();
    const finals: string[] = [];
    const controller = new AppServerController(port, options, {
      onFinal: (text) => finals.push(text),
    });
    await controller.initialize();

    const first = controller.runTurn('first', 'message-1');
    await flush();
    controller.handleNotification({
      method: 'item/started',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { type: 'agentMessage', id: 'item_1' },
      },
    });
    controller.handleNotification({
      method: 'item/completed',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { type: 'agentMessage', id: 'item_1', text: 'FIRST', phase: 'final_answer' },
      },
    });
    controller.handleNotification({
      method: 'turn/completed',
      params: { threadId: 'thr_1', turn: turn('turn_1', 'completed') },
    });
    await expect(first).resolves.toEqual({ status: 'completed', text: 'FIRST' });

    const second = controller.runTurn('second', 'message-2');
    await flush();
    controller.handleNotification({
      method: 'item/started',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_2',
        item: { type: 'agentMessage', id: 'item_2' },
      },
    });
    controller.handleNotification({
      method: 'item/completed',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_2',
        item: { type: 'agentMessage', id: 'item_2', text: 'SECOND', phase: null },
      },
    });
    controller.handleNotification({
      method: 'turn/completed',
      params: { threadId: 'thr_1', turn: turn('turn_2', 'completed') },
    });
    await expect(second).resolves.toEqual({ status: 'completed', text: 'SECOND' });
    expect(finals).toEqual(['FIRST', 'SECOND']);
  });

  it('should_reject_concurrent_turn_and_preserve_the_active_turn', async () => {
    const controller = new AppServerController(new FakePort(), options);
    await controller.initialize();

    const active = controller.runTurn('first', 'message-1');
    await flush();
    await expect(controller.runTurn('second', 'message-2')).rejects.toThrow(/Busy|active/);
    controller.handleNotification({
      method: 'turn/completed',
      params: { threadId: 'thr_1', turn: turn('turn_1', 'failed') },
    });
    await expect(active).resolves.toMatchObject({ status: 'failed' });
  });

  it('should_fail_closed_when_turn_start_dispatch_or_response_is_ambiguous', async () => {
    const port = new FakePort();
    const fatal = vi.fn();
    const controller = new AppServerController(port, options, { onFatal: fatal });
    await controller.initialize();
    const dispatchError = new Error('turn/start response lost');
    vi.spyOn(port, 'request').mockImplementation(async (method, params) => {
      if (method === 'turn/start') throw dispatchError;
      return FakePort.prototype.request.call(port, method, params);
    });

    await expect(controller.runTurn('hello', 'message-ambiguous')).rejects.toThrow(
      /response lost/,
    );
    expect(controller.status()).toBe('Errored');
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it('should_interrupt_the_active_turn_and_wait_for_interrupted_terminal', async () => {
    const port = new FakePort();
    const controller = new AppServerController(port, options);
    await controller.initialize();
    const active = controller.runTurn('long', 'message-1');
    await flush();

    await expect(controller.interrupt()).resolves.toBe(true);
    expect(port.requests.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thr_1', turnId: 'turn_1' },
    });
    controller.handleNotification({
      method: 'turn/completed',
      params: { threadId: 'thr_1', turn: turn('turn_1', 'interrupted') },
    });
    await expect(active).resolves.toEqual({ status: 'interrupted', text: null });
    expect(controller.status()).toBe('Idle');
  });

  it('should_update_queryable_status_only_for_the_owned_thread', async () => {
    const controller = new AppServerController(new FakePort(), options);
    await controller.initialize();
    controller.handleNotification({
      method: 'thread/status/changed',
      params: { threadId: 'thr_1', status: { type: 'active', activeFlags: [] } },
    });
    expect(controller.status()).toBe('Busy');

    expect(() =>
      controller.handleNotification({
        method: 'thread/status/changed',
        params: { threadId: 'other', status: { type: 'idle' } },
      }),
    ).toThrow(AppServerControllerError);
    expect(controller.status()).toBe('Errored');
  });

  it('should_accept_turn_started_only_for_the_pending_or_active_owned_turn', async () => {
    const port = new FakePort();
    let resolveStart!: (value: unknown) => void;
    const startResponse = new Promise<unknown>((resolve) => { resolveStart = resolve; });
    vi.spyOn(port, 'request').mockImplementation(async (method, params) => {
      if (method === 'turn/start') {
        port.requests.push({ method, params });
        return startResponse;
      }
      return FakePort.prototype.request.call(port, method, params);
    });
    const controller = new AppServerController(port, options);
    await controller.initialize();

    const active = controller.runTurn('owned', 'message-owned');
    await vi.waitFor(() => expect(port.requests.at(-1)?.method).toBe('turn/start'));
    expect(() => controller.handleNotification({
      method: 'turn/started',
      params: { threadId: 'thr_1', turn: turn('turn_owned', 'inProgress') },
    })).not.toThrow();
    resolveStart({ turn: turn('turn_owned', 'inProgress') });
    await flush();
    controller.handleNotification({
      method: 'turn/completed',
      params: { threadId: 'thr_1', turn: turn('turn_owned', 'failed') },
    });

    await expect(active).resolves.toMatchObject({ status: 'failed' });
  });

  it('should_fail_closed_on_a_foreign_turn_started_while_idle', async () => {
    const fatal = vi.fn();
    const controller = new AppServerController(new FakePort(), options, { onFatal: fatal });
    await controller.initialize();

    expect(() => controller.handleNotification({
      method: 'turn/started',
      params: { threadId: 'thr_1', turn: turn('turn_foreign', 'inProgress') },
    })).toThrow(/ownership|foreign|unsupported/);

    expect(controller.status()).toBe('Errored');
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal.mock.calls[0]![0]).toBeInstanceOf(AppServerForeignTurnError);
  });

  it('should_fail_closed_on_a_foreign_turn_started_while_busy_without_promoting_output', async () => {
    const finals: string[] = [];
    const controller = new AppServerController(new FakePort(), options, {
      onFinal: (text) => finals.push(text),
    });
    await controller.initialize();
    const active = controller.runTurn('owned', 'message-owned');
    await flush();

    expect(() => controller.handleNotification({
      method: 'turn/started',
      params: { threadId: 'thr_1', turn: turn('turn_foreign', 'inProgress') },
    })).toThrow(/ownership|foreign|unsupported/);

    await expect(active).rejects.toBeInstanceOf(AppServerForeignTurnError);
    expect(finals).toEqual([]);
    expect(controller.status()).toBe('Errored');
  });

  it('should_fail_closed_on_duplicate_terminal_or_wrong_turn', async () => {
    const onFatal = vi.fn();
    const controller = new AppServerController(new FakePort(), options, { onFatal });
    await controller.initialize();
    const active = controller.runTurn('one', 'message-1');
    await flush();

    expect(() =>
      controller.handleNotification({
        method: 'turn/completed',
        params: { threadId: 'thr_1', turn: turn('wrong', 'completed') },
      }),
    ).toThrow(AppServerControllerError);
    await expect(active).rejects.toBeInstanceOf(AppServerControllerError);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('should_track_owned_item_ids_and_reject_an_unowned_item_completion', async () => {
    const controller = new AppServerController(new FakePort(), options);
    await controller.initialize();
    const active = controller.runTurn('one', 'message-1');
    await flush();
    controller.handleNotification({
      method: 'item/started',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { id: 'item_owned', type: 'commandExecution' },
      },
    });
    expect(controller.activeIdentity()).toEqual({
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemIds: ['item_owned'],
    });

    expect(() => controller.handleNotification({
      method: 'item/completed',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { id: 'item_foreign', type: 'commandExecution' },
      },
    })).toThrow(/item.*ownership/i);
    await expect(active).rejects.toBeInstanceOf(AppServerControllerError);
  });

  it('should_validate_owned_agent_message_deltas_without_promoting_them', async () => {
    const finals: string[] = [];
    const controller = new AppServerController(new FakePort(), options, {
      onFinal: (text) => finals.push(text),
    });
    await controller.initialize();
    const active = controller.runTurn('one', 'message-1');
    await flush();
    controller.handleNotification({
      method: 'item/started',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { id: 'item_owned', type: 'agentMessage' },
      },
    });

    expect(() => controller.handleNotification({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_owned',
        delta: 'partial',
      },
    })).not.toThrow();
    expect(finals).toEqual([]);

    controller.handleNotification({
      method: 'turn/completed',
      params: { threadId: 'thr_1', turn: turn('turn_1', 'failed') },
    });
    await expect(active).resolves.toEqual({ status: 'failed', text: null });
  });

  it.each([
    ['foreign thread', { threadId: 'thr_foreign', turnId: 'turn_1', itemId: 'item_owned' }],
    ['foreign turn', { threadId: 'thr_1', turnId: 'turn_foreign', itemId: 'item_owned' }],
    ['unowned item', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_foreign' }],
  ])('should_fail_closed_on_%s_agent_message_delta', async (_case, identity) => {
    const controller = new AppServerController(new FakePort(), options);
    await controller.initialize();
    const active = controller.runTurn('one', 'message-1');
    await flush();
    controller.handleNotification({
      method: 'item/started',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { id: 'item_owned', type: 'agentMessage' },
      },
    });

    expect(() => controller.handleNotification({
      method: 'item/agentMessage/delta',
      params: { ...identity, delta: 'foreign partial' },
    })).toThrow(/ownership/i);
    await expect(active).rejects.toBeInstanceOf(AppServerControllerError);
    expect(controller.status()).toBe('Errored');
  });

  it('should_validate_ownership_before_ignoring_stable_unpromoted_notifications', async () => {
    const finals: string[] = [];
    const controller = new AppServerController(new FakePort(), options, {
      onFinal: (text) => finals.push(text),
    });
    await controller.initialize();
    const active = controller.runTurn('one', 'message-1');
    await flush();
    controller.handleNotification({
      method: 'item/started',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { id: 'item_owned', type: 'commandExecution' },
      },
    });

    for (const notification of [
      {
        method: 'item/commandExecution/outputDelta',
        params: {
          threadId: 'thr_1',
          turnId: 'turn_1',
          itemId: 'item_owned',
          delta: 'output',
        },
      },
      {
        method: 'turn/diff/updated',
        params: { threadId: 'thr_1', turnId: 'turn_1', diff: 'patch' },
      },
      {
        method: 'thread/name/updated',
        params: { threadId: 'thr_1', threadName: 'owned' },
      },
      { method: 'account/updated', params: {} },
    ]) {
      expect(() => controller.handleNotification(notification)).not.toThrow();
    }
    expect(finals).toEqual([]);

    controller.handleNotification({
      method: 'turn/completed',
      params: { threadId: 'thr_1', turn: turn('turn_1', 'failed') },
    });
    await expect(active).resolves.toEqual({ status: 'failed', text: null });
  });

  it.each([
    [
      'foreign item',
      'item/commandExecution/outputDelta',
      { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_foreign', delta: 'x' },
    ],
    [
      'missing item identity',
      'item/fileChange/patchUpdated',
      { threadId: 'thr_1', turnId: 'turn_1', changes: [] },
    ],
    [
      'foreign turn',
      'turn/diff/updated',
      { threadId: 'thr_1', turnId: 'turn_foreign', diff: 'x' },
    ],
    [
      'foreign thread',
      'thread/name/updated',
      { threadId: 'thr_foreign', threadName: 'foreign' },
    ],
    [
      'foreign optional thread',
      'warning',
      { threadId: 'thr_foreign', message: 'foreign' },
    ],
    [
      'foreign optional turn',
      'hook/started',
      { threadId: 'thr_1', turnId: 'turn_foreign', run: {} },
    ],
    [
      'foreign nested thread',
      'thread/started',
      { thread: { id: 'thr_foreign' } },
    ],
  ])('should_fail_closed_on_%s_in_an_unpromoted_notification', async (
    _case,
    method,
    params,
  ) => {
    const controller = new AppServerController(new FakePort(), options);
    await controller.initialize();
    const active = controller.runTurn('one', 'message-1');
    await flush();
    controller.handleNotification({
      method: 'item/started',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { id: 'item_owned', type: 'commandExecution' },
      },
    });

    expect(() => controller.handleNotification({ method, params })).toThrow(
      /ownership|thread|turn|item/i,
    );
    await expect(active).rejects.toBeInstanceOf(AppServerControllerError);
    expect(controller.status()).toBe('Errored');
  });

  it('should_fail_closed_on_a_notification_outside_the_pinned_snapshot', async () => {
    const controller = new AppServerController(new FakePort(), options);
    await controller.initialize();

    expect(() => controller.handleNotification({
      method: 'future/notification',
      params: {},
    })).toThrow(/unsupported|snapshot|notification/i);
    expect(controller.status()).toBe('Errored');
  });
});
