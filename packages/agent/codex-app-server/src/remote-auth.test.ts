import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_REMOTE_TOKEN_ENV,
  createRemoteAppServerAuth,
  reconcileRemoteAppServerAuth,
} from './remote-auth.js';

const roots: string[] = [];

async function privateHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-nexus-remote-auth-'));
  roots.push(path);
  await chmod(path, 0o700);
  return realpath(path);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('createRemoteAppServerAuth', () => {
  it('creates a private per-incarnation token without putting the secret in argv', async () => {
    const home = await privateHome();
    const auth = await createRemoteAppServerAuth(home);

    expect(auth.endpoint).toBe('ws://127.0.0.1:0');
    expect(auth.appServerIncarnationId).toMatch(/^[0-9a-f]{32}$/);
    expect(auth.tokenEnvName).toBe(CODEX_REMOTE_TOKEN_ENV);
    expect(Buffer.from(auth.token, 'base64url')).toHaveLength(32);
    expect((await stat(auth.runtimeDir)).mode & 0o777).toBe(0o700);
    expect((await stat(auth.tokenFile)).mode & 0o777).toBe(0o600);
    expect((await readFile(auth.tokenFile, 'utf8')).trim()).toBe(auth.token);
    expect(auth.serverArgs).toEqual([
      'app-server',
      '--listen',
      'ws://127.0.0.1:0',
      '--ws-auth',
      'capability-token',
      '--ws-token-file',
      auth.tokenFile,
    ]);
    expect(auth.serverArgs.join(' ')).not.toContain(auth.token);

    await auth.dispose();
    await expect(stat(auth.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('generates unrelated tokens for separate app-server incarnations', async () => {
    const home = await privateHome();
    const first = await createRemoteAppServerAuth(home);
    const second = await createRemoteAppServerAuth(home);

    expect(second.runtimeDir).not.toBe(first.runtimeDir);
    expect(second.token).not.toBe(first.token);
    expect(second.appServerIncarnationId).not.toBe(first.appServerIncarnationId);

    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('revokes_the_capability_without_deleting_durable_viewer_recovery_metadata', async () => {
    const home = await privateHome();
    const auth = await createRemoteAppServerAuth(home);
    const metadata = join(auth.runtimeDir, 'codex-remote-viewer-owner.json');
    await writeFile(metadata, '{"viewer":"recoverable"}', { mode: 0o600 });

    await auth.revoke();

    await expect(stat(auth.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(metadata, 'utf8')).resolves.toContain('recoverable');
    await auth.dispose();
    await expect(stat(auth.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows token cleanup to be retried after a transient removal failure', async () => {
    const home = await privateHome();
    let removalAttempts = 0;
    const auth = await createRemoteAppServerAuth(home, {
      remove: async (path, options) => {
        removalAttempts += 1;
        if (removalAttempts === 1) {
          throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
        }
        await rm(path, options);
      },
    });

    await expect(auth.dispose()).rejects.toMatchObject({ code: 'EBUSY' });
    await auth.dispose();

    expect(removalAttempts).toBe(2);
    await expect(stat(auth.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports token creation and rollback failures while preserving next-start recovery', async () => {
    const home = await privateHome();
    const creationError = new Error('token write failed');
    const cleanupError = Object.assign(new Error('resource busy'), { code: 'EBUSY' });

    const failure = await createRemoteAppServerAuth(home, {
      writeTokenFile: async () => {
        throw creationError;
      },
      remove: async () => {
        throw cleanupError;
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([creationError, cleanupError]);
    expect(await readdir(join(home, 'agent-nexus-runtime'))).toHaveLength(1);

    await reconcileRemoteAppServerAuth(home);
    await expect(stat(join(home, 'agent-nexus-runtime'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a non-private or symlink conversation home', async () => {
    const publicHome = await privateHome();
    await chmod(publicHome, 0o755);
    await expect(createRemoteAppServerAuth(publicHome)).rejects.toThrow(/0700/);

    const parent = await privateHome();
    const target = await privateHome();
    const link = join(parent, 'linked-home');
    const { symlink } = await import('node:fs/promises');
    await symlink(target, link);
    await expect(createRemoteAppServerAuth(link)).rejects.toThrow(/symlink/);
  });
});
