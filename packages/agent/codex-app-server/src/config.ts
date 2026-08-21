import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;

export type CodexAppServerSandbox = (typeof SANDBOX_MODES)[number];

export interface CodexAppServerConfig {
  bin: string;
  workingDir: string;
  sandbox: CodexAppServerSandbox;
  addDirs: string[];
  maxInputBytes: number;
  requestTimeoutMs: number;
  interruptGraceMs: number;
  terminateGraceMs: number;
  conversationRetentionMs: number | null;
  supplementalViewer: {
    enabled: boolean;
  };
}

export const DEFAULT_CODEX_APP_SERVER_CONFIG: Omit<
  CodexAppServerConfig,
  'workingDir'
> = {
  bin: 'codex',
  sandbox: 'read-only',
  addDirs: [],
  maxInputBytes: 262_144,
  requestTimeoutMs: 30_000,
  interruptGraceMs: 5_000,
  terminateGraceMs: 5_000,
  conversationRetentionMs: null,
  supplementalViewer: { enabled: false },
};

export class CodexAppServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAppServerConfigError';
  }
}

const ALLOWED_FIELDS = new Set([
  'bin',
  'workingDir',
  'sandbox',
  'addDirs',
  'maxInputBytes',
  'requestTimeoutMs',
  'interruptGraceMs',
  'terminateGraceMs',
  'conversationRetentionMs',
  'supplementalViewer',
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexAppServerConfigError('codexAppServer 必须是对象');
  }
  return value as Record<string, unknown>;
}

function canonicalDirectory(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new CodexAppServerConfigError(`字段 ${field} 必须是非空绝对路径`);
  }
  try {
    const canonical = realpathSync(value);
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new CodexAppServerConfigError(`字段 ${field} 必须指向已存在目录`);
  }
}

function integerInRange(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const candidate = value === undefined ? fallback : value;
  if (
    typeof candidate !== 'number' ||
    !Number.isInteger(candidate) ||
    candidate < min ||
    candidate > max
  ) {
    throw new CodexAppServerConfigError(`字段 ${field} 必须是 ${min}..${max} 的整数`);
  }
  return candidate;
}

export function parseCodexAppServerConfig(raw: unknown): CodexAppServerConfig {
  const config = record(raw);
  for (const key of Object.keys(config)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new CodexAppServerConfigError(`未知字段 codexAppServer.${key}`);
    }
  }

  const workingDir = canonicalDirectory(
    config['workingDir'],
    'codexAppServer.workingDir',
  );
  const binValue = config['bin'] ?? DEFAULT_CODEX_APP_SERVER_CONFIG.bin;
  if (typeof binValue !== 'string' || binValue.length === 0) {
    throw new CodexAppServerConfigError('字段 codexAppServer.bin 必须是非空字符串');
  }

  const sandboxValue =
    config['sandbox'] ?? DEFAULT_CODEX_APP_SERVER_CONFIG.sandbox;
  if (!SANDBOX_MODES.includes(sandboxValue as CodexAppServerSandbox)) {
    throw new CodexAppServerConfigError(
      `字段 codexAppServer.sandbox 必须是 ${SANDBOX_MODES.join(' / ')}`,
    );
  }

  const addDirsValue = config['addDirs'] ?? [];
  if (!Array.isArray(addDirsValue)) {
    throw new CodexAppServerConfigError('字段 codexAppServer.addDirs 必须是绝对路径数组');
  }
  const addDirs = addDirsValue.map((value, index) =>
    canonicalDirectory(value, `codexAppServer.addDirs[${index}]`),
  );
  if (new Set(addDirs).size !== addDirs.length) {
    throw new CodexAppServerConfigError('字段 codexAppServer.addDirs canonical 后存在重复路径');
  }

  const retentionRaw = config['conversationRetentionMs'];
  const conversationRetentionMs =
    retentionRaw === undefined || retentionRaw === null
      ? null
      : integerInRange(
          retentionRaw,
          'codexAppServer.conversationRetentionMs',
          60_000,
          60_000,
          2_147_483_647,
        );
  const viewerRaw = config['supplementalViewer'];
  let supplementalViewer = {
    ...DEFAULT_CODEX_APP_SERVER_CONFIG.supplementalViewer,
  };
  if (viewerRaw !== undefined) {
    if (!viewerRaw || typeof viewerRaw !== 'object' || Array.isArray(viewerRaw)) {
      throw new CodexAppServerConfigError('字段 codexAppServer.supplementalViewer 必须是对象');
    }
    const viewer = viewerRaw as Record<string, unknown>;
    if (Object.keys(viewer).some((key) => key !== 'enabled')) {
      throw new CodexAppServerConfigError('codexAppServer.supplementalViewer 包含未知字段');
    }
    if (typeof viewer['enabled'] !== 'boolean') {
      throw new CodexAppServerConfigError(
        '字段 codexAppServer.supplementalViewer.enabled 必须是 boolean',
      );
    }
    supplementalViewer = { enabled: viewer['enabled'] };
  }

  return {
    bin: binValue,
    workingDir,
    sandbox: sandboxValue as CodexAppServerSandbox,
    addDirs,
    maxInputBytes: integerInRange(
      config['maxInputBytes'],
      'codexAppServer.maxInputBytes',
      DEFAULT_CODEX_APP_SERVER_CONFIG.maxInputBytes,
      1,
      1_048_576,
    ),
    requestTimeoutMs: integerInRange(
      config['requestTimeoutMs'],
      'codexAppServer.requestTimeoutMs',
      DEFAULT_CODEX_APP_SERVER_CONFIG.requestTimeoutMs,
      1,
      300_000,
    ),
    interruptGraceMs: integerInRange(
      config['interruptGraceMs'],
      'codexAppServer.interruptGraceMs',
      DEFAULT_CODEX_APP_SERVER_CONFIG.interruptGraceMs,
      1,
      60_000,
    ),
    terminateGraceMs: integerInRange(
      config['terminateGraceMs'],
      'codexAppServer.terminateGraceMs',
      DEFAULT_CODEX_APP_SERVER_CONFIG.terminateGraceMs,
      1,
      60_000,
    ),
    conversationRetentionMs,
    supplementalViewer,
  };
}
