import { describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';
import { buildBotMentionRegex, buildSlices, parseInbound, SLICE_SIZE } from './index.js';

const BOT_ID = '900000000000000001';
const OTHER_ID = '900000000000000002';

function makeMsg(overrides: {
  content: string;
  authorId?: string;
  authorBot?: boolean;
  authorUsername?: string;
  channelId?: string;
  id?: string;
}): Message {
  const {
    content,
    authorId = OTHER_ID,
    authorBot = false,
    authorUsername = 'alice',
    channelId = 'C1',
    id = 'm-1',
  } = overrides;
  // 只构造测试覆盖路径需要的字段；rawPayload 直接挂整个 mock。
  return {
    id,
    content,
    channelId,
    createdAt: new Date(0),
    author: {
      id: authorId,
      username: authorUsername,
      bot: authorBot,
    },
  } as unknown as Message;
}

describe('buildSlices', () => {
  it('空串 → 单元素 [""]（保证至少发一条消息）', () => {
    expect(buildSlices('')).toEqual(['']);
  });

  it('短文本（< SLICE_SIZE）→ 单切片', () => {
    const text = 'hello world';
    const slices = buildSlices(text);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toBe(text);
  });

  it('恰好等于 SLICE_SIZE → 单切片', () => {
    const text = 'a'.repeat(SLICE_SIZE);
    const slices = buildSlices(text);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toHaveLength(SLICE_SIZE);
  });

  it('超过 SLICE_SIZE → 多切片，全部拼回等于原文', () => {
    const text = 'b'.repeat(SLICE_SIZE * 2 + 100);
    const slices = buildSlices(text);
    expect(slices).toHaveLength(3);
    expect(slices.join('')).toBe(text);
  });

  it('自定义 sliceSize', () => {
    const slices = buildSlices('abcde', 2);
    expect(slices).toEqual(['ab', 'cd', 'e']);
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
  it('author 是 bot → null', () => {
    const msg = makeMsg({ content: `<@${BOT_ID}> hello`, authorBot: true });
    expect(parseInbound(msg, BOT_ID)).toBeNull();
  });

  it('author 是机器人本身 → null（防御 bot 标志位绕过）', () => {
    const msg = makeMsg({
      content: `<@${BOT_ID}> hello`,
      authorId: BOT_ID,
      authorBot: false,
    });
    expect(parseInbound(msg, BOT_ID)).toBeNull();
  });

  it('没显式 @ 本机器人 → null', () => {
    const msg = makeMsg({ content: 'hello world' });
    expect(parseInbound(msg, BOT_ID)).toBeNull();
  });

  it('提到的是别人不是本机器人 → null', () => {
    const msg = makeMsg({ content: `<@${OTHER_ID}> hi` });
    expect(parseInbound(msg, BOT_ID)).toBeNull();
  });

  it('@bot ping → text=ping，sessionKey 取 channelId + author.id', () => {
    const msg = makeMsg({
      content: `<@${BOT_ID}> ping`,
      channelId: 'C42',
      authorId: 'U7',
    });
    const ev = parseInbound(msg, BOT_ID);
    expect(ev).not.toBeNull();
    expect(ev!.text).toBe('ping');
    expect(ev!.sessionKey).toEqual({
      platform: 'discord',
      channelId: 'C42',
      initiatorUserId: 'U7',
    });
    expect(ev!.platform).toBe('discord');
    expect(ev!.type).toBe('message');
    expect(ev!.messageId).toBe('m-1');
  });

  it('@bot summarise what @alice said → 保留 @alice，不剥别人 mention（修 #7）', () => {
    const msg = makeMsg({
      content: `<@${BOT_ID}> summarise what <@${OTHER_ID}> said`,
    });
    const ev = parseInbound(msg, BOT_ID);
    expect(ev).not.toBeNull();
    expect(ev!.text).toBe(`summarise what <@${OTHER_ID}> said`);
  });

  it('nick 形式 mention `<@!id>` 同样可识别并剥', () => {
    const msg = makeMsg({ content: `<@!${BOT_ID}>   nick form` });
    const ev = parseInbound(msg, BOT_ID);
    expect(ev).not.toBeNull();
    expect(ev!.text).toBe('nick form');
  });

  it('text 为空但有 mention → text 是空串，仍构造事件', () => {
    const msg = makeMsg({ content: `<@${BOT_ID}>` });
    const ev = parseInbound(msg, BOT_ID);
    expect(ev).not.toBeNull();
    expect(ev!.text).toBe('');
  });

  it('initiator 字段从 author 取', () => {
    const msg = makeMsg({
      content: `<@${BOT_ID}> hi`,
      authorId: 'U-init',
      authorUsername: 'theuser',
    });
    const ev = parseInbound(msg, BOT_ID);
    expect(ev!.initiator).toEqual({
      userId: 'U-init',
      displayName: 'theuser',
      isBot: false,
    });
  });
});

/**
 * send() の MessageRef 形态テスト。
 *
 * createDiscordPlatform が内部で作る Discord.js Client をモックするには vi.mock hoisting
 * が必要なため、ここでは send() が内部で行うロジックを直接テストする白箱テストとする。
 * - buildSlices（切片数の検証）
 * - 切片 ID 収集 → MessageRef 構造（messageId = 最後の切片、messageIds = 全切片）
 *
 * end-to-end の send() 結合テストは integration/e2e テスト（Discord API モック込み）で
 * 別途カバーする予定（issue #30 follow-up）。
 */
describe('send: MessageRef 形态（短文本 vs 長文本）', () => {
  /** send() 内部ロジックを再現するヘルパー。チャンネルの send を差し替えてテスト。 */
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

  it('短文本（< SLICE_SIZE）→ messageIds が1要素、messageId と一致', async () => {
    const { sentIds } = await simulateSend('hello', 'short');
    const lastId = sentIds[sentIds.length - 1];

    expect(sentIds).toHaveLength(1);
    expect(lastId).toBe(sentIds[0]);
    // MessageRef 形态確認
    const ref = { messageId: lastId, messageIds: sentIds };
    expect(ref.messageIds).toHaveLength(1);
    expect(ref.messageId).toBe(ref.messageIds[0]);
  });

  it('長文本（2×SLICE_SIZE + 50）→ messageIds が3要素、messageId は最後のID', async () => {
    const longText = 'x'.repeat(SLICE_SIZE * 2 + 50);
    const { sentIds, fakeSend } = await simulateSend(longText, 'long');
    const lastId = sentIds[sentIds.length - 1];

    expect(sentIds).toHaveLength(3);
    expect(sentIds).toEqual(['long-1', 'long-2', 'long-3']);
    expect(lastId).toBe('long-3');
    expect(fakeSend).toHaveBeenCalledTimes(3);

    // MessageRef 形态確認
    const ref = { messageId: lastId, messageIds: sentIds };
    expect(ref.messageIds).toHaveLength(3);
    expect(ref.messageId).toBe(ref.messageIds[ref.messageIds.length - 1]);
  });

  it('SLICE_SIZE + 1 の文本 → messageIds が2要素', async () => {
    const text = 'y'.repeat(SLICE_SIZE + 1);
    const { sentIds } = await simulateSend(text, 'm');

    expect(sentIds).toHaveLength(2);
    expect(sentIds).toEqual(['m-1', 'm-2']);
    const ref = { messageId: sentIds[sentIds.length - 1], messageIds: sentIds };
    expect(ref.messageId).toBe('m-2');
    expect(ref.messageIds[0]).toBe('m-1');
  });
});
