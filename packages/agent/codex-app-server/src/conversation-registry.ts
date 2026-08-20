import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SessionKey } from '@agent-nexus/protocol';
import { reconcileRemoteAppServerAuth } from './remote-auth.js';

export interface ConversationOwner {
  backend: 'codex-app-server';
  agentName: string;
}

interface RegistryRecord extends ConversationOwner {
  homeId: string;
  status: 'creating' | 'committed' | 'deleting';
  threadId: string | null;
  createdAt: number;
  lastUsedAt: number;
  bindingAudits: Array<{ sessionKey: string; at: number }>;
}

interface RegistryFile {
  version: 1;
  records: RegistryRecord[];
}

export interface ConversationHome {
  homeId: string;
  homePath: string;
  threadId: string;
}

export interface ConversationRegistryDependencies {
  createNonce?: () => string;
  pidIsAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string;
  beforeAtomicRename?: (path: string) => Promise<void>;
  removePath?: (
    path: string,
    options: { recursive: boolean; force: boolean },
  ) => Promise<void>;
  reconcileRemoteViewer?: (
    conversationHome: string,
    binding: { homeId: string; threadId: string },
  ) => Promise<void>;
}

export interface ConversationRegistryLease {
  leasePath: string;
  nonce: string;
  release(): Promise<void>;
}

interface RegistryLeaseOwner {
  version: 1;
  pid: number;
  processIdentity: string;
  nonce: string;
  createdAt: number;
}

const CURRENT_PROCESS_FALLBACK_IDENTITY =
  `self:${process.pid}:${Date.now()}:${randomBytes(16).toString('hex')}`;

export class ConversationRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationRegistryError';
  }
}

export function encodeSessionKeyAudit(key: SessionKey): string {
  return JSON.stringify([
    key.platformName,
    key.platform,
    key.channelId,
    key.initiatorUserId,
  ]);
}

export function assertSupportedPrivateFilesystemPlatform(
  platform: NodeJS.Platform = process.platform,
): void {
  if (
    (platform !== 'darwin' && platform !== 'linux') ||
    typeof process.getuid !== 'function'
  ) {
    throw new ConversationRegistryError(
      `platform ${platform} 无法证明 POSIX private-directory 边界`,
    );
  }
}

export async function acquireConversationRegistryLease(
  persistenceRoot: string,
  dependencies: ConversationRegistryDependencies = {},
): Promise<ConversationRegistryLease> {
  assertSupportedPrivateFilesystemPlatform();
  const locksRoot = join(persistenceRoot, '.registry-locks');
  await ensurePrivateDirectory(locksRoot);
  const nonce = dependencies.createNonce?.() ?? randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/.test(nonce)) {
    throw new ConversationRegistryError('registry lease nonce 非法');
  }
  const processIdentity = dependencies.processIdentity ?? defaultProcessIdentity;
  const identity = processIdentity(process.pid);
  if (!identity) {
    throw new ConversationRegistryError('无法确认当前 registry owner 进程身份');
  }
  const leasePath = join(locksRoot, nonce);
  await mkdir(leasePath, { mode: 0o700 });
  const owner: RegistryLeaseOwner = {
    version: 1,
    pid: process.pid,
    processIdentity: identity,
    nonce,
    createdAt: Date.now(),
  };
  try {
    await writeFile(join(leasePath, 'owner.json'), `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    await rm(leasePath, { recursive: true, force: true });
    throw error;
  }

  const release = async (): Promise<void> => {
    await releaseRegistryLease(leasePath, nonce);
  };
  try {
    const pidIsAlive = dependencies.pidIsAlive ?? defaultPidIsAlive;
    for (const entry of await readdir(locksRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) {
        throw new ConversationRegistryError('registry lease 目录包含非法条目');
      }
      const candidatePath = join(locksRoot, entry.name);
      if (candidatePath === leasePath) continue;
      let candidate: RegistryLeaseOwner;
      try {
        candidate = await readRegistryLeaseOwner(candidatePath, entry.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (pidIsAlive(candidate.pid)) {
        const actualIdentity = processIdentity(candidate.pid);
        if (!actualIdentity || actualIdentity === candidate.processIdentity) {
          throw new ConversationRegistryError(
            `registry lease 已由存活进程 pid=${candidate.pid} 持有`,
          );
        }
      }
      // Each lease has an immutable random path, so stale owners and competing
      // reclaimers can only remove that exact generation, never a successor.
      await rm(candidatePath, { recursive: true, force: true });
    }
    return { leasePath, nonce, release };
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'registry lease acquisition and rollback both failed',
      );
    }
    throw error;
  }
}

export class ConversationRegistry {
  private static readonly instances = new Map<string, Promise<ConversationRegistry>>();
  private static readonly ownedLeases = new Map<string, string>();
  private static exitHookRegistered = false;
  private readonly homesPath: string;
  private readonly registryPath: string;
  private readonly liveHomeIds = new Set<string>();
  private operationTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly persistenceRoot: string,
    private data: RegistryFile,
    private readonly dependencies: ConversationRegistryDependencies,
  ) {
    this.homesPath = join(persistenceRoot, 'homes');
    this.registryPath = join(persistenceRoot, 'registry.json');
  }

  static async open(
    persistenceRoot: string,
    dependencies: ConversationRegistryDependencies = {},
  ): Promise<ConversationRegistry> {
    assertSupportedPrivateFilesystemPlatform();
    await ensurePrivateDirectory(persistenceRoot);
    const canonicalRoot = await realpath(persistenceRoot);
    if (canonicalRoot !== persistenceRoot) {
      throw new ConversationRegistryError('persistenceRoot 必须是 canonical path');
    }
    const existing = ConversationRegistry.instances.get(canonicalRoot);
    if (existing) return existing;
    const opening = ConversationRegistry.openExclusive(canonicalRoot, dependencies);
    ConversationRegistry.instances.set(canonicalRoot, opening);
    try {
      return await opening;
    } catch (error) {
      ConversationRegistry.instances.delete(canonicalRoot);
      throw error;
    }
  }

  private static async openExclusive(
    persistenceRoot: string,
    dependencies: ConversationRegistryDependencies,
  ): Promise<ConversationRegistry> {
    const lease = await acquireConversationRegistryLease(persistenceRoot, dependencies);
    try {
      const homesPath = join(persistenceRoot, 'homes');
      await ensurePrivateDirectory(homesPath);
      const registryPath = join(persistenceRoot, 'registry.json');
      let data: RegistryFile;
      try {
        data = ConversationRegistry.parse(await readFile(registryPath, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        data = { version: 1, records: [] };
      }
      const registry = new ConversationRegistry(persistenceRoot, data, dependencies);
      await registry.reconcileCreating();
      await registry.reconcileDeleting();
      await registry.reconcileRemoteAuthArtifacts();
      if ((await registry.exists(registryPath)) === false) await registry.persist();
      ConversationRegistry.retainProcessLease(lease);
      return registry;
    } catch (error) {
      try {
        await lease.release();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'registry open and lease rollback both failed',
        );
      }
      throw error;
    }
  }

  private static retainProcessLease(lease: ConversationRegistryLease): void {
    if (ConversationRegistry.ownedLeases.has(lease.leasePath)) return;
    ConversationRegistry.ownedLeases.set(lease.leasePath, lease.nonce);
    if (ConversationRegistry.exitHookRegistered) return;
    ConversationRegistry.exitHookRegistered = true;
    process.once('exit', () => {
      for (const [leasePath, nonce] of ConversationRegistry.ownedLeases) {
        releaseRegistryLeaseSync(leasePath, nonce);
      }
    });
  }

  async createProvisional(
    owner: ConversationOwner,
    sessionKeyAudit: string,
  ): Promise<{ homeId: string; homePath: string }> {
    return this.serialize(async () => {
      const homeId = randomBytes(16).toString('hex');
      const homePath = join(this.homesPath, homeId);
      const now = Date.now();
      const record: RegistryRecord = {
        ...owner,
        homeId,
        status: 'creating',
        threadId: null,
        createdAt: now,
        lastUsedAt: now,
        bindingAudits: [{ sessionKey: sessionKeyAudit, at: now }],
      };
      this.data.records.push(record);
      try {
        await this.persist();
      } catch (error) {
        this.data.records.pop();
        throw error;
      }
      try {
        await mkdir(homePath, { mode: 0o700 });
        await this.writeOwner(homePath, record);
        return { homeId, homePath };
      } catch (error) {
        try {
          await this.removePath(homePath);
          const index = this.data.records.findIndex(
            (candidate) => candidate.homeId === homeId && candidate.status === 'creating',
          );
          if (index < 0) {
            throw new ConversationRegistryError(`creating home ${homeId} 不存在`);
          }
          const [removed] = this.data.records.splice(index, 1);
          try {
            await this.persist();
          } catch (persistError) {
            this.data.records.splice(index, 0, removed!);
            throw persistError;
          }
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'provisional home creation and rollback both failed',
          );
        }
        throw error;
      }
    });
  }

  async commit(homeId: string, threadId: string, at = Date.now()): Promise<void> {
    await this.serialize(async () => {
      if (!threadId) throw new ConversationRegistryError('threadId 必须是非空字符串');
      if (this.data.records.some((record) => record.threadId === threadId)) {
        throw new ConversationRegistryError(`threadId ${threadId} 已存在`);
      }
      const record = this.data.records.find((candidate) => candidate.homeId === homeId);
      if (!record || record.status !== 'creating') {
        throw new ConversationRegistryError(`creating home ${homeId} 不存在`);
      }
      const previous = { ...record };
      record.status = 'committed';
      record.threadId = threadId;
      record.lastUsedAt = at;
      try {
        await this.writeOwner(join(this.homesPath, homeId), record);
        await this.persist();
      } catch (error) {
        Object.assign(record, previous);
        await this.writeOwner(join(this.homesPath, homeId), record).catch(() => undefined);
        throw error;
      }
    });
  }

  async discardProvisional(homeId: string): Promise<void> {
    await this.serialize(async () => {
      const index = this.data.records.findIndex(
        (record) => record.homeId === homeId && record.status === 'creating',
      );
      if (index < 0) {
        throw new ConversationRegistryError(`creating home ${homeId} 不存在`);
      }
      await this.removePath(join(this.homesPath, homeId));
      const [record] = this.data.records.splice(index, 1);
      try {
        await this.persist();
      } catch (error) {
        this.data.records.splice(index, 0, record!);
        throw error;
      }
    });
  }

  async resolve(threadId: string, owner: ConversationOwner): Promise<ConversationHome> {
    return this.serialize(async () => {
      const record = this.data.records.find(
        (candidate) => candidate.status === 'committed' && candidate.threadId === threadId,
      );
      if (!record) throw new ConversationRegistryError(`thread ${threadId} 未登记`);
      if (record.backend !== owner.backend || record.agentName !== owner.agentName) {
        throw new ConversationRegistryError(`thread ${threadId} owner 归属不匹配`);
      }
      const homePath = join(this.homesPath, record.homeId);
      const metadata = ConversationRegistry.parseOwner(
        await readFile(join(homePath, 'owner.json'), 'utf8'),
      );
      if (
        metadata.homeId !== record.homeId ||
        metadata.threadId !== threadId ||
        metadata.backend !== owner.backend ||
        metadata.agentName !== owner.agentName
      ) {
        throw new ConversationRegistryError(`thread ${threadId} home metadata 不匹配`);
      }
      return { homeId: record.homeId, homePath, threadId };
    });
  }

  async recordBindingAudit(threadId: string, sessionKeyAudit: string, at: number): Promise<void> {
    await this.serialize(async () => {
      const record = this.data.records.find(
        (candidate) => candidate.status === 'committed' && candidate.threadId === threadId,
      );
      if (!record) throw new ConversationRegistryError(`thread ${threadId} 未登记`);
      const previousAuditCount = record.bindingAudits.length;
      const previousLastUsedAt = record.lastUsedAt;
      record.bindingAudits.push({ sessionKey: sessionKeyAudit, at });
      record.lastUsedAt = at;
      try {
        await this.persist();
      } catch (error) {
        record.bindingAudits.splice(previousAuditCount);
        record.lastUsedAt = previousLastUsedAt;
        throw error;
      }
    });
  }

  async touch(threadId: string, at = Date.now()): Promise<void> {
    await this.serialize(async () => {
      const record = this.data.records.find(
        (candidate) => candidate.status === 'committed' && candidate.threadId === threadId,
      );
      if (!record) throw new ConversationRegistryError(`thread ${threadId} 未登记`);
      const previousLastUsedAt = record.lastUsedAt;
      record.lastUsedAt = at;
      try {
        await this.persist();
      } catch (error) {
        record.lastUsedAt = previousLastUsedAt;
        throw error;
      }
    });
  }

  async acquireLive(homeId: string): Promise<() => void> {
    return this.serialize(() => {
      const record = this.data.records.find(
        (candidate) => candidate.status === 'committed' && candidate.homeId === homeId,
      );
      if (!record) throw new ConversationRegistryError(`committed home ${homeId} 不存在`);
      if (this.liveHomeIds.has(homeId)) {
        throw new ConversationRegistryError(`committed home ${homeId} 已有 live owner`);
      }
      this.liveHomeIds.add(homeId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.liveHomeIds.delete(homeId);
      };
    });
  }

  async collectExpired(
    retentionMs: number,
    now = Date.now(),
  ): Promise<{ deletedHomeIds: string[] }> {
    return this.serialize(async () => {
      if (!Number.isSafeInteger(retentionMs) || retentionMs < 60_000) {
        throw new ConversationRegistryError('retentionMs 必须是至少 60000 的整数');
      }
      const deletedHomeIds = await this.reconcileDeleting();
      const expired = this.data.records.filter(
        (record) =>
          record.status === 'committed' &&
          record.lastUsedAt < now - retentionMs &&
          !this.liveHomeIds.has(record.homeId),
      );
      if (expired.length === 0) return { deletedHomeIds };
      for (const record of expired) record.status = 'deleting';
      try {
        await this.persist();
      } catch (error) {
        for (const record of expired) record.status = 'committed';
        throw error;
      }
      deletedHomeIds.push(...await this.reconcileDeleting());
      return { deletedHomeIds };
    });
  }

  private async reconcileCreating(): Promise<void> {
    const creating = this.data.records.filter((record) => record.status === 'creating');
    if (creating.length === 0) return;
    for (const record of creating) {
      await this.removePath(join(this.homesPath, record.homeId));
    }
    this.data.records = this.data.records.filter((record) => record.status !== 'creating');
    await this.persist();
  }

  private async reconcileDeleting(): Promise<string[]> {
    const deleting = this.data.records.filter((record) => record.status === 'deleting');
    if (deleting.length === 0) return [];
    for (const record of deleting) {
      const homePath = join(this.homesPath, record.homeId);
      if (await this.exists(homePath)) {
        await this.reconcileRemoteViewerArtifacts(record, homePath);
        await this.removePath(homePath);
      }
    }
    const deletingIds = new Set(deleting.map((record) => record.homeId));
    const previous = this.data.records;
    this.data.records = previous.filter((record) => !deletingIds.has(record.homeId));
    try {
      await this.persist();
    } catch (error) {
      // Keep the durable tombstones visible in memory so an in-process retry
      // follows the same path as startup reconciliation.
      this.data.records = previous;
      throw error;
    }
    return deleting.map((record) => record.homeId);
  }

  private async reconcileRemoteAuthArtifacts(): Promise<void> {
    for (const record of this.data.records) {
      if (record.status !== 'committed') continue;
      const homePath = join(this.homesPath, record.homeId);
      const metadata = ConversationRegistry.parseOwner(
        await readFile(join(homePath, 'owner.json'), 'utf8'),
      );
      if (
        metadata.homeId !== record.homeId ||
        metadata.status !== 'committed' ||
        metadata.threadId !== record.threadId ||
        metadata.backend !== record.backend ||
        metadata.agentName !== record.agentName
      ) {
        throw new ConversationRegistryError('committed home metadata 不匹配');
      }
      await this.reconcileRemoteViewerArtifacts(record, homePath);
      await reconcileRemoteAppServerAuth(homePath, {
        ...(this.dependencies.removePath === undefined
          ? {}
          : { remove: this.dependencies.removePath }),
      });
    }
  }

  private async reconcileRemoteViewerArtifacts(
    record: RegistryRecord,
    homePath: string,
  ): Promise<void> {
    if (!record.threadId) {
      if (await this.hasPersistedRemoteViewer(homePath)) {
        throw new ConversationRegistryError('persisted remote viewer has no thread binding');
      }
      return;
    }
    if (this.dependencies.reconcileRemoteViewer) {
      await this.dependencies.reconcileRemoteViewer(homePath, {
        homeId: record.homeId,
        threadId: record.threadId,
      });
    } else if (await this.hasPersistedRemoteViewer(homePath)) {
      throw new ConversationRegistryError(
        'persisted remote viewer requires an available reconciler',
      );
    }
  }

  private async hasPersistedRemoteViewer(homePath: string): Promise<boolean> {
    const runtimeRoot = join(homePath, 'agent-nexus-runtime');
    let entries;
    try {
      entries = await readdir(runtimeRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith('remote-')) continue;
      if (await this.exists(join(runtimeRoot, entry.name, 'codex-remote-viewer-owner.json'))) {
        return true;
      }
    }
    return false;
  }

  private removePath(path: string): Promise<void> {
    return (this.dependencies.removePath ?? rm)(path, { recursive: true, force: true });
  }

  private serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(): Promise<void> {
    await this.atomicJson(this.registryPath, this.data);
  }

  private async writeOwner(homePath: string, record: RegistryRecord): Promise<void> {
    await this.atomicJson(join(homePath, 'owner.json'), record);
  }

  private async atomicJson(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temporary, 0o600);
      await this.dependencies.beforeAtomicRename?.(path);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private static parse(raw: string): RegistryFile {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ConversationRegistryError('registry JSON 非法');
    }
    if (!isObject(value) || value['version'] !== 1 || !Array.isArray(value['records'])) {
      throw new ConversationRegistryError('registry schema 非法');
    }
    const records = value['records'].map((candidate, index) =>
      ConversationRegistry.validateRecord(candidate, `registry.records[${index}]`),
    );
    const homeIds = records.map((record) => record.homeId);
    const threadIds = records.flatMap((record) => record.threadId ? [record.threadId] : []);
    if (new Set(homeIds).size !== homeIds.length || new Set(threadIds).size !== threadIds.length) {
      throw new ConversationRegistryError('registry homeId/threadId 重复');
    }
    return { version: 1, records };
  }

  private static parseOwner(raw: string): RegistryRecord {
    try {
      return ConversationRegistry.validateRecord(JSON.parse(raw), 'owner metadata');
    } catch (error) {
      if (error instanceof ConversationRegistryError) throw error;
      throw new ConversationRegistryError('owner metadata JSON 非法');
    }
  }

  private static validateRecord(value: unknown, path: string): RegistryRecord {
    if (!isObject(value)) throw new ConversationRegistryError(`${path} 非法`);
    const homeId = value['homeId'];
    const backend = value['backend'];
    const agentName = value['agentName'];
    const status = value['status'];
    const threadId = value['threadId'];
    const createdAt = value['createdAt'];
    const lastUsedAt = value['lastUsedAt'];
    const bindingAudits = value['bindingAudits'];
    if (
      typeof homeId !== 'string' || !/^[a-f0-9]{32}$/.test(homeId) ||
      backend !== 'codex-app-server' ||
      typeof agentName !== 'string' || agentName.length === 0 ||
      (status !== 'creating' && status !== 'committed' && status !== 'deleting') ||
      (status === 'creating' ? threadId !== null : typeof threadId !== 'string' || threadId.length === 0) ||
      typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0 ||
      typeof lastUsedAt !== 'number' || !Number.isSafeInteger(lastUsedAt) || lastUsedAt < 0 ||
      !Array.isArray(bindingAudits)
    ) {
      throw new ConversationRegistryError(`${path} schema 非法`);
    }
    const audits = bindingAudits.map((audit, index) => {
      if (
        !isObject(audit) ||
        typeof audit['sessionKey'] !== 'string' ||
        typeof audit['at'] !== 'number' ||
        !Number.isSafeInteger(audit['at']) ||
        audit['at'] < 0
      ) {
        throw new ConversationRegistryError(`${path}.bindingAudits[${index}] schema 非法`);
      }
      return { sessionKey: audit['sessionKey'], at: audit['at'] };
    });
    return {
      backend,
      agentName,
      homeId,
      status,
      threadId: threadId as string | null,
      createdAt,
      lastUsedAt,
      bindingAudits: audits,
    };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readRegistryLeaseOwner(
  leasePath: string,
  expectedNonce: string,
): Promise<RegistryLeaseOwner> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(leasePath, 'owner.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new ConversationRegistryError('registry lease owner metadata 非法');
  }
  if (
    !isObject(value) ||
    value['version'] !== 1 ||
    !Number.isSafeInteger(value['pid']) ||
    (value['pid'] as number) <= 0 ||
    typeof value['processIdentity'] !== 'string' ||
    value['processIdentity'].length === 0 ||
    value['nonce'] !== expectedNonce ||
    !Number.isSafeInteger(value['createdAt']) ||
    (value['createdAt'] as number) < 0
  ) {
    throw new ConversationRegistryError('registry lease owner metadata 非法');
  }
  return value as unknown as RegistryLeaseOwner;
}

async function releaseRegistryLease(leasePath: string, nonce: string): Promise<void> {
  try {
    const owner = await readRegistryLeaseOwner(leasePath, nonce);
    if (owner.nonce !== nonce) return;
    await rm(leasePath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function releaseRegistryLeaseSync(leasePath: string, nonce: string): void {
  try {
    const value = JSON.parse(readFileSync(join(leasePath, 'owner.json'), 'utf8')) as {
      nonce?: unknown;
    };
    if (value.nonce === nonce) rmSync(leasePath, { recursive: true, force: true });
  } catch {
    // Missing or replaced leases are not owned by this process anymore.
  }
}

function defaultPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultProcessIdentity(pid: number): string {
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    if (started) return `${pid}:${started}`;
  } catch {
    // Fall through to the self-only identity. Other live PIDs remain
    // unverifiable and therefore fail closed during lease acquisition.
  }
  return pid === process.pid ? CURRENT_PROCESS_FALLBACK_IDENTITY : '';
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  if (resolve(path) !== path) {
    throw new ConversationRegistryError('managed path 必须是 absolute canonical path');
  }
  if (dirname(path) === path) {
    throw new ConversationRegistryError('managed path 不能是 filesystem root');
  }
  const components: string[] = [];
  for (let candidate = path; ; candidate = dirname(candidate)) {
    components.push(candidate);
    if (dirname(candidate) === candidate) break;
  }
  components.reverse();

  // Recursive mkdir follows ancestor symlinks before the caller can validate
  // realpath. Walk one component at a time so no out-of-root path is created
  // or chmodded before every existing ancestor has passed lstat.
  for (const candidate of components) {
    let created = false;
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await mkdir(candidate, { mode: 0o700 });
        created = true;
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      info = await lstat(candidate);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ConversationRegistryError(
        'managed path must be a private directory, not a symlink',
      );
    }
    if (await realpath(candidate) !== candidate) {
      throw new ConversationRegistryError('managed path 必须是 canonical path');
    }
    if (!created && candidate !== path) continue;
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && info.uid !== currentUid) {
      throw new ConversationRegistryError('managed private directory owner 不是当前 uid');
    }
    await chmod(candidate, 0o700);
  }
}
