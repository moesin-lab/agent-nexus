import { describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';
import {
  buildBotMentionRegex,
  buildSlices,
  parseInbound,
  PartialSendError,
  SLICE_SIZE,
  type ParsedInbound,
} from './index.js';

/** 解包 `kind: 'event'`；otherwise 抛——让断言失败时直接看到 drop reason。 */
function expectEvent(r: ParsedInbound) {
  if (r.kind !== 'event') {
    throw new Error(`expected kind=event, got drop reason=${r.reason}`);
  }
  return r.event;
}

const BOT_ID = '900000000000000001';
const OTHER_ID = '900000000000000002';

// 默认放行集合：覆盖 fixture 里出现的所有 author id（OTHER_ID / U7 / U-init / U_X）。
// 让既有测试聚焦于"非 allowlist 维度"（mention / bot guard / self / system）；
// allowlist 自身的 fail-closed 行为在末尾的独立 describe 块里测。
const ALLOWED: readonly string[] = [OTHER_ID, 'U7', 'U-init', 'U_X'];

function makeMsg(overrides: {
  content: string;
  authorId?: string;
  authorBot?: boolean;
  authorUsername?: string;
  channelId?: string;
  id?: string;
  system?: boolean;
}): Message {
  const {
    content,
    authorId = OTHER_ID,
    authorBot = false,
    authorUsername = 'alice',
    channelId = 'C1',
    id = 'm-1',
    system = false,
  } = overrides;
  // 只构造测试覆盖路径需要的字段；rawPayload 直接挂整个 mock。
  return {
    id,
    content,
    channelId,
    createdAt: new Date(0),
    system,
    author: {
      id: authorId,
      username: authorUsername,
      bot: authorBot,
    },
  } as unknown as Message;
}

describe('buildSlices', () => {
  it('empty string → single-element [""] (guarantees at least one message)', () => {
    expect(buildSlices('')).toEqual(['']);
  });

  it('short text (< SLICE_SIZE) → single slice', () => {
    const text = 'hello world';
    const slices = buildSlices(text);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toBe(text);
  });

  it('exactly SLICE_SIZE → single slice', () => {
    const text = 'a'.repeat(SLICE_SIZE);
    const slices = buildSlices(text);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toHaveLength(SLICE_SIZE);
  });

  it('longer than SLICE_SIZE → multiple slices, joined back equals original', () => {
    const text = 'b'.repeat(SLICE_SIZE * 2 + 100);
    const slices = buildSlices(text);
    expect(slices).toHaveLength(3);
    expect(slices.join('')).toBe(text);
  });

  it('custom maxUtf16 budget (ASCII)', () => {
    const slices = buildSlices('abcde', 2);
    expect(slices).toEqual(['ab', 'cd', 'e']);
  });

  it('emoji 在边界不被劈成 lone surrogate', () => {
    // 边界附近放一个 surrogate pair emoji，确保切点不落在 high/low surrogate 之间。
    // 预算 4 (UTF-16 单位) 下：'a' (1) + '😀' (2) = 3，再加 'b' (1) = 4，第一切片塞满；
    // 'c' (1) 进第二片；'😀' (2) + 'd' (1) = 3 仍在第二片。
    const text = 'a😀bc😀d';
    const slices = buildSlices(text, 4);
    expect(slices.join('')).toBe(text);
    for (const slice of slices) {
      // 没有 lone surrogate：每个切片自己重新迭代 code point 数 = 实际显示字符数
      const codePoints = Array.from(slice);
      // 重新连接代码点 = 切片本身（不含半 surrogate）
      expect(codePoints.join('')).toBe(slice);
    }
  });

  it('全 emoji 长文本：每片 UTF-16 长度不超 maxUtf16', () => {
    // 1000 个 😀，每个占 2 UTF-16 单位 → 总 2000 UTF-16 单位
    const text = '😀'.repeat(1000);
    const slices = buildSlices(text, 100);
    expect(slices.join('')).toBe(text);
    for (const slice of slices) {
      expect(slice.length).toBeLessThanOrEqual(100);
    }
  });

  it('SLICE_SIZE 默认预算下，全 emoji 切片每片 UTF-16 长度 ≤ Discord 2000 上限', () => {
    const text = '😀'.repeat(5000);
    const slices = buildSlices(text);
    for (const slice of slices) {
      expect(slice.length).toBeLessThanOrEqual(2000);
    }
    expect(slices.join('')).toBe(text);
  });
});

describe('PartialSendError', () => {
  it('携带 sentIds / totalSlices / cause；通过 pino err 序列化器读得到', () => {
    const cause = new Error('rate limit');
    const err = new PartialSendError({
      sentIds: ['m1', 'm2'],
      totalSlices: 5,
      cause,
    });
    expect(err).toBeInstanceOf(PartialSendError);
    expect(err.name).toBe('PartialSendError');
    expect(err.sentIds).toEqual(['m1', 'm2']);
    expect(err.totalSlices).toBe(5);
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('2/5');
    // pino 默认 err serializer 会序列化 enumerable own props——sentIds 必须 enumerable
    const ownKeys = Object.keys(err);
    expect(ownKeys).toContain('sentIds');
    expect(ownKeys).toContain('totalSlices');
  });
});

describe('buildBotMentionRegex', () => {
  it('剥 plain 和 nick 两种 mention 形式', () => {
    const re = buildBotMentionRegex(BOT_ID);
    expect(`hi <@${BOT_ID}> there`.replace(re, '#')).toBe('hi # there');
    expect(`hi <@!${BOT_ID}> there`.replace(re, '#')).toBe('hi # there');
  });

  it('不剥别人的 mention', () => {
    const re = buildBotMentionRegex(BOT_ID);
    const out = `<@${BOT_ID}> ping <@${OTHER_ID}>`.replace(re, '');
    expect(out.trim()).toBe(`ping <@${OTHER_ID}>`);
  });

  it('对 botUserId 内的 regex 元字符做 escape（防御未来类型放宽）', () => {
    const re = buildBotMentionRegex('1.2*3');
    // 不应匹配 plain '1x2y3' 之类
    expect('<@1x2y3>'.match(re)).toBeNull();
    expect('<@1.2*3>'.match(re)?.[0]).toBe('<@1.2*3>');
  });
});

describe('parseInbound', () => {
  it('author 是 bot → drop:noise', () => {
    const msg = makeMsg({ content: `<@${BOT_ID}> hello`, authorBot: true });
    expect(parseInbound(msg, BOT_ID, ALLOWED)).toEqual({ kind: 'drop', reason: 'noise' });
  });

  it('Discord system message（pin / join / thread-create 等）→ drop:noise（mention 模式）', () => {
    const msg = makeMsg({ content: `<@${BOT_ID}> someone joined`, system: true });
    expect(parseInbound(msg, BOT_ID, ALLOWED)).toEqual({ kind: 'drop', reason: 'noise' });
  });

  it('author 是机器人本身 → drop:noise（防御 bot 标志位绕过）', () => {
    const msg = makeMsg({
      content: `<@${BOT_ID}> hello`,
      authorId: BOT_ID,
      authorBot: false,
    });
    expect(parseInbound(msg, BOT_ID, ALLOWED)).toEqual({ kind: 'drop', reason: 'noise' });
  });

  it('没显式 @ 本机器人 → drop:no-mention', () => {
    const msg = makeMsg({ content: 'hello world' });
    expect(parseInbound(msg, BOT_ID, ALLOWED)).toEqual({ kind: 'drop', reason: 'no-mention' });
  });

  it('提到的是别人不是本机器人 → drop:no-mention', () => {
    const msg = makeMsg({ content: `<@${OTHER_ID}> hi` });
    expect(parseInbound(msg, BOT_ID, ALLOWED)).toEqual({ kind: 'drop', reason: 'no-mention' });
  });

  it('@bot ping → text=ping，sessionKey 取 channelId + author.id', () => {
    const msg = makeMsg({
      content: `<@${BOT_ID}> ping`,
      channelId: 'C42',
      authorId: 'U7',
    });
    const ev = expectEvent(parseInbound(msg, BOT_ID, ALLOWED));
    expect(ev.text).toBe('ping');
    expect(ev.sessionKey).toEqual({
      platform: 'discord',
      channelId: 'C42',
      initiatorUserId: 'U7',
    });
    expect(ev.platform).toBe('discord');
    expect(ev.type).toBe('message');
    expect(ev.messageId).toBe('m-1');
  });

  it('@bot summarise what @alice said → 保留 @alice，不剥别人 mention（修 #7）', () => {
    const msg = makeMsg({
      content: `<@${BOT_ID}> summarise what <@${OTHER_ID}> said`,
    });
    const ev = expectEvent(parseInbound(msg, BOT_ID, ALLOWED));
    expect(ev.text).toBe(`summarise what <@${OTHER_ID}> said`);
  });

  it('nick 形式 mention `<@!id>` 同样可识别并剥', () => {
    const msg = makeMsg({ content: `<@!${BOT_ID}>   nick form` });
    const ev = expectEvent(parseInbound(msg, BOT_ID, ALLOWED));
    expect(ev.text).toBe('nick form');
  });

  it('text 为空但有 mention → text 是空串，仍构造事件', () => {
    const msg = makeMsg({ content: `<@${BOT_ID}>` });
    const ev = expectEvent(parseInbound(msg, BOT_ID, ALLOWED));
    expect(ev.text).toBe('');
  });

  it('initiator 字段从 author 取', () => {
    const msg = makeMsg({
      content: `<@${BOT_ID}> hi`,
      authorId: 'U-init',
      authorUsername: 'theuser',
    });
    const ev = expectEvent(parseInbound(msg, BOT_ID, ALLOWED));
    expect(ev.initiator).toEqual({
      userId: 'U-init',
      displayName: 'theuser',
      isBot: false,
    });
  });
});

describe('parseInbound: replyMode="all"', () => {
  it('没 @bot 也产事件，text 等于消息原文（无 mention 可剥）', () => {
    const msg = makeMsg({ content: 'hello world' });
    const ev = expectEvent(parseInbound(msg, BOT_ID, ALLOWED, 'all'));
    expect(ev.text).toBe('hello world');
    expect(ev.type).toBe('message');
  });

  it('author 是 bot → drop:noise（前置 guard 不变）', () => {
    const msg = makeMsg({ content: 'hello', authorBot: true });
    expect(parseInbound(msg, BOT_ID, ALLOWED, 'all')).toEqual({ kind: 'drop', reason: 'noise' });
  });

  it('author 是机器人本身 → drop:noise（自回环 guard）', () => {
    const msg = makeMsg({ content: 'hello', authorId: BOT_ID, authorBot: false });
    expect(parseInbound(msg, BOT_ID, ALLOWED, 'all')).toEqual({ kind: 'drop', reason: 'noise' });
  });

  it('Discord system message → drop:noise（all 模式同样过滤，避免把"用户加入频道"投到 daemon）', () => {
    const msg = makeMsg({ content: 'someone pinned a message', system: true });
    expect(parseInbound(msg, BOT_ID, ALLOWED, 'all')).toEqual({ kind: 'drop', reason: 'noise' });
  });

  it('用户 @bot 时 mention 仍然被剥（保持文本干净）', () => {
    const msg = makeMsg({ content: `<@${BOT_ID}> ping` });
    const ev = expectEvent(parseInbound(msg, BOT_ID, ALLOWED, 'all'));
    expect(ev.text).toBe('ping');
  });

  it('保留对其他用户的 @mention', () => {
    const msg = makeMsg({ content: `summarise what <@${OTHER_ID}> said` });
    const ev = expectEvent(parseInbound(msg, BOT_ID, ALLOWED, 'all'));
    expect(ev.text).toBe(`summarise what <@${OTHER_ID}> said`);
  });

  it('sessionKey 仍按 (channelId, author.id) 构造', () => {
    const msg = makeMsg({ content: 'hi', channelId: 'C99', authorId: 'U_X' });
    const ev = expectEvent(parseInbound(msg, BOT_ID, ALLOWED, 'all'));
    expect(ev.sessionKey).toEqual({
      platform: 'discord',
      channelId: 'C99',
      initiatorUserId: 'U_X',
    });
  });
});

describe('parseInbound: 默认参数省略时退化到 mention 模式', () => {
  it('调用 parseInbound(msg, botId, allowed) 等价于 replyMode="mention"', () => {
    const msg = makeMsg({ content: 'hello world without mention' });
    expect(parseInbound(msg, BOT_ID, ALLOWED)).toEqual({ kind: 'drop', reason: 'no-mention' });
    expect(parseInbound(msg, BOT_ID, ALLOWED, 'mention')).toEqual({ kind: 'drop', reason: 'no-mention' });
  });
});

describe('parseInbound: 用户白名单（fail-closed）', () => {
  it('mention 模式 + author 在 allowlist + @bot → 产事件', () => {
    const msg = makeMsg({ content: `<@${BOT_ID}> hello`, authorId: OTHER_ID });
    expect(parseInbound(msg, BOT_ID, [OTHER_ID]).kind).toBe('event');
  });

  it('mention 模式 + author 不在 allowlist + @bot → drop:unauthorized（即便 mention 命中也拦下）', () => {
    const msg = makeMsg({ content: `<@${BOT_ID}> hello`, authorId: 'NOT_ALLOWED' });
    expect(parseInbound(msg, BOT_ID, [OTHER_ID])).toEqual({ kind: 'drop', reason: 'unauthorized' });
  });

  it('all 模式 + author 在 allowlist → 产事件', () => {
    const msg = makeMsg({ content: 'hi', authorId: OTHER_ID });
    expect(parseInbound(msg, BOT_ID, [OTHER_ID], 'all').kind).toBe('event');
  });

  it('all 模式 + author 不在 allowlist → drop:unauthorized（公开面靠这道 guard 兜住）', () => {
    const msg = makeMsg({ content: 'hi from rando', authorId: 'NOT_ALLOWED' });
    expect(parseInbound(msg, BOT_ID, [OTHER_ID], 'all')).toEqual({ kind: 'drop', reason: 'unauthorized' });
  });

  it('空 allowlist → 任何用户都被拒（mention 模式）', () => {
    const msg = makeMsg({ content: `<@${BOT_ID}> hi`, authorId: OTHER_ID });
    expect(parseInbound(msg, BOT_ID, [])).toEqual({ kind: 'drop', reason: 'unauthorized' });
  });

  it('空 allowlist → 任何用户都被拒（all 模式）', () => {
    const msg = makeMsg({ content: 'hi', authorId: OTHER_ID });
    expect(parseInbound(msg, BOT_ID, [], 'all')).toEqual({ kind: 'drop', reason: 'unauthorized' });
  });

  it('allowlist 多 user → 列表内全部放行', () => {
    const allow = ['U_a', 'U_b', 'U_c'];
    expect(parseInbound(makeMsg({ content: `<@${BOT_ID}> hi`, authorId: 'U_a' }), BOT_ID, allow).kind).toBe('event');
    expect(parseInbound(makeMsg({ content: `<@${BOT_ID}> hi`, authorId: 'U_b' }), BOT_ID, allow).kind).toBe('event');
    expect(parseInbound(makeMsg({ content: `<@${BOT_ID}> hi`, authorId: 'U_c' }), BOT_ID, allow).kind).toBe('event');
    expect(
      parseInbound(makeMsg({ content: `<@${BOT_ID}> hi`, authorId: 'U_d' }), BOT_ID, allow),
    ).toEqual({ kind: 'drop', reason: 'unauthorized' });
  });

  it('allowlist guard 在 system / bot / self guard 之后（前三道返 drop:noise，不报 unauthorized）', () => {
    // 这条断言把"guard 顺序"显式钉成测试——保证未来重排顺序时不会让 system / bot / self
    // 误报成 unauthorized 触发不该有的日志。
    expect(
      parseInbound(makeMsg({ content: 'sys', authorId: OTHER_ID, system: true }), BOT_ID, [OTHER_ID]),
    ).toEqual({ kind: 'drop', reason: 'noise' });
    expect(
      parseInbound(makeMsg({ content: 'b', authorId: OTHER_ID, authorBot: true }), BOT_ID, [OTHER_ID]),
    ).toEqual({ kind: 'drop', reason: 'noise' });
    expect(
      parseInbound(makeMsg({ content: 's', authorId: BOT_ID }), BOT_ID, [BOT_ID]),
    ).toEqual({ kind: 'drop', reason: 'noise' });
  });
});

/**
 * send() MessageRef shape tests.
 *
 * Mocking the discord.js Client built inside createDiscordPlatform requires vi.mock
 * hoisting, so this file tests the logic send() runs internally as a white-box test:
 * - buildSlices (slice count)
 * - slice ID collection → MessageRef shape (messageId = last slice, messageIds = all)
 *
 * The end-to-end send() integration test (with the Discord API mocked) is tracked
 * separately as an issue #30 follow-up.
 */
describe('send: MessageRef shape (short vs long text)', () => {
  /** Reproduces send()'s internal loop with a stubbed channel send for assertions. */
  async function simulateSend(text: string, idPrefix = 'msg') {
    let seq = 0;
    const fakeSend = vi.fn(async (_content: string) => ({ id: `${idPrefix}-${++seq}` }));
    const slices = buildSlices(text);
    const sentIds: string[] = [];
    for (const slice of slices) {
      const msg = await fakeSend(slice);
      sentIds.push(msg.id);
    }
    return { sentIds, fakeSend };
  }

  it('short text (< SLICE_SIZE) → messageIds has 1 element, equal to messageId', async () => {
    const { sentIds } = await simulateSend('hello', 'short');
    const lastId = sentIds[sentIds.length - 1];

    expect(sentIds).toHaveLength(1);
    expect(lastId).toBe(sentIds[0]);
    // MessageRef shape check
    const ref = { messageId: lastId, messageIds: sentIds };
    expect(ref.messageIds).toHaveLength(1);
    expect(ref.messageId).toBe(ref.messageIds[0]);
  });

  it('long text (2×SLICE_SIZE + 50) → messageIds has 3 elements, messageId is the last ID', async () => {
    const longText = 'x'.repeat(SLICE_SIZE * 2 + 50);
    const { sentIds, fakeSend } = await simulateSend(longText, 'long');
    const lastId = sentIds[sentIds.length - 1];

    expect(sentIds).toHaveLength(3);
    expect(sentIds).toEqual(['long-1', 'long-2', 'long-3']);
    expect(lastId).toBe('long-3');
    expect(fakeSend).toHaveBeenCalledTimes(3);

    // MessageRef shape check
    const ref = { messageId: lastId, messageIds: sentIds };
    expect(ref.messageIds).toHaveLength(3);
    expect(ref.messageId).toBe(ref.messageIds[ref.messageIds.length - 1]);
  });

  it('SLICE_SIZE + 1 text → messageIds has 2 elements', async () => {
    const text = 'y'.repeat(SLICE_SIZE + 1);
    const { sentIds } = await simulateSend(text, 'm');

    expect(sentIds).toHaveLength(2);
    expect(sentIds).toEqual(['m-1', 'm-2']);
    const ref = { messageId: sentIds[sentIds.length - 1], messageIds: sentIds };
    expect(ref.messageId).toBe('m-2');
    expect(ref.messageIds[0]).toBe('m-1');
  });

  /**
   * 多片 send 中途失败：模拟 send() 内部的 try/catch 路径，验证 PartialSendError 携带
   * 已发的 sentIds。end-to-end 集成（mock discord.js Client）走 #30 follow-up。
   */
  it('中途失败 → 抛 PartialSendError 携带前 N 片 sentIds', async () => {
    const text = 'z'.repeat(SLICE_SIZE * 2 + 1); // 3 片
    const slices = buildSlices(text);
    expect(slices).toHaveLength(3);

    let seq = 0;
    const sendErr = new Error('rate limit');
    const fakeSend = vi.fn(async (_content: string) => {
      seq += 1;
      if (seq === 2) throw sendErr;
      return { id: `pf-${seq}` };
    });

    const sentIds: string[] = [];
    let caught: unknown;
    try {
      for (const slice of slices) {
        const msg = await fakeSend(slice);
        sentIds.push(msg.id);
      }
    } catch (err) {
      caught = new PartialSendError({
        sentIds,
        totalSlices: slices.length,
        cause: err,
      });
    }

    expect(caught).toBeInstanceOf(PartialSendError);
    const partial = caught as PartialSendError;
    expect(partial.sentIds).toEqual(['pf-1']);
    expect(partial.totalSlices).toBe(3);
    expect(partial.cause).toBe(sendErr);
    expect(fakeSend).toHaveBeenCalledTimes(2);
  });
});
