// spec/security/tool-boundary.md：默认集 Read/Grep/Glob/Edit/Write；Bash 必须显式启用
export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write'];
export const DEFAULT_BIN = 'claude';
export const DEFAULT_PERMISSION_LEVEL = 'default' as const;
export const PERMISSION_LEVELS = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const;

export type ClaudeCodePermissionLevel = (typeof PERMISSION_LEVELS)[number];

export interface ClaudeCodeConfig {
  bin: string;
  workingDir: string;
  allowedTools: string[];
  permissionLevel: ClaudeCodePermissionLevel;
}

export class ClaudeCodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCodeConfigError';
  }
}

export function claudeCodePermissionModeError(
  value: unknown,
  expected: ClaudeCodePermissionLevel,
): string | null {
  if (typeof value !== 'string') {
    return `Claude Code permissionMode missing or invalid: ${String(value)}`;
  }
  if (value === 'bypassPermissions' && expected !== 'bypassPermissions') {
    return `unsafe Claude Code permissionMode: ${String(value)}`;
  }
  if (value !== expected) {
    return `Claude Code permissionMode mismatch: configured ${expected}, got ${value}`;
  }
  return null;
}

export function parseClaudeCodeConfig(
  raw: unknown,
  ctx: { defaultBin?: string; defaultAllowedTools?: string[] } = {},
): ClaudeCodeConfig {
  const cc = (raw as Record<string, unknown> | undefined) ?? {};

  const workingDir = cc['workingDir'];
  if (typeof workingDir !== 'string' || workingDir.length === 0) {
    throw new ClaudeCodeConfigError('缺字段 claudeCode.workingDir（非空字符串）');
  }

  const binRaw = cc['bin'];
  if (binRaw !== undefined && (typeof binRaw !== 'string' || binRaw.length === 0)) {
    throw new ClaudeCodeConfigError('字段 claudeCode.bin 必须是非空字符串');
  }
  const bin = (typeof binRaw === 'string' ? binRaw : undefined) ?? ctx.defaultBin ?? DEFAULT_BIN;

  const allowedToolsRaw = cc['allowedTools'];
  let allowedTools: string[];
  if (allowedToolsRaw !== undefined) {
    if (!Array.isArray(allowedToolsRaw)) {
      throw new ClaudeCodeConfigError('字段 claudeCode.allowedTools 必须是字符串数组');
    }
    for (const v of allowedToolsRaw) {
      if (typeof v !== 'string') {
        throw new ClaudeCodeConfigError('字段 claudeCode.allowedTools 必须是字符串数组');
      }
    }
    allowedTools = [...allowedToolsRaw];
  } else {
    allowedTools = ctx.defaultAllowedTools ?? DEFAULT_ALLOWED_TOOLS;
  }

  const permissionLevelRaw =
    cc['permissionLevel'] ?? cc['permission_level'];
  if (
    permissionLevelRaw !== undefined &&
    !PERMISSION_LEVELS.includes(permissionLevelRaw as ClaudeCodePermissionLevel)
  ) {
    throw new ClaudeCodeConfigError(
      `字段 claudeCode.permissionLevel 必须是 ${PERMISSION_LEVELS.map((v) => `"${v}"`).join(' / ')}`,
    );
  }
  const permissionLevel =
    (permissionLevelRaw as ClaudeCodePermissionLevel | undefined) ??
    DEFAULT_PERMISSION_LEVEL;

  return { bin, workingDir, allowedTools, permissionLevel };
}
