import { describe, expect, it } from 'vitest';
import { executeShellCommand } from './shell-command.js';

describe('executeShellCommand', () => {
  it('通过 /bin/sh -lc 在指定工作目录执行，并合并 stdout/stderr', async () => {
    const result = await executeShellCommand({
      command: 'printf "$PWD"; printf " stderr" >&2; exit 7',
      cwd: '/tmp',
      timeoutMs: 1000,
      maxOutputBytes: 32768,
    });

    expect(result.output).toContain('/tmp');
    expect(result.output).toContain('stderr');
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('超过执行时间后终止命令', async () => {
    const result = await executeShellCommand({
      command: 'sleep 1',
      cwd: '/tmp',
      timeoutMs: 20,
      maxOutputBytes: 32768,
    });

    expect(result.timedOut).toBe(true);
  });

  it('输出超过字节上限后截断并终止命令', async () => {
    const result = await executeShellCommand({
      command: 'printf 123456789',
      cwd: '/tmp',
      timeoutMs: 1000,
      maxOutputBytes: 5,
    });

    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(5);
    expect(result.truncated).toBe(true);
  });
});
