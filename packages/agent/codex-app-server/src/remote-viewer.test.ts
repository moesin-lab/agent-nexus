import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TerminalSessionStartError,
  type TerminalSessionHandle,
  type TerminalSessionStart,
  type TerminalSessionStartLifecycle,
} from '@agent-nexus/daemon';
import {
  createRemoteAppServerAuth,
  reconcileRemoteAppServerAuth,
  type RemoteAppServerAuth,
} from './remote-auth.js';
import {
  CodexRemoteViewerAdapter,
  type CodexRemoteViewerTerminalHost,
} from './remote-viewer.js';

const roots: string[] = [];

class FakeTerminalHost implements CodexRemoteViewerTerminalHost {
  readonly starts: Array<{
    config: TerminalSessionStart;
    lifecycle?: TerminalSessionStartLifecycle;
  }> = [];
  readonly stops: Array<{
    sessionId: string;
    ownerToken: string;
    incarnationId: string;
    mode: 'Force' | 'Graceful';
  }> = [];
  startError: Error | null = null;
  inspectState: TerminalSessionHandle['state'] = 'Running';
  stopError: Error | null = null;
  recoverError: Error | null = null;
  readonly allocatedStartReconciliations: Array<{
    sessionId: string;
    ownerToken: string;
  }> = [];
  readonly allocated: TerminalSessionHandle = {
    sessionId: '11111111111111111111111111111111',
    ownerToken: '',
    incarnationId: '22222222222222222222222222222222',
    state: 'Starting',
  };

  start(
    config: TerminalSessionStart,
    lifecycle?: TerminalSessionStartLifecycle,
  ): TerminalSessionHandle {
    const allocated = { ...this.allocated, ownerToken: config.ownerToken };
    this.starts.push({ config, lifecycle });
    lifecycle?.onAllocated?.(allocated);
    if (this.startError instanceof TerminalSessionStartError) {
      throw new TerminalSessionStartError(this.startError.message, {
        ...allocated,
        state: 'Lost',
      });
    }
    if (this.startError) throw this.startError;
    return { ...allocated, state: 'Running' };
  }

  inspect(
    sessionId: string,
    ownerToken: string,
    incarnationId: string,
  ): TerminalSessionHandle {
    return { sessionId, ownerToken, incarnationId, state: this.inspectState };
  }

  stop(
    sessionId: string,
    ownerToken: string,
    incarnationId: string,
    mode: 'Force' | 'Graceful',
  ): { state: 'Stopped'; alreadyTerminal: boolean } {
    this.stops.push({ sessionId, ownerToken, incarnationId, mode });
    if (this.stopError) throw this.stopError;
    return { state: 'Stopped', alreadyTerminal: false };
  }

  recover(sessionId: string, ownerToken: string): TerminalSessionHandle {
    if (this.recoverError) throw this.recoverError;
    return {
      sessionId,
      ownerToken,
      incarnationId: '33333333333333333333333333333333',
      state: 'Running',
    };
  }

  reconcileAllocatedStart(
    sessionId: string,
    ownerToken: string,
  ): { state: 'Stopped'; alreadyTerminal: boolean } {
    this.allocatedStartReconciliations.push({ sessionId, ownerToken });
    return { state: 'Stopped', alreadyTerminal: false };
  }
}

async function fixture(): Promise<{
  home: string;
  auth: RemoteAppServerAuth;
  input: Parameters<CodexRemoteViewerAdapter['start']>[0];
}> {
  const path = await mkdtemp(join(tmpdir(), 'agent-nexus-remote-viewer-'));
  roots.push(path);
  await chmod(path, 0o700);
  const home = await realpath(path);
  const auth = await createRemoteAppServerAuth(home);
  return {
    home,
    auth,
    input: {
      binding: {
        homeId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        appServerIncarnationId: auth.appServerIncarnationId,
        threadId: 'thr_viewer',
      },
      admission: {
        endpoint: 'ws://127.0.0.1:54321',
        appServerIncarnationId: auth.appServerIncarnationId,
        tokenEnvName: auth.tokenEnvName,
        tokenFile: auth.tokenFile,
        runtimeDir: auth.runtimeDir,
      },
      bin: '/usr/local/bin/codex',
      cwd: '/workspace',
      codexHome: home,
      environment: {
        PATH: '/usr/bin',
        LANG: 'C.UTF-8',
        FEISHU_APP_SECRET: 'must-not-forward',
      },
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('CodexRemoteViewerAdapter', () => {
  it('should_start_a_fixed_launcher_without_exposing_the_capability_token', async () => {
    const { auth, input } = await fixture();
    const terminalHost = new FakeTerminalHost();
    const adapter = new CodexRemoteViewerAdapter({
      terminalHost,
      processExecPath: '/usr/local/bin/node',
    });

    const result = await adapter.start(input);

    expect(result.kind).toBe('running');
    expect(terminalHost.starts).toHaveLength(1);
    const start = terminalHost.starts[0]!.config;
    expect(start.executable).toBe('/usr/local/bin/node');
    expect(start.args).toHaveLength(2);
    expect(start.args.every((path) => path.startsWith(auth.runtimeDir))).toBe(true);
    expect(start.env).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8', CODEX_HOME: input.codexHome });
    expect(JSON.stringify(start)).not.toContain(auth.token);
    expect(JSON.stringify(result)).not.toContain(auth.token);
    expect(JSON.stringify(result)).not.toContain(start.ownerToken);
    expect((adapter as unknown as { write?: unknown }).write).toBeUndefined();
    expect((adapter as unknown as { attach?: unknown }).attach).toBeUndefined();
    const metadata = JSON.parse(await readFile(start.args[1]!, 'utf8')) as Record<string, unknown>;
    expect(JSON.stringify(metadata)).not.toContain(auth.token);
    expect((await stat(start.args[0]!)).mode & 0o777).toBe(0o700);
    expect((await stat(start.args[1]!)).mode & 0o777).toBe(0o600);
  });

  it('should_reject_a_stale_incarnation_or_non_private_token_before_starting_terminal', async () => {
    const { auth, input } = await fixture();
    const terminalHost = new FakeTerminalHost();
    const adapter = new CodexRemoteViewerAdapter({ terminalHost });

    await expect(adapter.start({
      ...input,
      binding: { ...input.binding, appServerIncarnationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    })).rejects.toThrow(/incarnation/);
    await chmod(auth.tokenFile, 0o644);
    await expect(adapter.start(input)).rejects.toThrow(/0600|private/);
    expect(terminalHost.starts).toHaveLength(0);
  });

  it('should_allow_only_one_viewer_for_an_app_server_incarnation', async () => {
    const { input } = await fixture();
    const terminalHost = new FakeTerminalHost();
    const adapter = new CodexRemoteViewerAdapter({ terminalHost });

    await adapter.start(input);

    await expect(adapter.start(input)).rejects.toThrow(/already.*viewer|incarnation/i);
    expect(terminalHost.starts).toHaveLength(1);
  });

  it('should_track_an_ambiguous_start_and_force_stop_the_allocated_handle', async () => {
    const { input } = await fixture();
    const terminalHost = new FakeTerminalHost();
    const ownerToken = 'placeholder-owner-token';
    terminalHost.startError = new TerminalSessionStartError('ambiguous', {
      ...terminalHost.allocated,
      ownerToken,
      state: 'Lost',
    });
    const adapter = new CodexRemoteViewerAdapter({ terminalHost });

    const result = await adapter.start(input);

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous viewer');
    expect(result.error).not.toBe(terminalHost.startError);
    expect(JSON.stringify(result.error)).not.toContain(ownerToken);
    expect('handle' in result.error).toBe(false);
    await adapter.stop(result.handle);
    expect(terminalHost.stops).toEqual([
      expect.objectContaining({
        sessionId: terminalHost.allocated.sessionId,
        incarnationId: terminalHost.allocated.incarnationId,
        mode: 'Force',
      }),
    ]);
  });

  it('should_report_natural_exit_without_exposing_a_control_surface', async () => {
    vi.useFakeTimers();
    const { input } = await fixture();
    const terminalHost = new FakeTerminalHost();
    terminalHost.inspectState = 'Exited';
    const onMaintenanceError = vi.fn();
    const adapter = new CodexRemoteViewerAdapter({
      terminalHost,
      pollIntervalMs: 50,
      onMaintenanceError,
    });

    await adapter.start(input);
    await vi.advanceTimersByTimeAsync(50);

    expect(onMaintenanceError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/exited/) }),
    );
  });

  it('should_recover_and_force_stop_a_persisted_viewer_before_auth_reconciliation', async () => {
    const { home, input } = await fixture();
    const originalHost = new FakeTerminalHost();
    const original = new CodexRemoteViewerAdapter({ terminalHost: originalHost });
    await original.start(input);
    const recoveringHost = new FakeTerminalHost();
    const recovering = new CodexRemoteViewerAdapter({ terminalHost: recoveringHost });

    await recovering.reconcileConversation(home, {
      homeId: input.binding.homeId,
      threadId: input.binding.threadId,
    });

    expect(recoveringHost.stops).toEqual([
      expect.objectContaining({
        sessionId: originalHost.allocated.sessionId,
        incarnationId: '33333333333333333333333333333333',
        mode: 'Force',
      }),
    ]);
  });

  it('should_cleanup_a_persisted_allocated_start_when_ownership_markers_were_never_completed', async () => {
    const { home, input } = await fixture();
    const originalHost = new FakeTerminalHost();
    const original = new CodexRemoteViewerAdapter({ terminalHost: originalHost });
    await original.start(input);
    const recoveringHost = new FakeTerminalHost();
    recoveringHost.recoverError = new Error(
      'TerminalUnauthorized: ownership marker mismatch',
    );
    const recovering = new CodexRemoteViewerAdapter({ terminalHost: recoveringHost });

    await recovering.reconcileConversation(home, {
      homeId: input.binding.homeId,
      threadId: input.binding.threadId,
    });

    expect(recoveringHost.allocatedStartReconciliations).toEqual([
      expect.objectContaining({ sessionId: originalHost.allocated.sessionId }),
    ]);
    expect(recoveringHost.stops).toEqual([]);
  });

  it('should_recover_a_viewer_after_failed_stop_and_token_revocation', async () => {
    const { home, auth, input } = await fixture();
    const failingHost = new FakeTerminalHost();
    const stopError = new Error('viewer process exit not confirmed');
    failingHost.stopError = stopError;
    const original = new CodexRemoteViewerAdapter({ terminalHost: failingHost });
    const started = await original.start(input);
    if (started.kind !== 'running') throw new Error('expected running viewer');

    await expect(original.stop(started.handle)).rejects.toBe(stopError);
    await auth.revoke();
    await expect(stat(auth.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });

    const recoveringHost = new FakeTerminalHost();
    const recovering = new CodexRemoteViewerAdapter({ terminalHost: recoveringHost });
    await recovering.reconcileConversation(home, {
      homeId: input.binding.homeId,
      threadId: input.binding.threadId,
    });
    await reconcileRemoteAppServerAuth(home);

    expect(recoveringHost.stops).toEqual([
      expect.objectContaining({
        sessionId: failingHost.allocated.sessionId,
        mode: 'Force',
      }),
    ]);
    await expect(stat(auth.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should_reject_persisted_metadata_copied_from_a_different_conversation', async () => {
    const { home, input } = await fixture();
    const originalHost = new FakeTerminalHost();
    const original = new CodexRemoteViewerAdapter({ terminalHost: originalHost });
    await original.start(input);
    const metadataPath = originalHost.starts[0]!.config.args[1]!;
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    metadata.binding.homeId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
    const recoveringHost = new FakeTerminalHost();
    const recovering = new CodexRemoteViewerAdapter({ terminalHost: recoveringHost });

    await expect(recovering.reconcileConversation(home, {
      homeId: input.binding.homeId,
      threadId: input.binding.threadId,
    })).rejects.toThrow(/binding/);
    expect(recoveringHost.stops).toEqual([]);
  });
});
