import { describe, expect, it, vi, beforeEach } from 'vitest';

// 必须在 import probe.ts 前 vi.mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { runCompatibilityProbe, AgentSpawnFailedError } from './probe.js';

const mockedExeca = vi.mocked(execa);

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
} as unknown as import('@agent-nexus/daemon').Logger;

describe('runCompatibilityProbe', () => {
  beforeEach(() => {
    mockedExeca.mockReset();
  });

  it('happy path: --version + --print ping 都成功', async () => {
    mockedExeca
      .mockResolvedValueOnce({
        stdout: 'claude-code 2.5.0',
      } as unknown as ReturnType<typeof execa>)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: { stop_reason: 'end_turn' },
          message: { content: 'pong' },
        }),
      } as unknown as ReturnType<typeof execa>);

    await expect(
      runCompatibilityProbe({ claudeBin: 'claude', logger: fakeLogger }),
    ).resolves.toBeUndefined();

    expect(mockedExeca).toHaveBeenCalledTimes(2);
    expect(mockedExeca).toHaveBeenNthCalledWith(1, 'claude', ['--version']);
    expect(mockedExeca).toHaveBeenNthCalledWith(
      2,
      'claude',
      ['--print', 'ping', '--output-format', 'json'],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it('--version 失败 → 抛 AgentSpawnFailedError', async () => {
    mockedExeca.mockRejectedValueOnce(new Error('command not found'));

    await expect(
      runCompatibilityProbe({ claudeBin: 'claude', logger: fakeLogger }),
    ).rejects.toBeInstanceOf(AgentSpawnFailedError);
  });
});
