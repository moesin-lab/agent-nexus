import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExperimentalTmuxTerminalSessionHost,
  TerminalSessionStartError,
  type TerminalSessionHandle,
} from './terminal-session.js';

const hosts: ExperimentalTmuxTerminalSessionHost[] = [];

function makeHost(): ExperimentalTmuxTerminalSessionHost {
  const host = new ExperimentalTmuxTerminalSessionHost({
    rootDir: temporaryDirectory('agent-nexus-terminal-test-'),
  });
  hosts.push(host);
  return host;
}

function startShell(host: ExperimentalTmuxTerminalSessionHost): TerminalSessionHandle {
  return host.start({
    executable: '/bin/sh',
    args: ['-c', 'while IFS= read -r line; do printf "reply:%s\\n" "$line"; done'],
    cwd: tmpdir(),
    env: { LANG: 'C.UTF-8' },
    cols: 80,
    rows: 24,
    ownerToken: '0123456789abcdef0123456789abcdef',
  });
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.shutdown();
});

describe('ExperimentalTmuxTerminalSessionHost', () => {
  it('should_reject_a_terminal_root_beneath_a_symlink_ancestor', () => {
    const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-nexus-terminal-symlink-')));
    const actualParent = join(testRoot, 'actual');
    const aliasParent = join(testRoot, 'alias');
    mkdirSync(actualParent, { mode: 0o700 });
    symlinkSync(actualParent, aliasParent);

    expect(() => new ExperimentalTmuxTerminalSessionHost({
      rootDir: join(aliasParent, 'terminal'),
    })).toThrowError(/symlink|canonical|TerminalConfigInvalid/);
    expect(existsSync(join(actualParent, 'terminal', 'terminal-launcher.mjs'))).toBe(false);
  });

  it('should_reject_a_prepositioned_terminal_socket_root_symlink', () => {
    const rootDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-nexus-terminal-socket-')));
    const socketRoot = join(
      realpathSync('/tmp'),
      `agent-nexus-tmux-${createHash('sha256')
        .update(rootDir)
        .digest('hex')
        .slice(0, 32)}`,
    );
    const redirected = realpathSync(mkdtempSync(join(tmpdir(), 'agent-nexus-terminal-redirect-')));
    try {
      symlinkSync(redirected, socketRoot);

      expect(() => new ExperimentalTmuxTerminalSessionHost({ rootDir })).toThrowError(
        /symlink|canonical|TerminalConfigInvalid/,
      );
    } finally {
      rmSync(socketRoot, { force: true, recursive: true });
    }
  });

  it('should_atomically_replace_a_launcher_symlink_without_clobbering_its_target', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-launcher-symlink-');
    const victim = join(rootDir, 'victim');
    const launcher = join(rootDir, 'terminal-launcher.mjs');
    writeFileSync(victim, 'do-not-overwrite', { mode: 0o600 });
    symlinkSync(victim, launcher);

    const host = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(host);

    expect(readFileSync(victim, 'utf8')).toBe('do-not-overwrite');
    expect(lstatSync(launcher).isSymbolicLink()).toBe(false);
    expect(readFileSync(launcher, 'utf8')).toContain('const claimedConfigPath');
  });

  it('should_round_trip_bracketed_paste_without_shell_interpolation', async () => {
    const host = makeHost();
    const handle = startShell(host);
    const marker = join(
      temporaryDirectory('agent-nexus-paste-marker-'),
      'must-not-run',
    );
    const input = `hello; $(touch ${marker})`;

    host.write(handle.sessionId, handle.ownerToken, handle.incarnationId, {
      mode: 'BracketedPaste',
      text: input,
    });

    await expect
      .poll(
        () =>
          host.snapshot(
            handle.sessionId,
            handle.ownerToken,
            handle.incarnationId,
            2000,
          ).text,
      )
      .toContain(`reply:${input}`);
    expect(existsSync(marker)).toBe(false);
  });

  it('should_reject_control_when_owner_token_does_not_match', () => {
    const host = makeHost();
    const handle = startShell(host);

    expect(() =>
      host.write(
        handle.sessionId,
        'wrong-owner-token-wrong-owner-token',
        handle.incarnationId,
        {
        mode: 'Keys',
        keys: ['CtrlC'],
        },
      ),
    ).toThrowError(/TerminalUnauthorized/);
  });

  it('should_recover_owned_session_after_the_host_process_exits', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-recover-');
    const moduleUrl = new URL('./terminal-session.ts', import.meta.url).href;
    const ownerToken = '0123456789abcdef0123456789abcdef';
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `const { ExperimentalTmuxTerminalSessionHost } = await import(${JSON.stringify(moduleUrl)});
const host = new ExperimentalTmuxTerminalSessionHost({ rootDir: ${JSON.stringify(rootDir)} });
const handle = host.start({ executable: '/bin/sh', args: ['-c', 'while IFS= read -r line; do printf "reply:%s\\\\n" "$line"; done'], cwd: ${JSON.stringify(tmpdir())}, env: { LANG: 'C.UTF-8' }, cols: 80, rows: 24, ownerToken: ${JSON.stringify(ownerToken)} });
process.stdout.write(JSON.stringify(handle));
process.exit(0);`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(child.status, child.stderr).toBe(0);
    const original = JSON.parse(child.stdout) as TerminalSessionHandle;

    const second = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(second);
    const recovered = second.recover(original.sessionId, ownerToken);

    expect(recovered.sessionId).toBe(original.sessionId);
    expect(recovered.incarnationId).not.toBe(original.incarnationId);
    expect(recovered.state).toBe('Running');
  });

  it('should_stop_only_the_target_session_and_remain_idempotent', () => {
    const host = makeHost();
    const first = startShell(host);
    const second = startShell(host);

    expect(
      host.stop(first.sessionId, first.ownerToken, first.incarnationId, 'Force'),
    ).toEqual({
      state: 'Stopped',
      alreadyTerminal: false,
    });
    expect(
      host.inspect(second.sessionId, second.ownerToken, second.incarnationId).state,
    ).toBe('Running');
    expect(
      host.stop(first.sessionId, first.ownerToken, first.incarnationId, 'Force'),
    ).toEqual({
      state: 'Stopped',
      alreadyTerminal: true,
    });
  });

  it('should_reject_a_handle_from_the_previous_incarnation_after_recover', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-stale-');
    const first = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(first);
    const original = startShell(first);
    first.detach();

    const second = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(second);
    second.recover(original.sessionId, original.ownerToken);

    expect(() =>
      second.inspect(
        original.sessionId,
        original.ownerToken,
        original.incarnationId,
      ),
    ).toThrowError(/StaleIncarnation/);
  });

  it('should_return_an_argv_attach_descriptor_without_owner_secret', () => {
    const host = makeHost();
    const handle = startShell(host);

    const descriptor = host.attach(
      handle.sessionId,
      handle.ownerToken,
      handle.incarnationId,
    );

    expect(descriptor).toMatchObject({ transport: 'LocalProcess' });
    expect(descriptor?.args).toContain('attach-session');
    expect(JSON.stringify(descriptor)).not.toContain(handle.ownerToken);
  });

  it('should_resize_a_running_session_and_reject_out_of_range_dimensions', () => {
    const host = makeHost();
    const handle = startShell(host);

    expect(
      host.resize(
        handle.sessionId,
        handle.ownerToken,
        handle.incarnationId,
        120,
        40,
      ),
    ).toEqual({ incarnationId: handle.incarnationId });
    expect(() =>
      host.resize(
        handle.sessionId,
        handle.ownerToken,
        handle.incarnationId,
        10,
        2,
      ),
    ).toThrowError(/TerminalConfigInvalid/);
  });

  it('should_delete_the_private_launch_record_after_the_child_has_started', async () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-record-');
    const host = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(host);

    startShell(host);

    await expect
      .poll(() => readdirSync(rootDir).filter((name) => name.startsWith('launch-')))
      .toEqual([]);
  });

  it('should_keep_authorizing_idempotent_stop_requests', () => {
    const host = makeHost();
    const handle = startShell(host);
    host.stop(handle.sessionId, handle.ownerToken, handle.incarnationId, 'Force');

    expect(() =>
      host.stop(
        handle.sessionId,
        'wrong-owner-token-wrong-owner-token',
        handle.incarnationId,
        'Force',
      ),
    ).toThrowError(/TerminalUnauthorized/);
  });

  it('should_reject_noncanonical_session_ids_before_tmux_target_resolution', () => {
    const host = makeHost();

    expect(() =>
      host.recover('other:0.0', '0123456789abcdef0123456789abcdef'),
    ).toThrowError(/TerminalConfigInvalid/);
  });

  it('should_fail_closed_when_tmux_target_presence_cannot_be_probed', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-probe-');
    const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
    const denyProbe = join(rootDir, 'deny-probe');
    const corruptProbe = join(rootDir, 'corrupt-probe');
    const exitingProbe = join(rootDir, 'exiting-probe');
    const proxyPath = join(rootDir, 'tmux-probe-proxy.mjs');
    writeFileSync(
      proxyPath,
      `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (existsSync(${JSON.stringify(denyProbe)}) && args.includes('has-session')) process.exit(91);
if (existsSync(${JSON.stringify(corruptProbe)}) && args.includes('has-session')) {
  process.stderr.write('error connecting to managed socket (Socket operation on non-socket)\\n');
  process.exit(1);
}
if (existsSync(${JSON.stringify(exitingProbe)}) && args.includes('has-session')) {
  process.stderr.write('server exited unexpectedly\\n');
  process.exit(1);
}
const result = spawnSync(${JSON.stringify(realTmux)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    chmodSync(proxyPath, 0o700);
    const first = new ExperimentalTmuxTerminalSessionHost({ rootDir, tmuxBin: proxyPath });
    hosts.push(first);
    const handle = startShell(first);
    writeFileSync(denyProbe, 'yes', { mode: 0o600 });

    expect(() => first.inspect(
      handle.sessionId,
      handle.ownerToken,
      handle.incarnationId,
    )).toThrowError(/TerminalDependencyUnavailable/);
    expect(() => first.stop(
      handle.sessionId,
      handle.ownerToken,
      handle.incarnationId,
      'Force',
    )).toThrowError(/TerminalDependencyUnavailable/);

    rmSync(denyProbe, { force: true });
    writeFileSync(corruptProbe, 'yes', { mode: 0o600 });
    expect(() => first.inspect(
      handle.sessionId,
      handle.ownerToken,
      handle.incarnationId,
    )).toThrowError(/TerminalDependencyUnavailable/);
    rmSync(corruptProbe, { force: true });
    writeFileSync(exitingProbe, 'yes', { mode: 0o600 });
    expect(() => first.inspect(
      handle.sessionId,
      handle.ownerToken,
      handle.incarnationId,
    )).toThrowError(/TerminalDependencyUnavailable/);
    rmSync(exitingProbe, { force: true });
    first.detach();
    const second = new ExperimentalTmuxTerminalSessionHost({ rootDir, tmuxBin: proxyPath });
    hosts.push(second);
    writeFileSync(denyProbe, 'yes', { mode: 0o600 });
    expect(() => second.recover(handle.sessionId, handle.ownerToken)).toThrowError(
      /TerminalDependencyUnavailable/,
    );
    rmSync(denyProbe, { force: true });
  });

  it('should_retry_a_transient_tmux_server_exit_without_treating_it_as_absence', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-transient-probe-');
    const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
    const injectFailure = join(rootDir, 'inject-transient-probe');
    const failureObserved = join(rootDir, 'transient-probe-observed');
    const proxyPath = join(rootDir, 'tmux-transient-probe-proxy.mjs');
    writeFileSync(
      proxyPath,
      `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (existsSync(${JSON.stringify(injectFailure)}) && !existsSync(${JSON.stringify(failureObserved)}) && args.includes('has-session')) {
  writeFileSync(${JSON.stringify(failureObserved)}, 'yes');
  process.stderr.write('server exited unexpectedly\\n');
  process.exit(1);
}
const result = spawnSync(${JSON.stringify(realTmux)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    chmodSync(proxyPath, 0o700);
    const host = new ExperimentalTmuxTerminalSessionHost({ rootDir, tmuxBin: proxyPath });
    hosts.push(host);
    const handle = startShell(host);
    writeFileSync(injectFailure, 'yes', { mode: 0o600 });

    expect(host.inspect(
      handle.sessionId,
      handle.ownerToken,
      handle.incarnationId,
    ).state).toBe('Running');
    expect(existsSync(failureObserved)).toBe(true);
  });

  it('should_not_treat_an_absent_socket_as_proof_when_tmux_itself_cannot_start', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-missing-probe-');
    const host = new ExperimentalTmuxTerminalSessionHost({
      rootDir,
      tmuxBin: '/definitely/missing/tmux',
    });
    hosts.push(host);

    expect(() => host.recover(
      'dddddddddddddddddddddddddddddddd',
      '0123456789abcdef0123456789abcdef',
    )).toThrowError(/TerminalDependencyUnavailable/);
  });

  it('should_not_report_not_found_while_a_trusted_child_identity_is_live', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-child-record-');
    const sessionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeFileSync(
      join(rootDir, `child-${sessionId}.pid`),
      JSON.stringify({ pid: process.pid, identity: 'current-test-process' }),
      { mode: 0o600 },
    );
    const host = new ExperimentalTmuxTerminalSessionHost({
      rootDir,
      processIdentity: (pid) => pid === process.pid ? 'current-test-process' : '',
    });
    hosts.push(host);

    expect(() => host.recover(
      sessionId,
      '0123456789abcdef0123456789abcdef',
    )).toThrowError(/TerminalStateConflict/);
  });

  it('should_not_report_not_found_while_a_launcher_claim_is_unresolved', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-launch-claim-');
    const sessionId = 'cccccccccccccccccccccccccccccccc';
    writeFileSync(
      join(rootDir, `launch-${sessionId}.json.claimed`),
      '{"claimed":true}',
      { mode: 0o600 },
    );
    const host = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(host);

    expect(() => host.recover(
      sessionId,
      '0123456789abcdef0123456789abcdef',
    )).toThrowError(/TerminalInternalFailure/);
  });

  it('should_treat_a_pid_probe_permission_error_as_unverifiable_live_ownership', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-pid-probe-');
    const sessionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const childPid = 424_242;
    writeFileSync(
      join(rootDir, `child-${sessionId}.pid`),
      JSON.stringify({ pid: childPid, identity: 'previous-process' }),
      { mode: 0o600 },
    );
    const host = new ExperimentalTmuxTerminalSessionHost({
      rootDir,
      processIdentity: () => 'different-process',
    });
    hosts.push(host);
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === childPid || pid === -childPid) {
        throw Object.assign(new Error('probe denied'), { code: 'EACCES' });
      }
      return true;
    }) as typeof process.kill);
    try {
      expect(() => host.recover(
        sessionId,
        '0123456789abcdef0123456789abcdef',
      )).toThrowError(/TerminalStateConflict/);
    } finally {
      kill.mockRestore();
    }
  });

  it('should_isolate_each_attach_descriptor_on_a_dedicated_tmux_socket', () => {
    const host = makeHost();
    const first = startShell(host);
    const second = startShell(host);

    const firstAttach = host.attach(
      first.sessionId,
      first.ownerToken,
      first.incarnationId,
    );
    const secondAttach = host.attach(
      second.sessionId,
      second.ownerToken,
      second.incarnationId,
    );

    expect(firstAttach?.args[1]).not.toBe(secondAttach?.args[1]);
  });

  it('should_reject_recover_while_another_live_host_owns_the_session', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-lease-');
    const first = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(first);
    const original = startShell(first);
    const second = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(second);

    expect(() => second.recover(original.sessionId, original.ownerToken)).toThrowError(
      /TerminalStateConflict/,
    );
  });

  it('should_fail_closed_when_a_live_owner_marker_cannot_be_observed', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-owner-marker-');
    const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
    const proxyPath = join(rootDir, 'tmux-owner-marker-proxy.mjs');
    writeFileSync(
      proxyPath,
      `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('show-option') && args.at(-1) === '@agent-nexus-host-pid') {
  process.stderr.write('owner marker temporarily unavailable\\n');
  process.exit(91);
}
const result = spawnSync(${JSON.stringify(realTmux)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    chmodSync(proxyPath, 0o700);
    const first = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(first);
    const original = startShell(first);
    const second = new ExperimentalTmuxTerminalSessionHost({ rootDir, tmuxBin: proxyPath });
    hosts.push(second);

    expect(() => second.recover(original.sessionId, original.ownerToken)).toThrowError(
      /TerminalDependencyUnavailable/,
    );
    expect(first.inspect(
      original.sessionId,
      original.ownerToken,
      original.incarnationId,
    ).state).toBe('Running');
  });

  it('should_reject_live_operations_after_the_backing_incarnation_marker_changes', () => {
    const host = makeHost();
    const handle = startShell(host);
    const descriptor = host.attach(
      handle.sessionId,
      handle.ownerToken,
      handle.incarnationId,
    );
    if (!descriptor) throw new Error('missing attach descriptor');
    execFileSync(descriptor.executable, [
      ...descriptor.args.slice(0, -3),
      'set-option',
      '-t',
      `anx-${handle.sessionId}`,
      '@agent-nexus-incarnation-id',
      'replaced',
    ]);

    expect(() =>
      host.inspect(handle.sessionId, handle.ownerToken, handle.incarnationId),
    ).toThrowError(/StaleIncarnation/);
  });

  it('should_reject_environment_keys_outside_the_terminal_allowlist', () => {
    const host = makeHost();

    expect(() =>
      host.start({
        executable: '/bin/sh',
        args: [],
        cwd: tmpdir(),
        env: { FEISHU_APP_SECRET: 'must-not-enter-child' },
        cols: 80,
        rows: 24,
        ownerToken: '0123456789abcdef0123456789abcdef',
      }),
    ).toThrowError(/TerminalConfigInvalid/);
  });

  it('should_reject_the_codex_remote_token_in_the_generic_terminal_host', () => {
    const host = makeHost();

    expect(() =>
      host.start({
        executable: '/bin/sh',
        args: [],
        cwd: tmpdir(),
        env: { AGENT_NEXUS_CODEX_REMOTE_TOKEN: 'must-use-a-dedicated-viewer-adapter' },
        cols: 80,
        rows: 24,
        ownerToken: '0123456789abcdef0123456789abcdef',
      }),
    ).toThrowError(/TerminalConfigInvalid/);
  });

  it('should_not_claim_graceful_stop_when_the_target_ignores_ctrl_c', async () => {
    const host = makeHost();
    const handle = host.start({
      executable: '/bin/sh',
      args: ['-c', "trap '' INT; printf 'READY\\n'; while :; do sleep 1; done"],
      cwd: tmpdir(),
      env: { LANG: 'C.UTF-8' },
      cols: 80,
      rows: 24,
      ownerToken: '0123456789abcdef0123456789abcdef',
    });
    await expect
      .poll(
        () =>
          host.snapshot(
            handle.sessionId,
            handle.ownerToken,
            handle.incarnationId,
            2000,
          ).text,
      )
      .toContain('READY');

    expect(() =>
      host.stop(
        handle.sessionId,
        handle.ownerToken,
        handle.incarnationId,
        'Graceful',
      ),
    ).toThrowError(/TerminalStateConflict/);
    expect(
      host.stop(
        handle.sessionId,
        handle.ownerToken,
        handle.incarnationId,
        'Force',
      ).state,
    ).toBe('Stopped');
  });

  it('should_exit_the_launcher_after_a_graceful_child_signal', () => {
    const host = makeHost();
    const handle = startShell(host);

    expect(host.stop(
      handle.sessionId,
      handle.ownerToken,
      handle.incarnationId,
      'Graceful',
    )).toEqual({ state: 'Exited', alreadyTerminal: false });
    expect(host.stop(
      handle.sessionId,
      handle.ownerToken,
      handle.incarnationId,
      'Force',
    )).toEqual({ state: 'Stopped', alreadyTerminal: true });
  });

  it('should_not_intercept_the_child_exit_signal_reemitted_by_the_launcher', async () => {
    const host = makeHost();
    const handle = host.start({
      executable: process.execPath,
      args: ['-e', "setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)"],
      cwd: tmpdir(),
      env: { LANG: 'C.UTF-8' },
      cols: 80,
      rows: 24,
      ownerToken: '0123456789abcdef0123456789abcdef',
    });
    const descriptor = host.attach(
      handle.sessionId,
      handle.ownerToken,
      handle.incarnationId,
    );
    if (!descriptor) throw new Error('missing attach descriptor');
    try {
      await expect.poll(() => host.inspect(
        handle.sessionId,
        handle.ownerToken,
        handle.incarnationId,
      ).state, { timeout: 3_000 }).toBe('Exited');
    } finally {
      try {
        execFileSync(descriptor.executable, [
          ...descriptor.args.slice(0, -3),
          'kill-session',
          '-t',
          `anx-${handle.sessionId}`,
        ], { stdio: 'ignore' });
      } catch {}
    }
  });

  it('should_delete_launch_records_when_tmux_start_fails', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-fail-');
    const host = new ExperimentalTmuxTerminalSessionHost({
      rootDir,
      tmuxBin: '/definitely/missing/tmux',
    });
    hosts.push(host);

    expect(() => startShell(host)).toThrowError(/TerminalDependencyUnavailable/);
    expect(readdirSync(rootDir).filter((name) => name.startsWith('launch-'))).toEqual(
      [],
    );
  });

  it('should_allocate_the_handle_before_any_backing_session_side_effect', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-allocate-');
    const host = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(host);
    let allocated: TerminalSessionHandle | null = null;

    expect(() =>
      host.start(
        {
          executable: '/bin/sh',
          args: [],
          cwd: tmpdir(),
          env: { LANG: 'C.UTF-8' },
          cols: 80,
          rows: 24,
          ownerToken: '0123456789abcdef0123456789abcdef',
        },
        {
          onAllocated: (handle) => {
            allocated = handle;
            expect(readdirSync(rootDir).filter((name) => name.startsWith('launch-'))).toEqual([]);
            throw new Error('owner metadata persist failed');
          },
        },
      ),
    ).toThrow('owner metadata persist failed');
    expect(allocated).toMatchObject({ state: 'Starting' });
    expect(readdirSync(rootDir).filter((name) => name.startsWith('launch-'))).toEqual([]);
  });

  it('should_return_a_tracked_handle_when_start_cleanup_is_ambiguous', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-ambiguous-start-');
    const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
    const allowCleanup = join(rootDir, 'allow-cleanup');
    const proxyPath = join(rootDir, 'tmux-start-proxy.mjs');
    writeFileSync(
      proxyPath,
      `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (!existsSync(${JSON.stringify(allowCleanup)}) && (args.includes('set-option') || args.includes('kill-session'))) process.exit(91);
const result = spawnSync(${JSON.stringify(realTmux)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    chmodSync(proxyPath, 0o700);
    const host = new ExperimentalTmuxTerminalSessionHost({ rootDir, tmuxBin: proxyPath });
    hosts.push(host);
    let allocated: TerminalSessionHandle | null = null;
    let startError: unknown;

    try {
      host.start(
        {
          executable: '/bin/sh',
          args: ['-c', 'while :; do sleep 1; done'],
          cwd: tmpdir(),
          env: { LANG: 'C.UTF-8' },
          cols: 80,
          rows: 24,
          ownerToken: '0123456789abcdef0123456789abcdef',
        },
        { onAllocated: (handle) => { allocated = handle; } },
      );
    } catch (error) {
      startError = error;
    }

    expect(startError).toBeInstanceOf(TerminalSessionStartError);
    expect((startError as TerminalSessionStartError).handle).toMatchObject({
      sessionId: allocated!.sessionId,
      ownerToken: allocated!.ownerToken,
      incarnationId: allocated!.incarnationId,
      state: 'Lost',
    });
    writeFileSync(allowCleanup, 'yes', { mode: 0o600 });
    expect(
      host.stop(
        allocated!.sessionId,
        allocated!.ownerToken,
        allocated!.incarnationId,
        'Force',
      ).state,
    ).toBe('Stopped');
  });

  it('should_preserve_the_launcher_until_force_compensates_a_post_start_failure', async () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-compensate-');
    const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
    const proxyPath = join(rootDir, 'tmux-compensation-proxy.mjs');
    writeFileSync(
      proxyPath,
      `#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('set-option')) {
  const deadline = Date.now() + 5_000;
  let published = false;
  while (!published && Date.now() < deadline) {
    const childRecord = readdirSync(${JSON.stringify(rootDir)})
      .find((name) => name.startsWith('child-'));
    if (childRecord) {
      const pid = Number(readFileSync(${JSON.stringify(rootDir)} + '/' + childRecord, 'utf8'));
      published = Number.isInteger(pid) && pid > 0;
    }
    if (!published) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  process.exit(91);
}
const result = spawnSync(${JSON.stringify(realTmux)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    chmodSync(proxyPath, 0o700);
    const host = new ExperimentalTmuxTerminalSessionHost({ rootDir, tmuxBin: proxyPath });
    hosts.push(host);
    let allocated: TerminalSessionHandle | null = null;
    let childPid = 0;
    try {
      expect(() => host.start(
        {
          executable: '/bin/sh',
          args: ['-c', "trap '' HUP TERM INT; while :; do sleep 1; done"],
          cwd: tmpdir(),
          env: { LANG: 'C.UTF-8' },
          cols: 80,
          rows: 24,
          ownerToken: '0123456789abcdef0123456789abcdef',
        },
        { onAllocated: (handle) => { allocated = handle; } },
      )).toThrowError(TerminalSessionStartError);
      const childRecord = JSON.parse(readFileSync(
        join(rootDir, `child-${allocated!.sessionId}.pid`),
        'utf8',
      )) as number | { pid: number };
      childPid = typeof childRecord === 'number' ? childRecord : childRecord.pid;
      const socketPath = join(
        realpathSync('/tmp'),
        `agent-nexus-tmux-${createHash('sha256')
          .update(rootDir)
          .digest('hex')
          .slice(0, 32)}`,
        `s-${allocated!.sessionId.slice(0, 16)}`,
      );
      execFileSync(realTmux, [
        '-S', socketPath, '-f', '/dev/null',
        'kill-session', '-t', `anx-${allocated!.sessionId}`,
      ]);
      expect(() => execFileSync(realTmux, [
        '-S', socketPath, '-f', '/dev/null',
        'has-session', '-t', `anx-${allocated!.sessionId}`,
      ], { stdio: 'ignore' })).toThrow();
      expect(processExists(-childPid)).toBe(true);

      expect(host.stop(
        allocated!.sessionId,
        allocated!.ownerToken,
        allocated!.incarnationId,
        'Force',
      )).toEqual({ state: 'Stopped', alreadyTerminal: false });
      await expect.poll(() => processExists(-childPid)).toBe(false);
    } finally {
      if (childPid > 0 && processExists(-childPid)) {
        try { process.kill(-childPid, 'SIGKILL'); } catch {}
        const deadline = Date.now() + 1_000;
        while (
          existsSync(join(rootDir, `child-${allocated?.sessionId ?? ''}.pid`)) &&
          Date.now() < deadline
        ) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    }
  });

  it('should_reconcile_an_allocated_start_after_crashing_before_ownership_markers', async () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-lost-start-');
    const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
    const proxyPath = join(rootDir, 'tmux-lost-start-proxy.mjs');
    writeFileSync(
      proxyPath,
      `#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('set-option') && args.at(-2) === '@agent-nexus-session-id') {
  const deadline = Date.now() + 5_000;
  let published = false;
  while (!published && Date.now() < deadline) {
    const childRecord = readdirSync(${JSON.stringify(rootDir)})
      .find((name) => name.startsWith('child-'));
    if (childRecord) {
      const pid = Number(readFileSync(${JSON.stringify(rootDir)} + '/' + childRecord, 'utf8'));
      published = Number.isInteger(pid) && pid > 0;
    }
    if (!published) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  process.exit(91);
}
const result = spawnSync(${JSON.stringify(realTmux)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    chmodSync(proxyPath, 0o700);
    const first = new ExperimentalTmuxTerminalSessionHost({ rootDir, tmuxBin: proxyPath });
    hosts.push(first);
    let allocated: TerminalSessionHandle | null = null;
    let childPid = 0;
    try {
      expect(() => first.start(
        {
          executable: '/bin/sh',
          args: ['-c', "trap '' HUP TERM INT; while :; do sleep 1; done"],
          cwd: tmpdir(),
          env: { LANG: 'C.UTF-8' },
          cols: 80,
          rows: 24,
          ownerToken: '0123456789abcdef0123456789abcdef',
        },
        { onAllocated: (handle) => { allocated = handle; } },
      )).toThrowError(TerminalSessionStartError);
      childPid = Number(readFileSync(
        join(rootDir, `child-${allocated!.sessionId}.pid`),
        'utf8',
      ));
      expect(processExists(-childPid)).toBe(true);
      first.detach();

      const second = new ExperimentalTmuxTerminalSessionHost({ rootDir });
      hosts.push(second);
      const reconcile = second as unknown as {
        reconcileAllocatedStart(
          sessionId: string,
          ownerToken: string,
        ): { state: 'Stopped' | 'Exited'; alreadyTerminal: boolean };
      };
      expect(() => reconcile.reconcileAllocatedStart(
        allocated!.sessionId,
        'wrong-owner-token-wrong-owner-token',
      )).toThrowError(/TerminalInternalFailure|TerminalUnauthorized/);
      expect(processExists(-childPid)).toBe(true);

      expect(reconcile.reconcileAllocatedStart(
        allocated!.sessionId,
        allocated!.ownerToken,
      )).toEqual({ state: 'Stopped', alreadyTerminal: false });
      await expect.poll(() => processExists(-childPid)).toBe(false);
    } finally {
      if (childPid > 0 && processExists(-childPid)) {
        try { process.kill(-childPid, 'SIGKILL'); } catch {}
      }
    }
  });

  it('should_settle_force_cleanup_when_the_launcher_child_emits_spawn_error', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-spawn-error-');
    const executable = join(rootDir, 'missing-interpreter');
    writeFileSync(executable, '#!/definitely/missing/interpreter\n', { mode: 0o700 });
    chmodSync(executable, 0o700);
    const host = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(host);
    let allocated: TerminalSessionHandle | null = null;
    let attach: ReturnType<ExperimentalTmuxTerminalSessionHost['attach']> = null;
    try {
      expect(() => host.start(
        {
          executable,
          args: [],
          cwd: tmpdir(),
          env: { LANG: 'C.UTF-8' },
          cols: 80,
          rows: 24,
          ownerToken: '0123456789abcdef0123456789abcdef',
        },
        { onAllocated: (handle) => { allocated = handle; } },
      )).toThrowError(TerminalSessionStartError);
      try {
        attach = host.attach(
          allocated!.sessionId,
          allocated!.ownerToken,
          allocated!.incarnationId,
        );
      } catch {
        // A fixed launcher may already have removed the target and intent.
      }

      expect(host.stop(
        allocated!.sessionId,
        allocated!.ownerToken,
        allocated!.incarnationId,
        'Force',
      )).toEqual({ state: 'Stopped', alreadyTerminal: false });
    } finally {
      if (attach && allocated) {
        const prefix = attach.args.slice(0, -3);
        const target = `anx-${allocated.sessionId}`;
        try {
          const panePid = Number(execFileSync(attach.executable, [
            ...prefix,
            'list-panes', '-t', target, '-F', '#{pane_pid}',
          ], { encoding: 'utf8' }).trim());
          if (Number.isInteger(panePid) && panePid > 0) process.kill(panePid, 'SIGKILL');
        } catch {}
        try {
          execFileSync(attach.executable, [
            ...prefix,
            'kill-session', '-t', target,
          ], { stdio: 'ignore' });
        } catch {}
      }
      if (allocated) {
        rmSync(join(rootDir, `child-${allocated.sessionId}.pid`), { force: true });
      }
    }
  }, 10_000);

  it('should_treat_every_failure_after_tmux_new_session_returns_as_ambiguous', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-post-start-');
    const proxyPath = join(rootDir, 'tmux-post-start-proxy.mjs');
    writeFileSync(
      proxyPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('new-session')) process.exit(0);
if (args.includes('has-session')) {
  process.stderr.write("can't find session: synthetic\\n");
  process.exit(1);
}
process.exit(91);
`,
      { mode: 0o700 },
    );
    chmodSync(proxyPath, 0o700);
    const host = new ExperimentalTmuxTerminalSessionHost({ rootDir, tmuxBin: proxyPath });
    hosts.push(host);
    let allocated: TerminalSessionHandle | null = null;
    let failure: unknown;

    try {
      host.start(
        {
          executable: '/bin/sh',
          args: [],
          cwd: tmpdir(),
          env: { LANG: 'C.UTF-8' },
          cols: 80,
          rows: 24,
          ownerToken: '0123456789abcdef0123456789abcdef',
        },
        { onAllocated: (handle) => { allocated = handle; } },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TerminalSessionStartError);
    expect((failure as TerminalSessionStartError).handle).toMatchObject({
      sessionId: allocated!.sessionId,
      state: 'Lost',
    });
    // Simulate a launcher that won the claim and then exited before stop observed it.
    rmSync(join(rootDir, `launch-${allocated!.sessionId}.json`), { force: true });
    expect(host.stop(
      allocated!.sessionId,
      allocated!.ownerToken,
      allocated!.incarnationId,
      'Force',
    )).toEqual({ state: 'Stopped', alreadyTerminal: false });
  });

  it('should_report_ambiguous_write_when_delivery_succeeds_but_ack_fails', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-ambiguous-');
    const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
    const proxyPath = join(rootDir, 'tmux-proxy.mjs');
    writeFileSync(
      proxyPath,
      `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realTmux)}, args, { stdio: 'inherit' });
if (args.includes('paste-buffer') && result.status === 0) process.exit(91);
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    chmodSync(proxyPath, 0o700);
    const host = new ExperimentalTmuxTerminalSessionHost({
      rootDir,
      tmuxBin: proxyPath,
    });
    hosts.push(host);
    const handle = startShell(host);

    expect(() =>
      host.write(handle.sessionId, handle.ownerToken, handle.incarnationId, {
        mode: 'BracketedPaste',
        text: 'delivered once',
      }),
    ).toThrowError(/AmbiguousWrite/);
  });

  it('should_not_resolve_a_target_from_another_sessions_socket', () => {
    const host = makeHost();
    const first = startShell(host);
    const second = startShell(host);
    const firstAttach = host.attach(
      first.sessionId,
      first.ownerToken,
      first.incarnationId,
    );
    if (!firstAttach) throw new Error('missing attach descriptor');

    expect(() =>
      execFileSync(firstAttach.executable, [
        ...firstAttach.args.slice(0, -3),
        'has-session',
        '-t',
        `anx-${second.sessionId}`,
      ], { stdio: 'ignore' }),
    ).toThrow();
  });

  it('should_not_inherit_platform_secrets_from_parent_or_tmux_environment', async () => {
    const previousSecret = process.env['FEISHU_APP_SECRET'];
    process.env['FEISHU_APP_SECRET'] = 'parent-secret-must-not-leak';
    try {
      const host = makeHost();
      const handle = host.start({
        executable: '/bin/sh',
        args: [
          '-c',
          "printf 'secret=%s routing=%s\\n' \"${FEISHU_APP_SECRET-unset}\" \"${AGENT_NEXUS_SESSION_KEY-unset}\"; while :; do sleep 1; done",
        ],
        cwd: tmpdir(),
        env: { LANG: 'C.UTF-8' },
        cols: 80,
        rows: 24,
        ownerToken: '0123456789abcdef0123456789abcdef',
      });

      await expect
        .poll(
          () =>
            host.snapshot(
              handle.sessionId,
              handle.ownerToken,
              handle.incarnationId,
              2000,
            ).text,
        )
        .toContain('secret=unset routing=unset');
    } finally {
      if (previousSecret === undefined) delete process.env['FEISHU_APP_SECRET'];
      else process.env['FEISHU_APP_SECRET'] = previousSecret;
    }
  });

  it('should_recover_when_a_reused_live_pid_has_a_different_process_identity', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-pid-reuse-');
    const first = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(first);
    const handle = startShell(first);
    const descriptor = first.attach(
      handle.sessionId,
      handle.ownerToken,
      handle.incarnationId,
    );
    if (!descriptor) throw new Error('missing attach descriptor');
    first.detach();
    const tmuxPrefix = descriptor.args.slice(0, -3);
    execFileSync(descriptor.executable, [
      ...tmuxPrefix,
      'set-option', '-t', `anx-${handle.sessionId}`,
      '@agent-nexus-host-pid', String(process.pid),
    ]);
    execFileSync(descriptor.executable, [
      ...tmuxPrefix,
      'set-option', '-t', `anx-${handle.sessionId}`,
      '@agent-nexus-host-identity', 'different-process-start',
    ]);

    const second = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(second);
    expect(second.recover(handle.sessionId, handle.ownerToken).state).toBe('Running');
  });

  it('should_kill_the_child_process_group_when_force_stopping', async () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-force-');
    const childPidPath = join(rootDir, 'stubborn-child.pid');
    const descendantPidPath = join(rootDir, 'stubborn-descendant.pid');
    const host = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(host);
    const handle = host.start({
      executable: '/bin/sh',
      args: [
        '-c',
        `trap '' HUP TERM INT; printf '%s' $$ > ${JSON.stringify(childPidPath)}; sleep 1000 & printf '%s' $! > ${JSON.stringify(descendantPidPath)}; while :; do sleep 1; done`,
      ],
      cwd: tmpdir(),
      env: { LANG: 'C.UTF-8' },
      cols: 80,
      rows: 24,
      ownerToken: '0123456789abcdef0123456789abcdef',
    });
    await expect.poll(() => existsSync(childPidPath)).toBe(true);
    await expect.poll(() => existsSync(descendantPidPath)).toBe(true);
    const childPid = Number(readFileSync(childPidPath, 'utf8'));
    const descendantPid = Number(readFileSync(descendantPidPath, 'utf8'));

    host.stop(handle.sessionId, handle.ownerToken, handle.incarnationId, 'Force');

    await expect
      .poll(() => {
        try {
          process.kill(childPid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    await expect
      .poll(() => {
        try {
          process.kill(descendantPid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });

  it('should_cleanup_remaining_process_group_members_after_the_root_exits', async () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-natural-exit-');
    const descendantPidPath = join(rootDir, 'natural-exit-descendant.pid');
    const host = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(host);
    let descendantPid = 0;
    try {
      const handle = host.start({
        executable: '/bin/sh',
        args: [
          '-c',
          `sleep 1000 & printf '%s' $! > ${JSON.stringify(descendantPidPath)}; sleep 1; exit 0`,
        ],
        cwd: tmpdir(),
        env: { LANG: 'C.UTF-8' },
        cols: 80,
        rows: 24,
        ownerToken: '0123456789abcdef0123456789abcdef',
      });
      await expect.poll(() => existsSync(descendantPidPath)).toBe(true);
      descendantPid = Number(readFileSync(descendantPidPath, 'utf8'));

      await expect.poll(() => host.inspect(
        handle.sessionId,
        handle.ownerToken,
        handle.incarnationId,
      ).state, { timeout: 3_000 }).toBe('Exited');
      expect(processExists(descendantPid)).toBe(false);
    } finally {
      if (descendantPid > 0 && processExists(descendantPid)) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch {}
      }
    }
  });

  it('should_reclaim_a_recovery_lock_when_its_pid_identity_was_reused', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-lock-reuse-');
    const first = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(first);
    const handle = startShell(first);
    first.detach();
    symlinkSync(
      `${process.pid}.0000000000000000.stale-token`,
      join(rootDir, `recover-${handle.sessionId}.lock`),
    );

    const second = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(second);
    expect(second.recover(handle.sessionId, handle.ownerToken).state).toBe('Running');
  });

  it('should_fail_closed_when_live_owner_identity_cannot_be_observed', () => {
    const rootDir = temporaryDirectory('agent-nexus-terminal-identity-fail-');
    const first = new ExperimentalTmuxTerminalSessionHost({ rootDir });
    hosts.push(first);
    const handle = startShell(first);
    const second = new ExperimentalTmuxTerminalSessionHost({
      rootDir,
      processIdentity: () => '',
    });
    hosts.push(second);

    expect(() => second.recover(handle.sessionId, handle.ownerToken)).toThrowError(
      /TerminalStateConflict/,
    );
  });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function temporaryDirectory(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
