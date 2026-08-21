import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationRegistry,
  ConversationRegistryError,
  acquireConversationRegistryLease,
  assertSupportedPrivateFilesystemPlatform,
  encodeSessionKeyAudit,
} from './conversation-registry.js';

const roots: string[] = [];
const owner = { backend: 'codex-app-server', agentName: 'codex-dev' } as const;

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'agent-nexus-conversation-registry-'));
  roots.push(value);
  return realpath(value);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true })));
});

describe('ConversationRegistry', () => {
  it('should_reject_a_traversal_or_duplicate_registry_before_reconciliation', async () => {
    const persistenceRoot = await root();
    await mkdir(join(persistenceRoot, 'homes'), { mode: 0o700 });
    const sentinel = join(persistenceRoot, 'must-not-delete');
    await writeFile(sentinel, 'safe');
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({
        version: 1,
        records: [
          {
            backend: 'codex-app-server',
            agentName: 'codex-dev',
            homeId: '../must-not-delete',
            status: 'creating',
            threadId: null,
            createdAt: 1,
            lastUsedAt: 1,
            bindingAudits: [],
          },
        ],
      }),
    );

    await expect(ConversationRegistry.open(persistenceRoot)).rejects.toBeInstanceOf(
      ConversationRegistryError,
    );
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('safe');
  });
  it('should_discard_only_an_uncommitted_provisional_home', async () => {
    const persistenceRoot = await root();
    const registry = await ConversationRegistry.open(persistenceRoot);
    const provisional = await registry.createProvisional(owner, 'session-audit');

    await registry.discardProvisional(provisional.homeId);

    await expect(stat(provisional.homePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(registry.commit(provisional.homeId, 'thr_missing')).rejects.toThrow(/不存在/);
  });
  it('should_keep_a_provisional_record_retryable_when_home_removal_fails', async () => {
    const persistenceRoot = await root();
    const cleanupError = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    let failRemoval = true;
    const registry = await ConversationRegistry.open(persistenceRoot, {
      removePath: async (path, options) => {
        if (failRemoval && path.startsWith(join(persistenceRoot, 'homes'))) {
          throw cleanupError;
        }
        await rm(path, options);
      },
    });
    const provisional = await registry.createProvisional(owner, 'session-audit');

    await expect(registry.discardProvisional(provisional.homeId)).rejects.toBe(cleanupError);
    expect(
      JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8')).records,
    ).toEqual([
      expect.objectContaining({ homeId: provisional.homeId, status: 'creating' }),
    ]);

    failRemoval = false;
    await registry.discardProvisional(provisional.homeId);
    await expect(stat(provisional.homePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('should_commit_thread_mapping_before_exposing_a_resumable_home', async () => {
    const registry = await ConversationRegistry.open(await root());
    const provisional = await registry.createProvisional(owner, '["p","lark","c","u"]');

    await expect(registry.resolve('thr_1', owner)).rejects.toThrow(
      ConversationRegistryError,
    );
    await registry.commit(provisional.homeId, 'thr_1', 100);

    await expect(registry.resolve('thr_1', owner)).resolves.toMatchObject({
      homeId: provisional.homeId,
      homePath: provisional.homePath,
      threadId: 'thr_1',
    });
  });

  it('should_create_distinct_homes_for_multiple_generations_of_one_session_key', async () => {
    const registry = await ConversationRegistry.open(await root());
    const audit = '["p","lark","same-channel","same-user"]';
    const first = await registry.createProvisional(owner, audit);
    const second = await registry.createProvisional(owner, audit);

    expect(first.homeId).not.toBe(second.homeId);
    expect(first.homePath).not.toBe(second.homePath);
  });

  it('should_persist_the_creating_record_before_touching_the_provisional_home', async () => {
    const persistenceRoot = await root();
    const persistError = new Error('registry persist failed');
    const cleanupError = new Error('home cleanup should not be needed');
    let failNextRegistryPersist = false;
    let homeRemovalAttempts = 0;
    const registry = await ConversationRegistry.open(persistenceRoot, {
      beforeAtomicRename: async (path) => {
        if (failNextRegistryPersist && path.endsWith('registry.json')) {
          failNextRegistryPersist = false;
          throw persistError;
        }
      },
      removePath: async (path, options) => {
        if (path.startsWith(join(persistenceRoot, 'homes'))) {
          homeRemovalAttempts += 1;
          throw cleanupError;
        }
        await rm(path, options);
      },
    });
    failNextRegistryPersist = true;

    await expect(registry.createProvisional(owner, 'session-audit')).rejects.toBe(
      persistError,
    );
    expect(homeRemovalAttempts).toBe(0);
    expect(await readdir(join(persistenceRoot, 'homes'))).toEqual([]);
  });

  it('should_leave_failed_home_setup_durably_indexed_when_rollback_fails', async () => {
    const persistenceRoot = await root();
    const setupError = new Error('owner metadata write failed');
    const cleanupError = Object.assign(new Error('home removal busy'), { code: 'EBUSY' });
    let failOwnerWrite = false;
    const registry = await ConversationRegistry.open(persistenceRoot, {
      beforeAtomicRename: async (path) => {
        if (failOwnerWrite && path.endsWith('owner.json')) throw setupError;
      },
      removePath: async (path, options) => {
        if (path.startsWith(join(persistenceRoot, 'homes'))) throw cleanupError;
        await rm(path, options);
      },
    });
    failOwnerWrite = true;

    const failure = await registry
      .createProvisional(owner, 'session-audit')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([setupError, cleanupError]);
    const persisted = JSON.parse(
      await readFile(join(persistenceRoot, 'registry.json'), 'utf8'),
    );
    expect(persisted.records).toEqual([
      expect.objectContaining({ status: 'creating', threadId: null }),
    ]);
    expect(await readdir(join(persistenceRoot, 'homes'))).toHaveLength(1);
  });

  it('should_resolve_by_thread_identity_after_session_rebind', async () => {
    const registry = await ConversationRegistry.open(await root());
    const created = await registry.createProvisional(owner, '["old","lark","c1","u"]');
    await registry.commit(created.homeId, 'thr_rebind', 100);

    const resumed = await registry.resolve('thr_rebind', owner);
    await registry.recordBindingAudit(
      'thr_rebind',
      '["new","lark","different-channel","u"]',
      200,
    );

    expect((await registry.resolve('thr_rebind', owner)).homeId).toBe(resumed.homeId);
  });

  it('should_delete_uncommitted_homes_during_startup_reconciliation', async () => {
    const persistenceRoot = await root();
    const homeId = '0123456789abcdef0123456789abcdef';
    const abandonedHome = join(persistenceRoot, 'homes', homeId);
    await mkdir(abandonedHome, { recursive: true, mode: 0o700 });
    const record = {
      ...owner,
      homeId,
      status: 'creating',
      threadId: null,
      createdAt: 100,
      lastUsedAt: 100,
      bindingAudits: [{ sessionKey: '["p","lark","c","u"]', at: 100 }],
    };
    await writeFile(join(abandonedHome, 'owner.json'), JSON.stringify(record), { mode: 0o600 });
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({ version: 1, records: [record] }),
      { mode: 0o600 },
    );

    await ConversationRegistry.open(persistenceRoot);

    await expect(stat(abandonedHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should_fail_closed_on_a_symlinked_remote_runtime_root_without_deleting_its_target', async () => {
    const persistenceRoot = await root();
    const external = await root();
    const homeId = '0123456789abcdef0123456789abcdee';
    const committedHome = join(persistenceRoot, 'homes', homeId);
    await mkdir(committedHome, { recursive: true, mode: 0o700 });
    const sentinel = join(external, 'must-not-delete');
    await writeFile(sentinel, 'safe', { mode: 0o600 });
    await symlink(external, join(committedHome, 'agent-nexus-runtime'));
    const record = {
      ...owner,
      homeId,
      status: 'committed',
      threadId: 'thr_symlink',
      createdAt: 100,
      lastUsedAt: 100,
      bindingAudits: [{ sessionKey: '["p","lark","c","u"]', at: 100 }],
    };
    await writeFile(join(committedHome, 'owner.json'), JSON.stringify(record), { mode: 0o600 });
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({ version: 1, records: [record] }),
      { mode: 0o600 },
    );

    await expect(ConversationRegistry.open(persistenceRoot)).rejects.toThrow(/runtime|symlink/);
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('safe');
  });

  it('should_reject_a_second_live_process_lock_and_reclaim_a_dead_lock', async () => {
    const liveRoot = await root();
    const liveNonce = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const liveLock = join(liveRoot, '.registry-locks', liveNonce);
    await mkdir(liveLock, { recursive: true, mode: 0o700 });
    await writeFile(
      join(liveLock, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processIdentity: 'live-process',
        nonce: liveNonce,
        createdAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    await expect(
      ConversationRegistry.open(liveRoot, {
        createNonce: () => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        pidIsAlive: () => true,
        processIdentity: () => 'live-process',
      }),
    ).rejects.toThrow(/lease|进程/);

    const deadRoot = await root();
    const deadNonce = 'cccccccccccccccccccccccccccccccc';
    const deadLock = join(deadRoot, '.registry-locks', deadNonce);
    await mkdir(deadLock, { recursive: true, mode: 0o700 });
    await writeFile(
      join(deadLock, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        processIdentity: 'dead-process',
        nonce: deadNonce,
        createdAt: 1,
      }),
      { mode: 0o600 },
    );
    await expect(
      ConversationRegistry.open(deadRoot, {
        createNonce: () => 'dddddddddddddddddddddddddddddddd',
        pidIsAlive: () => false,
        processIdentity: () => 'replacement-process',
      }),
    ).resolves.toBeInstanceOf(ConversationRegistry);
    await expect(stat(deadLock)).rejects.toMatchObject({ code: 'ENOENT' });
    const [replacement] = await readdir(join(deadRoot, '.registry-locks'));
    expect(replacement).toBe('dddddddddddddddddddddddddddddddd');
  });

  it('should_not_let_a_stale_owner_release_a_new_registry_lease', async () => {
    const persistenceRoot = await root();
    const first = await acquireConversationRegistryLease(persistenceRoot, {
      createNonce: () => '11111111111111111111111111111111',
      pidIsAlive: () => true,
      processIdentity: () => 'first-process',
    });
    const second = await acquireConversationRegistryLease(persistenceRoot, {
      createNonce: () => '22222222222222222222222222222222',
      pidIsAlive: () => false,
      processIdentity: () => 'second-process',
    });

    await first.release();

    await expect(stat(second.leasePath)).resolves.toBeDefined();
    await second.release();
  });

  it('should_reject_lease_release_when_ownership_can_no_longer_be_verified', async () => {
    const persistenceRoot = await root();
    const lease = await acquireConversationRegistryLease(persistenceRoot, {
      createNonce: () => 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    await writeFile(join(lease.leasePath, 'owner.json'), '{}\n', { mode: 0o600 });

    await expect(lease.release()).rejects.toBeInstanceOf(ConversationRegistryError);
    await expect(stat(lease.leasePath)).resolves.toBeDefined();
  });

  it('should_never_grant_two_competing_registry_leases', async () => {
    const persistenceRoot = await root();
    const identities = {
      pidIsAlive: () => true,
      processIdentity: () => 'same-live-process',
    };
    const attempts = await Promise.allSettled([
      acquireConversationRegistryLease(persistenceRoot, {
        ...identities,
        createNonce: () => '33333333333333333333333333333333',
      }),
      acquireConversationRegistryLease(persistenceRoot, {
        ...identities,
        createNonce: () => '44444444444444444444444444444444',
      }),
    ]);
    const granted = attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' ? [attempt.value] : [],
    );

    expect(granted.length).toBeLessThanOrEqual(1);
    const entries = await readdir(join(persistenceRoot, '.registry-locks'));
    expect(entries).toHaveLength(granted.length);
    await Promise.all(granted.map((lease) => lease.release()));
  });

  it('should_serialize_registry_mutations_so_an_older_snapshot_cannot_overwrite_a_newer_one', async () => {
    const persistenceRoot = await root();
    await mkdir(join(persistenceRoot, 'homes'), { mode: 0o700 });
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({ version: 1, records: [] }),
      { mode: 0o600 },
    );
    let releaseFirstRename!: () => void;
    const firstRenameGate = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    let firstRenameReached!: () => void;
    const firstAtRename = new Promise<void>((resolve) => {
      firstRenameReached = resolve;
    });
    let registryRenames = 0;
    const registry = await ConversationRegistry.open(persistenceRoot, {
      beforeAtomicRename: async (path) => {
        if (!path.endsWith('registry.json')) return;
        registryRenames += 1;
        if (registryRenames !== 1) return;
        firstRenameReached();
        await firstRenameGate;
      },
    });

    const first = registry.createProvisional(owner, 'first');
    await firstAtRename;
    const second = registry.createProvisional(owner, 'second');
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirstRename();
    const homes = await Promise.all([first, second]);

    const persisted = JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8'));
    expect(new Set(persisted.records.map((record: { homeId: string }) => record.homeId))).toEqual(
      new Set(homes.map((home) => home.homeId)),
    );
  });

  it('should_rollback_failed_audit_and_touch_mutations_before_the_next_persist', async () => {
    const persistenceRoot = await root();
    await mkdir(join(persistenceRoot, 'homes'), { mode: 0o700 });
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({ version: 1, records: [] }),
      { mode: 0o600 },
    );
    let failNextRegistryRename = false;
    const registry = await ConversationRegistry.open(persistenceRoot, {
      beforeAtomicRename: async (path) => {
        if (failNextRegistryRename && path.endsWith('registry.json')) {
          failNextRegistryRename = false;
          throw new Error('injected persist failure');
        }
      },
    });
    const created = await registry.createProvisional(owner, 'original-audit');
    await registry.commit(created.homeId, 'thr_rollback', 100);

    failNextRegistryRename = true;
    await expect(
      registry.recordBindingAudit('thr_rollback', 'failed-audit', 200),
    ).rejects.toThrow(/injected/);
    await registry.recordBindingAudit('thr_rollback', 'successful-audit', 300);
    let persisted = JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8'));
    expect(persisted.records[0].bindingAudits.map((audit: { sessionKey: string }) => audit.sessionKey))
      .toEqual(['original-audit', 'successful-audit']);

    failNextRegistryRename = true;
    await expect(registry.touch('thr_rollback', 100_000)).rejects.toThrow(/injected/);
    await expect(registry.collectExpired(60_000, 100_000)).resolves.toEqual({
      deletedHomeIds: [created.homeId],
    });
    persisted = JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8'));
    expect(persisted.records).toEqual([]);
  });

  it('should_reject_a_symlink_persistence_root_before_changing_target_permissions', async () => {
    const parent = await root();
    const target = await root();
    await chmod(target, 0o755);
    const linkedRoot = join(parent, 'linked-persistence');
    await symlink(target, linkedRoot);

    await expect(ConversationRegistry.open(linkedRoot)).rejects.toThrow(/symlink|canonical/);
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  it('should_reject_an_ancestor_symlink_before_creating_the_persistence_root', async () => {
    const parent = await root();
    const target = await root();
    await chmod(target, 0o755);
    const linkedParent = join(parent, 'linked-parent');
    await symlink(target, linkedParent);
    const requestedRoot = join(linkedParent, 'nested-persistence');

    await expect(ConversationRegistry.open(requestedRoot)).rejects.toThrow(/symlink|canonical/);
    await expect(stat(join(target, 'nested-persistence'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  it('should_reject_a_case_aliased_ancestor_before_creating_the_persistence_root', async () => {
    const parent = await root();
    const canonicalParent = join(parent, 'CanonicalParent');
    const aliasedParent = join(parent, 'canonicalparent');
    await mkdir(canonicalParent, { mode: 0o700 });
    try {
      await stat(aliasedParent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await chmod(canonicalParent, 0o755);

    await expect(
      ConversationRegistry.open(join(aliasedParent, 'nested-persistence')),
    ).rejects.toThrow(/canonical/);
    await expect(stat(join(canonicalParent, 'nested-persistence'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await stat(canonicalParent)).mode & 0o777).toBe(0o755);
  });

  it('should_fail_closed_on_platforms_without_posix_private_directory_semantics', () => {
    expect(() => assertSupportedPrivateFilesystemPlatform('win32')).toThrow(/platform/);
  });

  it('should_reject_symlinked_managed_directories_before_changing_target_permissions', async () => {
    for (const managedName of ['.registry-locks', 'homes']) {
      const persistenceRoot = await root();
      const target = await root();
      await chmod(target, 0o755);
      await symlink(target, join(persistenceRoot, managedName));

      await expect(
        ConversationRegistry.open(persistenceRoot, {
          processIdentity: () => 'test-process',
        }),
      ).rejects.toThrow(/symlink|private directory/);
      expect((await stat(target)).mode & 0o777).toBe(0o755);
    }
  });

  it('should_preserve_remote_runtime_artifacts_when_committed_owner_metadata_mismatches', async () => {
    const persistenceRoot = await root();
    const homeId = '0123456789abcdef0123456789abcded';
    const committedHome = join(persistenceRoot, 'homes', homeId);
    const runtimeRoot = join(committedHome, 'agent-nexus-runtime');
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const sentinel = join(runtimeRoot, 'must-not-delete');
    await writeFile(sentinel, 'safe', { mode: 0o600 });
    const record = {
      ...owner,
      homeId,
      status: 'committed',
      threadId: 'thr_owner_mismatch',
      createdAt: 100,
      lastUsedAt: 100,
      bindingAudits: [{ sessionKey: '["p","lark","c","u"]', at: 100 }],
    };
    await writeFile(
      join(committedHome, 'owner.json'),
      JSON.stringify({ ...record, agentName: 'unexpected-owner' }),
      { mode: 0o600 },
    );
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({ version: 1, records: [record] }),
      { mode: 0o600 },
    );

    await expect(ConversationRegistry.open(persistenceRoot)).rejects.toThrow(/metadata/);
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('safe');
  });

  it('should_reconcile_a_persisted_viewer_before_removing_remote_auth_artifacts', async () => {
    const persistenceRoot = await root();
    const homeId = '0123456789abcdef0123456789abcdea';
    const committedHome = join(persistenceRoot, 'homes', homeId);
    const runtimeRoot = join(committedHome, 'agent-nexus-runtime');
    const runtimeDir = join(runtimeRoot, 'remote-viewer');
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const sentinel = join(runtimeDir, 'capability-token');
    await writeFile(sentinel, 'secret', { mode: 0o600 });
    const record = {
      ...owner,
      homeId,
      status: 'committed',
      threadId: 'thr_viewer_reconcile',
      createdAt: 100,
      lastUsedAt: 100,
      bindingAudits: [{ sessionKey: 'audit', at: 100 }],
    } as const;
    await writeFile(join(committedHome, 'owner.json'), JSON.stringify(record), { mode: 0o600 });
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({ version: 1, records: [record] }),
      { mode: 0o600 },
    );
    const order: string[] = [];

    await ConversationRegistry.open(persistenceRoot, {
      reconcileRemoteViewer: async (homePath, binding) => {
        expect(homePath).toBe(committedHome);
        expect(binding).toEqual({ homeId, threadId: 'thr_viewer_reconcile' });
        await expect(readFile(sentinel, 'utf8')).resolves.toBe('secret');
        order.push('viewer');
      },
      removePath: async (path, options) => {
        if (path === runtimeRoot) order.push('auth');
        await rm(path, options);
      },
    });

    expect(order).toEqual(['viewer', 'auth']);
  });

  it('should_preserve_remote_auth_artifacts_when_viewer_reconciliation_fails', async () => {
    const persistenceRoot = await root();
    const homeId = '0123456789abcdef0123456789abcdeb';
    const committedHome = join(persistenceRoot, 'homes', homeId);
    const runtimeRoot = join(committedHome, 'agent-nexus-runtime');
    await mkdir(join(runtimeRoot, 'remote-viewer'), { recursive: true, mode: 0o700 });
    const sentinel = join(runtimeRoot, 'remote-viewer', 'capability-token');
    await writeFile(sentinel, 'secret', { mode: 0o600 });
    const record = {
      ...owner,
      homeId,
      status: 'committed',
      threadId: 'thr_viewer_failure',
      createdAt: 100,
      lastUsedAt: 100,
      bindingAudits: [{ sessionKey: 'audit', at: 100 }],
    } as const;
    await writeFile(join(committedHome, 'owner.json'), JSON.stringify(record), { mode: 0o600 });
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({ version: 1, records: [record] }),
      { mode: 0o600 },
    );
    const viewerError = new Error('viewer cleanup failed');
    let authRemovalAttempted = false;

    await expect(ConversationRegistry.open(persistenceRoot, {
      reconcileRemoteViewer: async () => { throw viewerError; },
      removePath: async (path, options) => {
        if (path === runtimeRoot) authRemovalAttempted = true;
        await rm(path, options);
      },
    })).rejects.toBe(viewerError);

    expect(authRemovalAttempted).toBe(false);
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('secret');
  });

  it('should_fail_closed_when_persisted_viewer_metadata_has_no_reconciler', async () => {
    const persistenceRoot = await root();
    const homeId = '0123456789abcdef0123456789abcdec';
    const committedHome = join(persistenceRoot, 'homes', homeId);
    const runtimeDir = join(committedHome, 'agent-nexus-runtime', 'remote-viewer');
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const metadata = join(runtimeDir, 'codex-remote-viewer-owner.json');
    await writeFile(metadata, '{"viewer":"possibly-live"}', { mode: 0o600 });
    const record = {
      ...owner,
      homeId,
      status: 'committed',
      threadId: 'thr_missing_reconciler',
      createdAt: 100,
      lastUsedAt: 100,
      bindingAudits: [{ sessionKey: 'audit', at: 100 }],
    } as const;
    await writeFile(join(committedHome, 'owner.json'), JSON.stringify(record), { mode: 0o600 });
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({ version: 1, records: [record] }),
      { mode: 0o600 },
    );

    await expect(ConversationRegistry.open(persistenceRoot)).rejects.toThrow(/viewer.*reconciler/i);
    await expect(readFile(metadata, 'utf8')).resolves.toContain('possibly-live');
  });

  it('should_return_one_in_process_registry_instance_per_canonical_root', async () => {
    const persistenceRoot = await root();
    const first = await ConversationRegistry.open(persistenceRoot);
    const second = await ConversationRegistry.open(persistenceRoot);
    expect(second).toBe(first);
  });

  it('should_keep_an_expired_home_indexed_for_retry_when_removal_fails', async () => {
    const persistenceRoot = await root();
    const cleanupError = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    let expiredHomePath = '';
    let failRemoval = true;
    const registry = await ConversationRegistry.open(persistenceRoot, {
      removePath: async (path, options) => {
        if (failRemoval && path === expiredHomePath) throw cleanupError;
        await rm(path, options);
      },
    });
    const expired = await registry.createProvisional(owner, 'expired');
    expiredHomePath = expired.homePath;
    await registry.commit(expired.homeId, 'thr_expired_retry', 100);

    await expect(registry.collectExpired(60_000, 100_000)).rejects.toBe(cleanupError);
    expect(
      JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8')).records,
    ).toEqual([
      expect.objectContaining({
        homeId: expired.homeId,
        status: 'deleting',
        threadId: 'thr_expired_retry',
      }),
    ]);
    await expect(stat(expired.homePath)).resolves.toBeDefined();

    failRemoval = false;
    await expect(registry.collectExpired(60_000, 100_000)).resolves.toEqual({
      deletedHomeIds: [expired.homeId],
    });
    await expect(stat(expired.homePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8')).records,
    ).toEqual([]);
  });

  it('should_reconcile_a_deleting_tombstone_on_the_next_registry_open', async () => {
    const persistenceRoot = await root();
    const homeId = '0123456789abcdef0123456789abcdee';
    const homePath = join(persistenceRoot, 'homes', homeId);
    await mkdir(homePath, { recursive: true, mode: 0o700 });
    await writeFile(join(homePath, 'sentinel'), 'expired', { mode: 0o600 });
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({
        version: 1,
        records: [{
          ...owner,
          homeId,
          status: 'deleting',
          threadId: 'thr_deleting',
          createdAt: 100,
          lastUsedAt: 100,
          bindingAudits: [{ sessionKey: 'expired', at: 100 }],
        }],
      }),
      { mode: 0o600 },
    );

    await ConversationRegistry.open(persistenceRoot);

    await expect(stat(homePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8')).records,
    ).toEqual([]);
  });

  it('should_clear_a_deleting_tombstone_when_its_home_was_already_removed', async () => {
    const persistenceRoot = await root();
    const homeId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({
        version: 1,
        records: [{
          ...owner,
          homeId,
          status: 'deleting',
          threadId: 'thr_already_deleted',
          createdAt: 100,
          lastUsedAt: 100,
          bindingAudits: [{ sessionKey: 'expired', at: 100 }],
        }],
      }),
      { mode: 0o600 },
    );
    const reconcileRemoteViewer = vi.fn(async () => undefined);

    await ConversationRegistry.open(persistenceRoot, { reconcileRemoteViewer });

    expect(reconcileRemoteViewer).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8')).records,
    ).toEqual([]);
  });

  it('should_stop_a_persisted_viewer_before_removing_a_deleting_home', async () => {
    const persistenceRoot = await root();
    const homeId = '0123456789abcdef0123456789abcdef';
    const homePath = join(persistenceRoot, 'homes', homeId);
    const runtimeDir = join(homePath, 'agent-nexus-runtime', 'remote-viewer');
    const metadataPath = join(runtimeDir, 'codex-remote-viewer-owner.json');
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(metadataPath, '{"viewer":"possibly-live"}', { mode: 0o600 });
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({
        version: 1,
        records: [{
          ...owner,
          homeId,
          status: 'deleting',
          threadId: 'thr_deleting_viewer',
          createdAt: 100,
          lastUsedAt: 100,
          bindingAudits: [{ sessionKey: 'expired', at: 100 }],
        }],
      }),
      { mode: 0o600 },
    );
    const order: string[] = [];

    await ConversationRegistry.open(persistenceRoot, {
      reconcileRemoteViewer: async (candidate, binding) => {
        expect(candidate).toBe(homePath);
        expect(binding).toEqual({ homeId, threadId: 'thr_deleting_viewer' });
        await expect(readFile(metadataPath, 'utf8')).resolves.toContain('possibly-live');
        order.push('viewer');
      },
      removePath: async (path, options) => {
        if (path === homePath) order.push('home');
        await rm(path, options);
      },
    });

    expect(order).toEqual(['viewer', 'home']);
  });

  it('should_preserve_a_deleting_home_when_viewer_reconciliation_fails', async () => {
    const persistenceRoot = await root();
    const homeId = 'fedcba9876543210fedcba9876543210';
    const homePath = join(persistenceRoot, 'homes', homeId);
    const runtimeDir = join(homePath, 'agent-nexus-runtime', 'remote-viewer');
    const metadataPath = join(runtimeDir, 'codex-remote-viewer-owner.json');
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(metadataPath, '{"viewer":"possibly-live"}', { mode: 0o600 });
    await writeFile(
      join(persistenceRoot, 'registry.json'),
      JSON.stringify({
        version: 1,
        records: [{
          ...owner,
          homeId,
          status: 'deleting',
          threadId: 'thr_deleting_viewer_failure',
          createdAt: 100,
          lastUsedAt: 100,
          bindingAudits: [{ sessionKey: 'expired', at: 100 }],
        }],
      }),
      { mode: 0o600 },
    );
    const viewerError = new Error('viewer cleanup failed');
    let homeRemovalAttempted = false;

    await expect(ConversationRegistry.open(persistenceRoot, {
      reconcileRemoteViewer: async () => { throw viewerError; },
      removePath: async (path, options) => {
        if (path === homePath) homeRemovalAttempted = true;
        await rm(path, options);
      },
    })).rejects.toBe(viewerError);

    expect(homeRemovalAttempted).toBe(false);
    await expect(readFile(metadataPath, 'utf8')).resolves.toContain('possibly-live');
  });

  it('should_collect_only_expired_committed_homes_without_a_live_lease', async () => {
    const registry = await ConversationRegistry.open(await root());
    const expired = await registry.createProvisional(owner, 'expired');
    await registry.commit(expired.homeId, 'thr_expired', 100);
    const live = await registry.createProvisional(owner, 'live');
    await registry.commit(live.homeId, 'thr_live', 100);
    const recent = await registry.createProvisional(owner, 'recent');
    await registry.commit(recent.homeId, 'thr_recent', 99_950);
    const release = await registry.acquireLive(live.homeId);

    await expect(registry.collectExpired(60_000, 100_000)).resolves.toEqual({
      deletedHomeIds: [expired.homeId],
    });
    await expect(stat(expired.homePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(registry.resolve('thr_live', owner)).resolves.toBeDefined();
    await expect(registry.resolve('thr_recent', owner)).resolves.toBeDefined();

    release();
    await expect(registry.collectExpired(60_000, 100_000)).resolves.toEqual({
      deletedHomeIds: [live.homeId],
    });
  });

  it('should_fail_closed_when_thread_owner_does_not_match', async () => {
    const registry = await ConversationRegistry.open(await root());
    const created = await registry.createProvisional(owner, '["p","lark","c","u"]');
    await registry.commit(created.homeId, 'thr_owned', 100);

    await expect(
      registry.resolve('thr_owned', { ...owner, agentName: 'other' }),
    ).rejects.toThrow(/owner|归属/);
  });

  it('should_use_unambiguous_json_tuple_for_session_key_audit', () => {
    expect(
      encodeSessionKeyAudit({
        platformName: 'a:b',
        platform: 'lark',
        channelId: 'c:d',
        initiatorUserId: 'u',
      }),
    ).toBe('["a:b","lark","c:d","u"]');
    expect(
      encodeSessionKeyAudit({
        platformName: 'a',
        platform: 'b:lark',
        channelId: 'c:d',
        initiatorUserId: 'u',
      }),
    ).not.toBe('["a:b","lark","c:d","u"]');
  });
});
