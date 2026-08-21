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

  it('UTF-8 多字节字符在边界被切断时仍不超过字节上限', async () => {
    const result = await executeShellCommand({
      command:
        'node -e "process.stdout.write(\'a\'.repeat(32767)); process.stdout.write(Buffer.from([0xe4]))"',
      cwd: '/tmp',
      timeoutMs: 1000,
      maxOutputBytes: 32768,
    });

    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32768);
  });

  it('大量无效 UTF-8 字节按线性遍历收口到字节上限', async () => {
    const result = await executeShellCommand({
      command:
        'node -e "process.stdout.write(Buffer.alloc(32768, 0xff))"',
      cwd: '/tmp',
      timeoutMs: 1000,
      maxOutputBytes: 32768,
    });

    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32768);
  });

  it('AbortSignal 会终止正在运行的进程组', async () => {
    const controller = new AbortController();
    const execution = executeShellCommand({
      command: 'sleep 10',
      cwd: '/tmp',
      timeoutMs: 30000,
      maxOutputBytes: 32768,
      signal: controller.signal,
    });

    controller.abort();
    const result = await execution;

    expect(result.signal).not.toBeNull();
    expect(result.timedOut).toBe(false);
  });
});
