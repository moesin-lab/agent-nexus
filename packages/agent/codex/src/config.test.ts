import { describe, expect, it } from 'vitest';
import {
  CodexConfigError,
  DEFAULT_BIN,
  DEFAULT_SANDBOX,
  parseCodexConfig,
} from './config.js';

describe('parseCodexConfig', () => {
  it('缺 workingDir → CodexConfigError', () => {
    expect(() => parseCodexConfig({})).toThrow(CodexConfigError);
    expect(() => parseCodexConfig({})).toThrow(/codex\.workingDir/);
  });

  it('默认值 fail-closed：codex bin, read-only sandbox, no addDirs, ignore user config/rules', () => {
    const result = parseCodexConfig({ workingDir: '/workspace/project' });

    expect(result).toEqual({
      workingDir: '/workspace/project',
      bin: DEFAULT_BIN,
      sandbox: DEFAULT_SANDBOX,
      addDirs: [],
      loadUserConfig: false,
      loadRules: false,
    });
  });

  it('显式 model / workspace-write / addDirs / load flags → 原样保留', () => {
    const result = parseCodexConfig({
      workingDir: '/workspace/project',
      bin: '/usr/local/bin/codex',
      model: 'gpt-5-codex',
      sandbox: 'workspace-write',
      addDirs: ['/tmp/a', '/tmp/b'],
      loadUserConfig: true,
      loadRules: true,
    });

    expect(result).toEqual({
      workingDir: '/workspace/project',
      bin: '/usr/local/bin/codex',
      model: 'gpt-5-codex',
      sandbox: 'workspace-write',
      addDirs: ['/tmp/a', '/tmp/b'],
      loadUserConfig: true,
      loadRules: true,
    });
  });

  it('danger-full-access sandbox → CodexConfigError', () => {
    expect(() =>
      parseCodexConfig({
        workingDir: '/workspace/project',
        sandbox: 'danger-full-access',
      }),
    ).toThrow(CodexConfigError);
  });

  it('不接受 approvalPolicy 配置字段', () => {
    expect(() =>
      parseCodexConfig({
        workingDir: '/workspace/project',
        approvalPolicy: 'never',
      }),
    ).toThrow(/approvalPolicy/);
  });

  it('addDirs 必须是字符串数组', () => {
    expect(() =>
      parseCodexConfig({
        workingDir: '/workspace/project',
        addDirs: ['/tmp/a', 42],
      }),
    ).toThrow(CodexConfigError);
  });
});
