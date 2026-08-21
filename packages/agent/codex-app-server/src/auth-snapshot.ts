import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';

const MAX_AUTH_BYTES = 1_048_576;

interface AuthSnapshotMetadata {
  version: 1;
  digest: string;
  size: number;
  sourceMtimeMs: number;
}

export class AuthSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthSnapshotError';
  }
}

export class AuthSnapshotManager {
  private readonly sourcePath: string;
  private readonly destinationPath: string;
  private readonly metadataPath: string;
  private readonly stalePath: string;

  constructor(
    private readonly sourceCodexHome: string,
    private readonly conversationHome: string,
  ) {
    this.sourcePath = join(sourceCodexHome, 'auth.json');
    this.destinationPath = join(conversationHome, 'auth.json');
    this.metadataPath = join(conversationHome, 'auth-source.json');
    this.stalePath = join(conversationHome, 'auth-stale');
  }

  async prepare(): Promise<AuthSnapshotMetadata> {
    const seeded = await this.seedIfMissing();
    if (!(await this.exists(this.stalePath))) return seeded;
    const current = await this.rotateIfChanged();
    await rm(this.stalePath);
    return current;
  }

  async markStale(): Promise<void> {
    await this.validateDirectories();
    await this.atomicWrite(this.stalePath, new TextEncoder().encode('stale\n'));
  }

  async seedIfMissing(): Promise<AuthSnapshotMetadata> {
    await this.validateDirectories();
    if (await this.exists(this.destinationPath)) {
      await this.validateExistingDestination();
      return this.readMetadata();
    }
    const source = await this.readSafeSource();
    await this.writeSnapshot(source.content, source.metadata);
    return source.metadata;
  }

  async rotateIfChanged(): Promise<AuthSnapshotMetadata> {
    await this.validateDirectories();
    const previous = await this.readMetadata();
    const source = await this.readSafeSource();
    if (source.metadata.digest === previous.digest) {
      throw new AuthSnapshotError('source auth digest 未变化，拒绝重复 rotation');
    }
    await this.writeSnapshot(source.content, source.metadata);
    return source.metadata;
  }

  private async readSafeSource(): Promise<{
    content: Uint8Array;
    metadata: AuthSnapshotMetadata;
  }> {
    const before = await lstat(this.sourcePath);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new AuthSnapshotError('source auth.json 必须是非 symlink regular file');
    }
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && before.uid !== currentUid) {
      throw new AuthSnapshotError('source auth.json owner 不是当前 uid');
    }
    if ((before.mode & 0o077) !== 0) {
      throw new AuthSnapshotError('source auth.json 不得有 group/world 权限');
    }
    if (before.size < 1 || before.size > MAX_AUTH_BYTES) {
      throw new AuthSnapshotError(`source auth.json 大小必须为 1..${MAX_AUTH_BYTES}`);
    }

    const noFollow = constants.O_NOFOLLOW ?? 0;
    let handle;
    try {
      handle = await open(this.sourcePath, constants.O_RDONLY | noFollow);
    } catch {
      throw new AuthSnapshotError('无法安全打开 source auth.json');
    }
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      ) {
        throw new AuthSnapshotError('source auth.json 在校验与读取间发生变化');
      }
      const content = new Uint8Array(await handle.readFile());
      this.validateAuthJson(content);
      return {
        content,
        metadata: {
          version: 1,
          digest: createHash('sha256').update(content).digest('hex'),
          size: content.byteLength,
          sourceMtimeMs: opened.mtimeMs,
        },
      };
    } finally {
      await handle.close();
    }
  }

  private validateAuthJson(content: Uint8Array): void {
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    } catch {
      throw new AuthSnapshotError('source auth.json 必须是合法 UTF-8 JSON object');
    }
  }

  private async validateExistingDestination(): Promise<void> {
    let before;
    try {
      before = await lstat(this.destinationPath);
    } catch {
      throw new AuthSnapshotError('durable auth.json 无法安全校验');
    }
    const currentUid = process.getuid?.();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (before.mode & 0o777) !== 0o600 ||
      (currentUid !== undefined && before.uid !== currentUid) ||
      before.size < 1 ||
      before.size > MAX_AUTH_BYTES
    ) {
      throw new AuthSnapshotError('durable auth.json 必须是当前 uid 的 private regular file');
    }
    const noFollow = constants.O_NOFOLLOW ?? 0;
    let handle;
    try {
      handle = await open(this.destinationPath, constants.O_RDONLY | noFollow);
    } catch {
      throw new AuthSnapshotError('无法安全打开 durable auth.json');
    }
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        (opened.mode & 0o777) !== 0o600 ||
        (currentUid !== undefined && opened.uid !== currentUid)
      ) {
        throw new AuthSnapshotError('durable auth.json 在校验与读取间发生变化');
      }
      this.validateAuthJson(new Uint8Array(await handle.readFile()));
    } finally {
      await handle.close();
    }
  }

  private async writeSnapshot(
    content: Uint8Array,
    metadata: AuthSnapshotMetadata,
  ): Promise<void> {
    await this.atomicWrite(this.destinationPath, content);
    await this.atomicWrite(
      this.metadataPath,
      new TextEncoder().encode(`${JSON.stringify(metadata)}\n`),
    );
  }

  private async atomicWrite(path: string, content: Uint8Array): Promise<void> {
    const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  private async readMetadata(): Promise<AuthSnapshotMetadata> {
    try {
      const value = JSON.parse(await readFile(this.metadataPath, 'utf8')) as Partial<AuthSnapshotMetadata>;
      if (
        value.version !== 1 ||
        typeof value.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.digest) ||
        typeof value.size !== 'number' ||
        typeof value.sourceMtimeMs !== 'number'
      ) {
        throw new Error('invalid');
      }
      return value as AuthSnapshotMetadata;
    } catch {
      throw new AuthSnapshotError('durable auth metadata 缺失或非法');
    }
  }

  private async validateDirectories(): Promise<void> {
    for (const [name, path] of [
      ['sourceCodexHome', this.sourceCodexHome],
      ['conversationHome', this.conversationHome],
    ] as const) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new AuthSnapshotError(`${name} 必须是非 symlink directory`);
      }
      const currentUid = process.getuid?.();
      if (currentUid !== undefined && info.uid !== currentUid) {
        throw new AuthSnapshotError(`${name} owner 不是当前 uid`);
      }
      const disallowedBits = name === 'sourceCodexHome' ? 0o022 : 0o077;
      if ((info.mode & disallowedBits) !== 0) {
        throw new AuthSnapshotError(
          name === 'sourceCodexHome'
            ? `${name} 不得允许 group/world 写入`
            : `${name} 不得有 group/world 权限`,
        );
      }
      if ((await realpath(path)) !== path) {
        throw new AuthSnapshotError(`${name} 必须是 canonical path`);
      }
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
