import { readFile, writeFile } from 'node:fs/promises';

export type ReplyMode = 'mention' | 'all';

export interface ReplyModeState {
  replyMode: ReplyMode;
}

export const REPLY_MODES: readonly ReplyMode[] = ['mention', 'all'] as const;

function isReplyMode(v: unknown): v is ReplyMode {
  return v === 'mention' || v === 'all';
}

/**
 * 读 reply-mode 持久化文件。
 *
 * - 文件不存在 → null（调用方按默认 'mention' 处理）
 * - 文件存在但损坏（JSON 非法 / 字段非法 / 字段缺失）→ throw
 *   不静默修复——loose 修复会让运维操作（曾切到 'all'）静默丢失。
 *
 * 其它 fs 错误（EACCES 等）原样透出。
 */
export async function readReplyModeState(path: string): Promise<ReplyModeState | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `platform-discord: state file ${path} is invalid JSON: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`platform-discord: state file ${path} 顶层必须是对象`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!isReplyMode(obj['replyMode'])) {
    throw new Error(
      `platform-discord: state file ${path} 字段 replyMode 非法（必须是 'mention' | 'all'）`,
    );
  }
  return { replyMode: obj['replyMode'] };
}

export async function writeReplyModeState(path: string, replyMode: ReplyMode): Promise<void> {
  const payload: ReplyModeState = { replyMode };
  await writeFile(path, JSON.stringify(payload, null, 2));
}
