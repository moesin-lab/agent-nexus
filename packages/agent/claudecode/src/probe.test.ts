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

  it('--print 返回事件数组形态（CC CLI 2.1.x）：从末尾 result 事件取 stop_reason 与文本', async () => {
    // 实测 CC CLI 2.1.119 在 --output-format json 下输出整段流式事件数组（而非单个 envelope）。
    // 末尾 `{type:"result", stop_reason:"end_turn", result:"pong"}` 才是权威终止信号。
    mockedExeca
      .mockResolvedValueOnce({
        stdout: 'claude-code 2.1.119',
      } as unknown as ReturnType<typeof execa>)
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { type: 'system', subtype: 'init', session_id: 'abc' },
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'pong' }] },
          },
          {
            type: 'result',
            subtype: 'success',
            stop_reason: 'end_turn',
            result: 'pong',
          },
        ]),
      } as unknown as ReturnType<typeof execa>);

    await expect(
      runCompatibilityProbe({ claudeBin: 'claude', logger: fakeLogger }),
    ).resolves.toBeUndefined();
  });

  it('--print 返回数组但缺 result 事件 → 抛 AgentSpawnFailedError', async () => {
    mockedExeca
      .mockResolvedValueOnce({
        stdout: 'claude-code 2.1.119',
      } as unknown as ReturnType<typeof execa>)
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { type: 'system', subtype: 'init', session_id: 'abc' },
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'pong' }] },
          },
        ]),
      } as unknown as ReturnType<typeof execa>);

    await expect(
      runCompatibilityProbe({ claudeBin: 'claude', logger: fakeLogger }),
    ).rejects.toBeInstanceOf(AgentSpawnFailedError);
  });

  it('--print 返回里 result 是非空 object 但找不到任何 string 文本 → 抛 AgentSpawnFailedError', async () => {
    // 旧实现的 textOk 第三分支接受任意非空 object，会让 probe 在「stop_reason 对、文本一片狼藉」时假通过。
    mockedExeca
      .mockResolvedValueOnce({
        stdout: 'claude-code 2.5.0',
      } as unknown as ReturnType<typeof execa>)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          // result 是 object 但内部既没 .text 也没 string content
          result: { stop_reason: 'end_turn', meta: { foo: 'bar' } },
        }),
      } as unknown as ReturnType<typeof execa>);

    await expect(
      runCompatibilityProbe({ claudeBin: 'claude', logger: fakeLogger }),
    ).rejects.toBeInstanceOf(AgentSpawnFailedError);
  });
});
