import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthSnapshotError, AuthSnapshotManager } from './auth-snapshot.js';

const roots: string[] = [];

async function directory(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  await chmod(value, 0o700);
  return realpath(value);
}

async function sourceAuth(content: string): Promise<string> {
  const home = await directory('agent-nexus-auth-source-');
  await writeFile(join(home, 'auth.json'), content, { mode: 0o600 });
  return home;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true })));
});

describe('AuthSnapshotManager', () => {
  it('should_seed_auth_atomically_with_private_permissions', async () => {
    const source = await sourceAuth('{"tokens":{"access_token":"secret-a"}}');
    const destination = await directory('agent-nexus-auth-destination-');
    const manager = new AuthSnapshotManager(source, destination);

    const seeded = await manager.seedIfMissing();

    expect(await readFile(join(destination, 'auth.json'), 'utf8')).toContain('secret-a');
    expect((await stat(join(destination, 'auth.json'))).mode & 0o777).toBe(0o600);
    expect(seeded.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should_accept_a_non_private_but_non_writable_operator_codex_home', async () => {
    const source = await sourceAuth('{"token":"source"}');
    await chmod(source, 0o755);
    const destination = await directory('agent-nexus-auth-destination-');

    await expect(new AuthSnapshotManager(source, destination).prepare()).resolves.toBeDefined();
  });

  it('should_not_overwrite_an_existing_durable_auth_snapshot', async () => {
    const source = await sourceAuth('{"token":"source"}');
    const destination = await directory('agent-nexus-auth-destination-');
    const manager = new AuthSnapshotManager(source, destination);
    await manager.seedIfMissing();
    await writeFile(join(source, 'auth.json'), '{"token":"new-source"}', { mode: 0o600 });

    await manager.seedIfMissing();

    expect(await readFile(join(destination, 'auth.json'), 'utf8')).toContain('source');
    expect(await readFile(join(destination, 'auth.json'), 'utf8')).not.toContain('new-source');
  });

  it('should_rotate_only_when_source_digest_changed_after_auth_stale', async () => {
    const source = await sourceAuth('{"token":"old"}');
    const destination = await directory('agent-nexus-auth-destination-');
    const manager = new AuthSnapshotManager(source, destination);
    await manager.seedIfMissing();

    await expect(manager.rotateIfChanged()).rejects.toThrow(/unchanged|未变化/);
    await writeFile(join(source, 'auth.json'), '{"token":"new"}', { mode: 0o600 });
    await chmod(join(source, 'auth.json'), 0o600);
    await manager.rotateIfChanged();

    expect(await readFile(join(destination, 'auth.json'), 'utf8')).toContain('new');
  });

  it('should_rotate_on_next_prepare_only_after_a_stale_marker', async () => {
    const source = await sourceAuth('{"token":"old"}');
    const destination = await directory('agent-nexus-auth-destination-');
    const manager = new AuthSnapshotManager(source, destination);
    await manager.prepare();
    await writeFile(join(source, 'auth.json'), '{"token":"new"}', { mode: 0o600 });

    await manager.prepare();
    expect(await readFile(join(destination, 'auth.json'), 'utf8')).toContain('old');

    await manager.markStale();
    await manager.prepare();
    expect(await readFile(join(destination, 'auth.json'), 'utf8')).toContain('new');
    await expect(stat(join(destination, 'auth-stale'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should_fail_closed_and_preserve_stale_state_when_source_auth_did_not_change', async () => {
    const source = await sourceAuth('{"token":"unchanged"}');
    const destination = await directory('agent-nexus-auth-destination-');
    const manager = new AuthSnapshotManager(source, destination);
    await manager.prepare();
    await manager.markStale();

    await expect(manager.prepare()).rejects.toThrow(/unchanged|未变化/);
    await expect(readFile(join(destination, 'auth-stale'), 'utf8')).resolves.toBe('stale\n');
  });

  it('should_reject_symlink_or_group_readable_source_auth', async () => {
    const source = await directory('agent-nexus-auth-source-');
    const target = join(source, 'real-auth.json');
    await writeFile(target, '{"token":"secret"}', { mode: 0o600 });
    await symlink(target, join(source, 'auth.json'));
    const destination = await directory('agent-nexus-auth-destination-');

    await expect(
      new AuthSnapshotManager(source, destination).seedIfMissing(),
    ).rejects.toBeInstanceOf(AuthSnapshotError);

    await rm(join(source, 'auth.json'));
    await writeFile(join(source, 'auth.json'), '{"token":"secret"}', { mode: 0o640 });
    await expect(
      new AuthSnapshotManager(source, destination).seedIfMissing(),
    ).rejects.toBeInstanceOf(AuthSnapshotError);
  });

  it('should_reject_symlink_or_non_private_existing_destination_auth', async () => {
    const source = await sourceAuth('{"token":"source"}');
    const destination = await directory('agent-nexus-auth-destination-');
    const manager = new AuthSnapshotManager(source, destination);
    await manager.prepare();

    await rm(join(destination, 'auth.json'));
    await symlink(join(source, 'auth.json'), join(destination, 'auth.json'));
    await expect(manager.seedIfMissing()).rejects.toBeInstanceOf(AuthSnapshotError);

    await rm(join(destination, 'auth.json'));
    await writeFile(join(destination, 'auth.json'), '{"token":"unsafe"}', { mode: 0o640 });
    await expect(manager.seedIfMissing()).rejects.toBeInstanceOf(AuthSnapshotError);
  });

  it('should_reject_empty_or_oversized_source_auth', async () => {
    const source = await sourceAuth('');
    const destination = await directory('agent-nexus-auth-destination-');
    await expect(
      new AuthSnapshotManager(source, destination).seedIfMissing(),
    ).rejects.toBeInstanceOf(AuthSnapshotError);

    await writeFile(join(source, 'auth.json'), 'x'.repeat(1_048_577), { mode: 0o600 });
    await expect(
      new AuthSnapshotManager(source, destination).seedIfMissing(),
    ).rejects.toBeInstanceOf(AuthSnapshotError);
  });
});
