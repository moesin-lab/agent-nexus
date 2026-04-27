// spec/security/tool-boundary.md：默认集 Read/Grep/Glob/Edit/Write；Bash 必须显式启用
export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write'];
export const DEFAULT_BIN = 'claude';

export interface ClaudeCodeConfig {
  bin: string;
  workingDir: string;
  allowedTools: string[];
}

export class ClaudeCodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCodeConfigError';
  }
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

  return { bin, workingDir, allowedTools };
}
