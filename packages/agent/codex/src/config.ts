export const DEFAULT_BIN = 'codex';
export const DEFAULT_SANDBOX = 'read-only' as const;
export const SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;

export type CodexSandbox = (typeof SANDBOX_MODES)[number];

export interface CodexConfig {
  bin: string;
  workingDir: string;
  model?: string;
  sandbox: CodexSandbox;
  addDirs: string[];
  loadUserConfig: boolean;
  loadRules: boolean;
}

export class CodexConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalNonEmptyString(
  raw: Record<string, unknown>,
  key: string,
  fieldName: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new CodexConfigError(`字段 ${fieldName} 必须是非空字符串`);
  }
  return value;
}

function optionalBoolean(
  raw: Record<string, unknown>,
  key: string,
  fieldName: string,
  defaultValue: boolean,
): boolean {
  const value = raw[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new CodexConfigError(`字段 ${fieldName} 必须是布尔值`);
  }
  return value;
}

export function parseCodexConfig(raw: unknown): CodexConfig {
  const codex = isRecord(raw) ? raw : {};

  if ('approvalPolicy' in codex || 'approval_policy' in codex) {
    throw new CodexConfigError('字段 codex.approvalPolicy 不支持；Codex exec 固定使用 never');
  }
  if (
    'dangerouslyBypassApprovalsAndSandbox' in codex ||
    'dangerously_bypass_approvals_and_sandbox' in codex
  ) {
    throw new CodexConfigError('字段 codex.dangerouslyBypassApprovalsAndSandbox 不支持');
  }

  const workingDir = optionalNonEmptyString(codex, 'workingDir', 'codex.workingDir');
  if (!workingDir) {
    throw new CodexConfigError('缺字段 codex.workingDir（非空字符串）');
  }

  const bin = optionalNonEmptyString(codex, 'bin', 'codex.bin') ?? DEFAULT_BIN;
  const model = optionalNonEmptyString(codex, 'model', 'codex.model');

  const sandboxRaw = codex['sandbox'];
  if (
    sandboxRaw !== undefined &&
    !SANDBOX_MODES.includes(sandboxRaw as CodexSandbox)
  ) {
    throw new CodexConfigError(
      `字段 codex.sandbox 必须是 ${SANDBOX_MODES.map((v) => `"${v}"`).join(' / ')}`,
    );
  }
  const sandbox = (sandboxRaw as CodexSandbox | undefined) ?? DEFAULT_SANDBOX;

  const addDirsRaw = codex['addDirs'];
  let addDirs: string[];
  if (addDirsRaw === undefined) {
    addDirs = [];
  } else {
    if (!Array.isArray(addDirsRaw)) {
      throw new CodexConfigError('字段 codex.addDirs 必须是字符串数组');
    }
    for (const dir of addDirsRaw) {
      if (typeof dir !== 'string' || dir.length === 0) {
        throw new CodexConfigError('字段 codex.addDirs 必须是字符串数组');
      }
    }
    addDirs = [...addDirsRaw];
  }

  const loadUserConfig = optionalBoolean(
    codex,
    'loadUserConfig',
    'codex.loadUserConfig',
    false,
  );
  const loadRules = optionalBoolean(codex, 'loadRules', 'codex.loadRules', false);

  return {
    bin,
    workingDir,
    ...(model === undefined ? {} : { model }),
    sandbox,
    addDirs,
    loadUserConfig,
    loadRules,
  };
}
