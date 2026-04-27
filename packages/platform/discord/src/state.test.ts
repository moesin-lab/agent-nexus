import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReplyModeState, writeReplyModeState } from './state.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'platform-discord-state-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('readReplyModeState', () => {
  it('文件不存在 → 返回 null', async () => {
    const path = join(workDir, 'missing.json');
    expect(await readReplyModeState(path)).toBeNull();
  });

  it('合法 JSON + 合法 replyMode → 返回值', async () => {
    const path = join(workDir, 'state.json');
    await writeFile(path, JSON.stringify({ replyMode: 'all' }));
    expect(await readReplyModeState(path)).toEqual({ replyMode: 'all' });
  });

  it('mention 模式同样可读', async () => {
    const path = join(workDir, 'state.json');
    await writeFile(path, JSON.stringify({ replyMode: 'mention' }));
    expect(await readReplyModeState(path)).toEqual({ replyMode: 'mention' });
  });

  it('JSON 解析失败 → 抛错（不静默修复）', async () => {
    const path = join(workDir, 'state.json');
    await writeFile(path, '{ not json');
    await expect(readReplyModeState(path)).rejects.toThrow(/state file.*invalid JSON/i);
  });

  it('replyMode 字段缺失 → 抛错', async () => {
    const path = join(workDir, 'state.json');
    await writeFile(path, JSON.stringify({ other: 'field' }));
    await expect(readReplyModeState(path)).rejects.toThrow(/replyMode/);
  });

  it('replyMode 值非法 → 抛错', async () => {
    const path = join(workDir, 'state.json');
    await writeFile(path, JSON.stringify({ replyMode: 'banana' }));
    await expect(readReplyModeState(path)).rejects.toThrow(/replyMode/);
  });
});

describe('writeReplyModeState', () => {
  it('写入后 readReplyModeState 能读回', async () => {
    const path = join(workDir, 'state.json');
    await writeReplyModeState(path, 'all');
    expect(await readReplyModeState(path)).toEqual({ replyMode: 'all' });
  });

  it('覆盖既有内容', async () => {
    const path = join(workDir, 'state.json');
    await writeReplyModeState(path, 'all');
    await writeReplyModeState(path, 'mention');
    expect(await readReplyModeState(path)).toEqual({ replyMode: 'mention' });
  });

  it('文件内容是合法 JSON', async () => {
    const path = join(workDir, 'state.json');
    await writeReplyModeState(path, 'all');
    const raw = await readFile(path, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual({ replyMode: 'all' });
  });
});

describe('readReplyModeState：权限相关', () => {
  it('权限错误（非 ENOENT）应当透出而不是当成不存在', async () => {
    const path = join(workDir, 'unreadable.json');
    await writeFile(path, JSON.stringify({ replyMode: 'all' }));
    await chmod(path, 0o000);
    try {
      await expect(readReplyModeState(path)).rejects.toThrow();
    } finally {
      await chmod(path, 0o600);
    }
  });
});
