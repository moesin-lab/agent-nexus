import { describe, expect, it } from 'vitest';
import type { Message } from 'discord.js';
import { buildBotMentionRegex, parseInbound } from './index.js';

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
