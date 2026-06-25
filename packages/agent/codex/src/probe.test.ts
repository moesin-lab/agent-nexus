import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  return { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
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

  it('danger-full-access 命令使用 sandbox 枚举而不是 dangerous bypass flag', () => {
    const args = buildCodexExecArgs(
      { ...baseConfig, sandbox: 'danger-full-access', addDirs: ['/tmp/ignored'] },
      'yolo',
    );

    expect(args).toEqual([
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'never',
      '--cd',
      '/workspace/project',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      'yolo',
    ]);
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('Codex compatibility probe', () => {
  const execPingStdout = [
    '{"type":"thread.started","thread_id":"thread-probe"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"CODEX_PROBE_OK"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}',
  ].join('\n');
  const resumeStdout = [
    '{"type":"thread.started","thread_id":"thread-probe"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"CODEX_PROBE_RESUME_OK"}}',
    '{"type":"turn.completed","usage":{"input_tokens":2,"cached_input_tokens":1,"output_tokens":1}}',
  ].join('\n');
  const toolStdout = [
    '{"type":"thread.started","thread_id":"thread-tool"}',
    '{"type":"turn.started"}',
    '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \\"printf CODEX_TOOL_OK\\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \\"printf CODEX_TOOL_OK\\"","aggregated_output":"CODEX_TOOL_OK","exit_code":0,"status":"completed"}}',
    '{"type":"turn.completed","usage":{"input_tokens":3,"cached_input_tokens":1,"output_tokens":1}}',
  ].join('\n');

  it('默认 startup 模式只校验本地 version/help，避免启动时跑真实模型 turn', async () => {
    const fakeLogger = logger();
    execaMock
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.133.0' })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex\nexec\n--sandbox --ask-for-approval --cd --add-dir',
      })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex exec\nresume --json --ignore-user-config --ignore-rules',
      });

    await expect(
      runCompatibilityProbe({
        config: baseConfig,
        logger: fakeLogger,
      }),
    ).resolves.toBeUndefined();

    expect(execaMock).toHaveBeenCalledTimes(3);
    expect(execaMock).toHaveBeenNthCalledWith(1, 'codex', ['--version']);
    expect(execaMock).toHaveBeenNthCalledWith(2, 'codex', ['--help']);
    expect(execaMock).toHaveBeenNthCalledWith(3, 'codex', ['exec', '--help']);
    expect(fakeLogger.info).toHaveBeenCalledWith(
      { step: 'version' },
      'codex_compat_probe_step_start',
    );
    expect(fakeLogger.info).toHaveBeenCalledWith(
      { step: 'help' },
      'codex_compat_probe_step_ok',
    );
    expect(fakeLogger.info).toHaveBeenCalledWith(
      { probeMode: 'startup' },
      'codex_compat_probe_complete',
    );
  });

  it('full 模式校验 version、help、exec/resume JSONL 与 tool 事件 schema', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.133.0' })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex\nexec\n--sandbox --ask-for-approval --cd --add-dir -m',
      })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex exec\nresume --json --ignore-user-config --ignore-rules',
      })
      .mockResolvedValueOnce({ stdout: execPingStdout })
      .mockResolvedValueOnce({ stdout: resumeStdout })
      .mockResolvedValueOnce({ stdout: toolStdout });

    await expect(
      runCompatibilityProbe({
        config: { ...baseConfig, model: 'gpt-5-codex' },
        logger: logger(),
        mode: 'full',
      }),
    ).resolves.toBeUndefined();
    expect(execaMock).toHaveBeenNthCalledWith(1, 'codex', ['--version']);
    expect(execaMock).toHaveBeenNthCalledWith(2, 'codex', ['--help']);
    expect(execaMock).toHaveBeenNthCalledWith(3, 'codex', ['exec', '--help']);
    const execArgs = execaMock.mock.calls[3]![1] as string[];
    const resumeArgs = execaMock.mock.calls[4]![1] as string[];
    expect(execArgs).toContain('--json');
    expect(execArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(resumeArgs).toEqual(expect.arrayContaining(['exec', 'resume', 'thread-probe']));
  });

  it('配置 timeoutMs 时传给每次 Codex 子进程调用', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.133.0' })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex\nexec\n--sandbox --ask-for-approval --cd --add-dir',
      })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex exec\nresume --json --ignore-user-config --ignore-rules',
      })
      .mockResolvedValueOnce({ stdout: execPingStdout })
      .mockResolvedValueOnce({ stdout: resumeStdout })
      .mockResolvedValueOnce({ stdout: toolStdout });

    await expect(
      runCompatibilityProbe({
        config: baseConfig,
        logger: logger(),
        timeoutMs: 12_345,
        mode: 'full',
      }),
    ).resolves.toBeUndefined();

    expect(execaMock.mock.calls.every((call) => call[2]?.timeout === 12_345))
      .toBe(true);
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

  it('配置 danger-full-access 时 help 必须暴露该 sandbox 值', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.142.0' })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex\nexec\n--sandbox --ask-for-approval --cd --add-dir',
      })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex exec\nresume --json --ignore-user-config --ignore-rules',
      });

    await expect(
      runCompatibilityProbe({
        config: { ...baseConfig, sandbox: 'danger-full-access' },
        logger: logger(),
      }),
    ).rejects.toThrow('missing danger-full-access in codex help');
  });

  it('配置 danger-full-access 时启动探针打 warn 日志', async () => {
    const fakeLogger = logger();
    execaMock
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.142.0' })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex\nexec\n--sandbox danger-full-access --ask-for-approval --cd --add-dir',
      })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex exec\nresume --json --ignore-user-config --ignore-rules',
      });

    await expect(
      runCompatibilityProbe({
        config: { ...baseConfig, sandbox: 'danger-full-access' },
        logger: fakeLogger,
      }),
    ).resolves.toBeUndefined();

    expect(fakeLogger.warn).toHaveBeenCalledWith(
      { sandbox: 'danger-full-access' },
      'codex_danger_full_access_enabled',
    );
  });

  it('exec JSONL 缺少 thread.started 时 fail closed', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.133.0' })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex\nexec\n--sandbox --ask-for-approval --cd --add-dir',
      })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex exec\nresume --json --ignore-user-config --ignore-rules',
      })
      .mockResolvedValueOnce({
        stdout: '{"type":"turn.started"}\n{"type":"turn.completed","usage":{"input_tokens":1}}',
      });

    await expect(
      runCompatibilityProbe({ config: baseConfig, logger: logger(), mode: 'full' }),
    ).rejects.toThrow('missing thread.started in exec probe');
  });

  it('workspace-write sandbox 通过 Codex 写哨兵文件验证工作目录可写', async () => {
    const workingDir = await mkdtemp(join(tmpdir(), 'codex-probe-'));
    try {
      execaMock
        .mockResolvedValueOnce({ stdout: 'codex-cli 0.133.0' })
        .mockResolvedValueOnce({
          stdout: 'Usage: codex\nexec\n--sandbox --ask-for-approval --cd --add-dir',
        })
        .mockResolvedValueOnce({
          stdout: 'Usage: codex exec\nresume --json --ignore-user-config --ignore-rules',
        })
        .mockResolvedValueOnce({ stdout: execPingStdout })
        .mockResolvedValueOnce({ stdout: resumeStdout })
        .mockResolvedValueOnce({ stdout: toolStdout })
        .mockImplementationOnce(async (_bin: string, args: string[]) => {
          const prompt = args.at(-1) ?? '';
          const sentinelName = prompt.split(' > ')[1];
          if (!sentinelName) throw new Error('missing sentinel name');
          await writeFile(join(workingDir, sentinelName), 'CODEX_WORKSPACE_WRITE_OK');
          return {
            stdout: [
              '{"type":"thread.started","thread_id":"thread-write"}',
              '{"type":"turn.started"}',
              '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"printf CODEX_WORKSPACE_WRITE_OK","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
              '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"printf CODEX_WORKSPACE_WRITE_OK","aggregated_output":"","exit_code":0,"status":"completed"}}',
              '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":0}}',
            ].join('\n'),
          };
        });

      await expect(
        runCompatibilityProbe({
          config: { ...baseConfig, sandbox: 'workspace-write', workingDir },
          logger: logger(),
          mode: 'full',
        }),
      ).resolves.toBeUndefined();
      expect(execaMock).toHaveBeenCalledTimes(7);
    } finally {
      await rm(workingDir, { recursive: true, force: true });
    }
  });

  it('danger-full-access full probe 不运行 workspace-write 哨兵写入', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.142.0' })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex\nexec\n--sandbox danger-full-access --ask-for-approval --cd --add-dir',
      })
      .mockResolvedValueOnce({
        stdout: 'Usage: codex exec\nresume --json --ignore-user-config --ignore-rules',
      })
      .mockResolvedValueOnce({ stdout: execPingStdout })
      .mockResolvedValueOnce({ stdout: resumeStdout })
      .mockResolvedValueOnce({ stdout: toolStdout });

    await expect(
      runCompatibilityProbe({
        config: { ...baseConfig, sandbox: 'danger-full-access' },
        logger: logger(),
        mode: 'full',
      }),
    ).resolves.toBeUndefined();

    expect(execaMock).toHaveBeenCalledTimes(6);
    const prompts = execaMock.mock.calls
      .map((call) => (call[1] as string[]).at(-1))
      .filter((value): value is string => typeof value === 'string');
    expect(prompts.some((prompt) => prompt.includes('CODEX_WORKSPACE_WRITE_OK')))
      .toBe(false);
  });
});
