import { describe, expect, it } from 'vitest';
import { parseClaudeCodeConfig, ClaudeCodeConfigError, DEFAULT_ALLOWED_TOOLS, DEFAULT_BIN } from './config.js';

describe('parseClaudeCodeConfig', () => {
  it('缺 workingDir → ClaudeCodeConfigError', () => {
    expect(() => parseClaudeCodeConfig({})).toThrow(ClaudeCodeConfigError);
    expect(() => parseClaudeCodeConfig({})).toThrow(/workingDir/);
  });

  it('workingDir 空字符串 → ClaudeCodeConfigError', () => {
    expect(() => parseClaudeCodeConfig({ workingDir: '' })).toThrow(ClaudeCodeConfigError);
  });

  it('workingDir 非字符串 → ClaudeCodeConfigError', () => {
    expect(() => parseClaudeCodeConfig({ workingDir: 42 })).toThrow(ClaudeCodeConfigError);
  });

  it('默认值兜底：bin = "claude", allowedTools 含默认集, Bash 默认禁用', () => {
    // spec/security/tool-boundary.md：Bash 必须默认禁用，启用须显式列入 allowedTools。
    const result = parseClaudeCodeConfig({ workingDir: '/x' });
    expect(result.bin).toBe(DEFAULT_BIN);
    expect(result.allowedTools).not.toContain('Bash');
    expect(result.allowedTools).toEqual(
      expect.arrayContaining(['Read', 'Grep', 'Glob', 'Edit', 'Write']),
    );
  });

  it('显式 bin → 原样保留', () => {
    const result = parseClaudeCodeConfig({ workingDir: '/x', bin: '/usr/local/bin/claude' });
    expect(result.bin).toBe('/usr/local/bin/claude');
  });

  it('显式 allowedTools 含 Bash → 保留（Bash 启用走 cli warn 路径）', () => {
    const result = parseClaudeCodeConfig({
      workingDir: '/x',
      allowedTools: ['Read', 'Bash'],
    });
    expect(result.allowedTools).toEqual(['Read', 'Bash']);
  });

  it('ctx.defaultBin 覆盖内置默认值', () => {
    const result = parseClaudeCodeConfig({ workingDir: '/x' }, { defaultBin: 'claude-custom' });
    expect(result.bin).toBe('claude-custom');
  });

  it('ctx.defaultAllowedTools 覆盖内置默认值', () => {
    const result = parseClaudeCodeConfig(
      { workingDir: '/x' },
      { defaultAllowedTools: ['Read'] },
    );
    expect(result.allowedTools).toEqual(['Read']);
  });

  it('allowedTools 含非字符串元素 → 过滤掉非字符串', () => {
    const result = parseClaudeCodeConfig({
      workingDir: '/x',
      allowedTools: ['Read', 42, 'Grep'],
    });
    expect(result.allowedTools).toEqual(['Read', 'Grep']);
  });

  it('raw 为 undefined → ClaudeCodeConfigError（缺 workingDir）', () => {
    expect(() => parseClaudeCodeConfig(undefined)).toThrow(ClaudeCodeConfigError);
  });

  it('DEFAULT_ALLOWED_TOOLS 不含 Bash', () => {
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('Bash');
    expect(DEFAULT_ALLOWED_TOOLS).toEqual(
      expect.arrayContaining(['Read', 'Grep', 'Glob', 'Edit', 'Write']),
    );
  });
});
