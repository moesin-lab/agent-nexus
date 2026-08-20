import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export const CODEX_REMOTE_TOKEN_ENV = 'AGENT_NEXUS_CODEX_REMOTE_TOKEN';
const RUNTIME_DIRECTORY = 'agent-nexus-runtime';

export interface RemoteAppServerAuth {
  endpoint: 'ws://127.0.0.1:0';
  appServerIncarnationId: string;
  token: string;
  tokenEnvName: typeof CODEX_REMOTE_TOKEN_ENV;
  tokenFile: string;
  runtimeDir: string;
  serverArgs: string[];
  revoke(): Promise<void>;
  dispose(): Promise<void>;
}

export interface RemoteAppServerAuthDependencies {
  remove?: (
    path: string,
    options: { recursive: boolean; force: boolean },
  ) => Promise<void>;
  writeTokenFile?: (path: string, token: string) => Promise<void>;
}

export async function createRemoteAppServerAuth(
  conversationHome: string,
  dependencies: RemoteAppServerAuthDependencies = {},
): Promise<RemoteAppServerAuth> {
  const canonicalHome = await validatePrivateConversationHome(conversationHome);
  const runtimeRoot = join(canonicalHome, RUNTIME_DIRECTORY);
  await mkdir(runtimeRoot, { mode: 0o700, recursive: true });
  const runtimeRootStat = await lstat(runtimeRoot);
  if (runtimeRootStat.isSymbolicLink() || !runtimeRootStat.isDirectory()) {
    throw new Error('remote runtime root is not a private directory');
  }
  if (typeof process.getuid === 'function' && runtimeRootStat.uid !== process.getuid()) {
    throw new Error('remote runtime root must belong to the current uid');
  }
  await chmod(runtimeRoot, 0o700);

  const remove = dependencies.remove ?? rm;
  let runtimeDir: string | null = null;
  try {
    runtimeDir = await mkdtemp(join(runtimeRoot, 'remote-'));
    await chmod(runtimeDir, 0o700);
    assertDescendant(canonicalHome, runtimeDir);
    const token = randomBytes(32).toString('base64url');
    const tokenFile = join(runtimeDir, 'capability-token');
    await (dependencies.writeTokenFile ?? writePrivateTokenFile)(tokenFile, token);
    if (((await stat(tokenFile)).mode & 0o777) !== 0o600) {
      throw new Error('remote capability token file is not private');
    }

    const endpoint = 'ws://127.0.0.1:0' as const;
    const appServerIncarnationId = randomBytes(16).toString('hex');
    const createdRuntimeDir = runtimeDir;
    let revoked = false;
    let revocation: Promise<void> | null = null;
    let disposed = false;
    let disposal: Promise<void> | null = null;
    return {
      endpoint,
      appServerIncarnationId,
      token,
      tokenEnvName: CODEX_REMOTE_TOKEN_ENV,
      tokenFile,
      runtimeDir: createdRuntimeDir,
      serverArgs: [
        'app-server',
        '--listen',
        endpoint,
        '--ws-auth',
        'capability-token',
        '--ws-token-file',
        tokenFile,
      ],
      async revoke(): Promise<void> {
        if (revoked || disposed) return;
        if (revocation) return revocation;
        assertDescendant(createdRuntimeDir, tokenFile);
        revocation = remove(tokenFile, { recursive: false, force: true });
        try {
          await revocation;
          revoked = true;
        } finally {
          if (!revoked) revocation = null;
        }
      },
      async dispose(): Promise<void> {
        if (disposed) return;
        if (disposal) return disposal;
        assertDescendant(canonicalHome, createdRuntimeDir);
        disposal = remove(createdRuntimeDir, { recursive: true, force: true });
        try {
          await disposal;
          disposed = true;
          revoked = true;
        } finally {
          if (!disposed) disposal = null;
        }
      },
    };
  } catch (error) {
    if (runtimeDir) {
      try {
        await remove(runtimeDir, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'remote auth creation and rollback both failed',
        );
      }
    }
    throw error;
  }
}

async function writePrivateTokenFile(path: string, token: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${token}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function reconcileRemoteAppServerAuth(
  conversationHome: string,
  dependencies: RemoteAppServerAuthDependencies = {},
): Promise<void> {
  const canonicalHome = await validatePrivateConversationHome(conversationHome);
  const runtimeRoot = join(canonicalHome, RUNTIME_DIRECTORY);
  let runtimeRootStat;
  try {
    runtimeRootStat = await lstat(runtimeRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (runtimeRootStat.isSymbolicLink() || !runtimeRootStat.isDirectory()) {
    throw new Error('remote runtime root is not a private directory');
  }
  if ((runtimeRootStat.mode & 0o777) !== 0o700) {
    throw new Error('remote runtime root must have mode 0700');
  }
  if (typeof process.getuid === 'function' && runtimeRootStat.uid !== process.getuid()) {
    throw new Error('remote runtime root must belong to the current uid');
  }
  assertDescendant(canonicalHome, runtimeRoot);
  await (dependencies.remove ?? rm)(runtimeRoot, { recursive: true, force: true });
}

async function validatePrivateConversationHome(conversationHome: string): Promise<string> {
  const source = await lstat(conversationHome);
  if (source.isSymbolicLink()) throw new Error('conversation home must not be a symlink');
  if (!source.isDirectory()) throw new Error('conversation home must be a directory');
  if ((source.mode & 0o777) !== 0o700) throw new Error('conversation home must have mode 0700');
  if (typeof process.getuid === 'function' && source.uid !== process.getuid()) {
    throw new Error('conversation home must belong to the current uid');
  }
  return realpath(conversationHome);
}

function assertDescendant(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (!path || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error('remote runtime path escaped conversation home');
  }
}
