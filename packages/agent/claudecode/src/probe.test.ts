import { writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
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

function makeProbeChild(
  mode: 'two-turn' | 'permission' | 'permission-no-control',
): ReturnType<typeof execa> & {
  stdout: PassThrough;
  stdin: PassThrough;
  writes: string[];
  kill: ReturnType<typeof vi.fn>;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const writes: string[] = [];
  let pendingSentinel: string | undefined;

  function emitJson(value: unknown): void {
    stdout.write(`${JSON.stringify(value)}\n`);
  }

  let buffer = '';
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) handleLine(line);
      newline = buffer.indexOf('\n');
    }
  });

  function handleLine(line: string): void {
    writes.push(line);
    const event = JSON.parse(line) as {
      type?: string;
      message?: { content?: string };
      response?: {
        response?: { behavior?: 'allow' | 'deny' };
      };
    };

    if (event.type === 'user') {
      if (mode === 'two-turn') {
        emitJson({ type: 'system', subtype: 'init', session_id: 'sid-probe' });
        emitJson({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'pong' }] },
        });
        emitJson({ type: 'result', stop_reason: 'end_turn' });
      } else if (mode === 'permission-no-control') {
        emitJson({ type: 'result', stop_reason: 'end_turn' });
      } else {
        pendingSentinel = event.message?.content?.match(/> "([^"]+)"/)?.[1];
        emitJson({
          type: 'control_request',
          request_id: `req-${writes.length}`,
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: `printf ok > ${pendingSentinel ?? 'missing'}` },
          },
        });
      }
    } else if (event.type === 'control_response') {
      const behavior = event.response?.response?.behavior;
      if (behavior === 'allow' && pendingSentinel) {
        void writeFile(pendingSentinel, 'ok').then(() => {
          emitJson({ type: 'result', stop_reason: 'end_turn' });
        });
        return;
      }
      emitJson({ type: 'result', stop_reason: 'end_turn' });
    }
  }

  let rejectFn: (err: Error) => void = () => {};
  const settled = new Promise<void>((_, reject) => {
    rejectFn = reject;
  });
  settled.catch(() => {});
  const kill = vi.fn(() => {
    stdout.end();
    rejectFn(Object.assign(new Error('killed'), { isTerminated: true }));
    return true;
  });

  return {
    stdout,
    stdin,
    writes,
    kill,
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  } as unknown as ReturnType<typeof execa> & {
    stdout: PassThrough;
    stdin: PassThrough;
    writes: string[];
    kill: ReturnType<typeof vi.fn>;
  };
}

describe('runCompatibilityProbe', () => {
  beforeEach(() => {
    mockedExeca.mockReset();
  });

  it('happy path: --version + --print + 长驻 stream-json + permission control 都成功', async () => {
    const longRunningChild = makeProbeChild('two-turn');
    const denyChild = makeProbeChild('permission');
    const allowChild = makeProbeChild('permission');
    mockedExeca
      .mockResolvedValueOnce({
        stdout: 'claude-code 2.5.0',
      } as unknown as ReturnType<typeof execa>)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: { stop_reason: 'end_turn' },
          message: { content: 'pong' },
        }),
      } as unknown as ReturnType<typeof execa>)
      .mockReturnValueOnce(longRunningChild)
      .mockReturnValueOnce(denyChild)
      .mockReturnValueOnce(allowChild);

    await expect(
      runCompatibilityProbe({ claudeBin: 'claude', logger: fakeLogger }),
    ).resolves.toBeUndefined();

    expect(mockedExeca).toHaveBeenCalledTimes(5);
    expect(mockedExeca).toHaveBeenNthCalledWith(1, 'claude', ['--version']);
    expect(mockedExeca).toHaveBeenNthCalledWith(
      2,
      'claude',
      ['--print', 'ping', '--output-format', 'json'],
      expect.objectContaining({ timeout: 30_000 }),
    );
    for (const callNo of [3, 4, 5] as const) {
      const args = mockedExeca.mock.calls[callNo - 1]![1] as string[];
      const opts = mockedExeca.mock.calls[callNo - 1]![2] as {
        buffer?: boolean;
        timeout?: number;
      };
      expect(args).not.toContain('--print');
      expect(args).toEqual(
        expect.arrayContaining([
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--permission-prompt-tool',
          'stdio',
          '--replay-user-messages',
          '--verbose',
          '--allowed-tools',
          'Read',
        ]),
      );
      expect(opts.buffer).toBe(false);
      expect(opts.timeout).toBe(30_000);
    }
    expect(
      longRunningChild.writes.filter((line) => JSON.parse(line).type === 'user'),
    ).toHaveLength(2);
    expect(
      denyChild.writes.some(
        (line) =>
          JSON.parse(line).type === 'control_response' &&
          JSON.parse(line).response.response.behavior === 'deny',
      ),
    ).toBe(true);
    expect(
      allowChild.writes.some(
        (line) =>
          JSON.parse(line).type === 'control_response' &&
          JSON.parse(line).response.response.behavior === 'allow',
      ),
    ).toBe(true);
  });

  it('--version 失败 → 抛 AgentSpawnFailedError', async () => {
    mockedExeca.mockRejectedValueOnce(new Error('command not found'));

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

  it('permission probe 缺 can_use_tool → 抛 AgentSpawnFailedError', async () => {
    mockedExeca
      .mockResolvedValueOnce({
        stdout: 'claude-code 2.5.0',
      } as unknown as ReturnType<typeof execa>)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: { stop_reason: 'end_turn' },
          message: { content: 'pong' },
        }),
      } as unknown as ReturnType<typeof execa>)
      .mockReturnValueOnce(makeProbeChild('two-turn'))
      .mockReturnValueOnce(makeProbeChild('permission-no-control'));

    await expect(
      runCompatibilityProbe({ claudeBin: 'claude', logger: fakeLogger }),
    ).rejects.toBeInstanceOf(AgentSpawnFailedError);
  });
});
