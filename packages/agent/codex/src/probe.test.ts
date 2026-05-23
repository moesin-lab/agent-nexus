import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@agent-nexus/daemon';
import {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  CodexCompatibilityProbeError,
  runCompatibilityProbe,
} from './probe.js';
import type { CodexConfig } from './config.js';

const execaMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

const baseConfig = {
  bin: 'codex',
  workingDir: '/workspace/project',
  sandbox: 'read-only',
  addDirs: [],
  loadUserConfig: false,
  loadRules: false,
} satisfies CodexConfig;

function logger(): Logger {
  return { info: vi.fn() } as unknown as Logger;
}

beforeEach(() => {
  execaMock.mockReset();
});

describe('Codex command construction', () => {
  it('新会话命令使用 fail-closed 默认值且不包含 dangerous bypass', () => {
    const args = buildCodexExecArgs(baseConfig, 'hello');

    expect(args).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      '--cd',
      '/workspace/project',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      'hello',
    ]);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('resume 命令把顶层 flag 放在 exec resume 之前，子命令 flag 放在之后', () => {
    const args = buildCodexResumeArgs(
      {
        ...baseConfig,
        model: 'gpt-5-codex',
        sandbox: 'workspace-write',
        addDirs: ['/tmp/a'],
        loadUserConfig: true,
        loadRules: true,
      },
      'thread-1',
      'next',
    );

    expect(args).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      '--cd',
      '/workspace/project',
      '--add-dir',
      '/tmp/a',
      '--model',
      'gpt-5-codex',
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      'thread-1',
      'next',
    ]);
  });
});

describe('Codex compatibility probe', () => {
  it('校验 version 与 exec help 的必需静态能力', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.133.0' })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex\nexec\n--sandbox --ask-for-approval --cd --add-dir -m',
      })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex exec\nresume --json --ignore-user-config --ignore-rules',
      });

    await expect(
      runCompatibilityProbe({
        config: { ...baseConfig, model: 'gpt-5-codex' },
        logger: logger(),
      }),
    ).resolves.toBeUndefined();
    expect(execaMock).toHaveBeenNthCalledWith(1, 'codex', ['--version']);
    expect(execaMock).toHaveBeenNthCalledWith(2, 'codex', ['--help']);
    expect(execaMock).toHaveBeenNthCalledWith(3, 'codex', ['exec', '--help']);
  });

  it('version 输出为空时 fail closed', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });

    await expect(
      runCompatibilityProbe({ config: baseConfig, logger: logger() }),
    ).rejects.toMatchObject({
      name: 'CodexCompatibilityProbeError',
      message: expect.stringContaining('empty stdout from --version'),
    });
  });

  it('exec help 缺少必需 flag 时 fail closed', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.133.0' })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex\nexec\n--sandbox --ask-for-approval --cd --add-dir',
      })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex exec\nresume --ignore-user-config --ignore-rules',
      });

    await expect(
      runCompatibilityProbe({ config: baseConfig, logger: logger() }),
    ).rejects.toThrow('missing --json in codex help');
  });
});
