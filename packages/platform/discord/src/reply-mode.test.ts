import { describe, expect, it, vi } from 'vitest';
import {
  assertBotUserIdMatch,
  handleReplyModeInteraction,
  replyModeCommandDefinition,
  type ReplyModeContext,
  type ReplyModeInteractionLike,
} from './reply-mode.js';

function makeLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

function makeInteraction(overrides: {
  userId: string;
  // 接 string 而非 'mention' | 'all'，因为 ReplyModeInteractionLike.options.getString
  // 签名本身是 string | null——测试需要能塞 'banana' 这类非法值验证防御 branch。
  modeOption?: string | null;
  commandName?: string;
}): ReplyModeInteractionLike & { reply: ReturnType<typeof vi.fn> } {
  const { userId, modeOption = null, commandName = 'reply-mode' } = overrides;
  const reply = vi.fn(async () => undefined);
  return {
    commandName,
    user: { id: userId },
    options: {
      getString: (name: string) => (name === 'mode' ? modeOption : null),
    },
    reply,
  };
}

describe('replyModeCommandDefinition', () => {
  it('暴露 name=reply-mode + 一个可选的 mode 选项（choices: mention/all）', () => {
    const def = replyModeCommandDefinition();
    expect(def.name).toBe('reply-mode');
    expect(def.options).toHaveLength(1);
    const opt = def.options![0]!;
    expect(opt.name).toBe('mode');
    expect(opt.required).toBe(false);
    const choiceValues = opt.choices?.map((c) => c.value).sort();
    expect(choiceValues).toEqual(['all', 'mention']);
  });
});

describe('handleReplyModeInteraction：授权拦截', () => {
  it('未命中 allowedUserIds → ephemeral ack 含调用方 user id，不修改状态，打 unauthorized 日志', async () => {
    const logger = makeLogger();
    const setMode = vi.fn();
    const ctx: ReplyModeContext = {
      allowedUserIds: ['OWNER1', 'OWNER2'],
      getMode: () => 'mention',
      setMode,
      logger,
    };
    const interaction = makeInteraction({ userId: 'NOT_OWNER', modeOption: 'all' });

    await handleReplyModeInteraction(interaction, ctx);

    expect(setMode).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    const arg = interaction.reply.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toHaveProperty('ephemeral', true);
    expect(String(arg['content'])).toContain('NOT_OWNER');
    expect(String(arg['content']).toLowerCase()).toContain('permission denied');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'NOT_OWNER' }),
      'discord_reply_mode_unauthorized',
    );
  });

  it('allowedUserIds 为空数组 → 任意用户都被拒（仍 ephemeral ack 含 user id）', async () => {
    const logger = makeLogger();
    const setMode = vi.fn();
    const ctx: ReplyModeContext = {
      allowedUserIds: [],
      getMode: () => 'mention',
      setMode,
      logger,
    };
    const interaction = makeInteraction({ userId: 'ANY_USER', modeOption: 'all' });

    await handleReplyModeInteraction(interaction, ctx);

    expect(setMode).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    const arg = interaction.reply.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toHaveProperty('ephemeral', true);
    expect(String(arg['content'])).toContain('ANY_USER');
  });

  it('日志只记 user id，不写 username（避免 PII 漂移）', async () => {
    const logger = makeLogger();
    const ctx: ReplyModeContext = {
      allowedUserIds: ['OWNER1'],
      getMode: () => 'mention',
      setMode: vi.fn(),
      logger,
    };
    const interaction = makeInteraction({ userId: 'NOT_OWNER' });

    await handleReplyModeInteraction(interaction, ctx);

    const payload = logger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('username');
  });
});

describe('handleReplyModeInteraction：授权通过 + 查询', () => {
  it('mode 参数缺省 → ephemeral ack 当前模式，不调用 setMode', async () => {
    const logger = makeLogger();
    const setMode = vi.fn();
    const ctx: ReplyModeContext = {
      allowedUserIds: ['OWNER1'],
      getMode: () => 'all',
      setMode,
      logger,
    };
    const interaction = makeInteraction({ userId: 'OWNER1', modeOption: null });

    await handleReplyModeInteraction(interaction, ctx);

    expect(setMode).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    const arg = interaction.reply.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toHaveProperty('ephemeral', true);
    expect(String(arg['content'])).toContain('all');
  });
});

describe('handleReplyModeInteraction：授权通过 + 切换', () => {
  it("mode='all' → setMode('all') + ephemeral ack", async () => {
    const logger = makeLogger();
    const setMode = vi.fn(async () => undefined);
    const ctx: ReplyModeContext = {
      allowedUserIds: ['OWNER1'],
      getMode: () => 'mention',
      setMode,
      logger,
    };
    const interaction = makeInteraction({ userId: 'OWNER1', modeOption: 'all' });

    await handleReplyModeInteraction(interaction, ctx);

    expect(setMode).toHaveBeenCalledWith('all');
    expect(interaction.reply).toHaveBeenCalledOnce();
    const arg = interaction.reply.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toHaveProperty('ephemeral', true);
    expect(String(arg['content'])).toContain('all');
  });

  it("mode='mention' → setMode('mention')", async () => {
    const logger = makeLogger();
    const setMode = vi.fn(async () => undefined);
    const ctx: ReplyModeContext = {
      allowedUserIds: ['OWNER1'],
      getMode: () => 'all',
      setMode,
      logger,
    };
    const interaction = makeInteraction({ userId: 'OWNER1', modeOption: 'mention' });

    await handleReplyModeInteraction(interaction, ctx);

    expect(setMode).toHaveBeenCalledWith('mention');
  });

  it("requested 与当前模式一致（no-op）→ 不调用 setMode、ack 含 'already'、打 _noop 而不是 _changed", async () => {
    const logger = makeLogger();
    const setMode = vi.fn(async () => undefined);
    const ctx: ReplyModeContext = {
      allowedUserIds: ['OWNER1'],
      getMode: () => 'mention',
      setMode,
      logger,
    };
    const interaction = makeInteraction({ userId: 'OWNER1', modeOption: 'mention' });

    await handleReplyModeInteraction(interaction, ctx);

    // 不写文件
    expect(setMode).not.toHaveBeenCalled();
    // ack 内容含 already
    expect(interaction.reply).toHaveBeenCalledOnce();
    const arg = interaction.reply.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toHaveProperty('ephemeral', true);
    expect(String(arg['content']).toLowerCase()).toContain('already');
    expect(String(arg['content'])).toContain('mention');
    // 打 _noop 而不是 _changed
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'mention', userId: 'OWNER1' }),
      'discord_reply_mode_noop',
    );
    const allEvents = logger.info.mock.calls.map((c) => c[1]);
    expect(allEvents).not.toContain('discord_reply_mode_changed');
  });

  it('打 info 日志 discord_reply_mode_changed，含 from/to', async () => {
    const logger = makeLogger();
    const ctx: ReplyModeContext = {
      allowedUserIds: ['OWNER1'],
      getMode: () => 'mention',
      setMode: vi.fn(async () => undefined),
      logger,
    };
    const interaction = makeInteraction({ userId: 'OWNER1', modeOption: 'all' });

    await handleReplyModeInteraction(interaction, ctx);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'mention', to: 'all', userId: 'OWNER1' }),
      'discord_reply_mode_changed',
    );
  });
});

describe('handleReplyModeInteraction：非法 mode 防御 branch', () => {
  it("非法 mode（如 'banana'）→ 不调 setMode、ack 含 'invalid' 且 ephemeral，不打 _changed/_noop", async () => {
    const logger = makeLogger();
    const setMode = vi.fn(async () => undefined);
    const ctx: ReplyModeContext = {
      allowedUserIds: ['OWNER1'],
      getMode: () => 'mention',
      setMode,
      logger,
    };
    // Discord choices 理论上拦住非法值，但接 stringly-typed 输入仍要兜底；
    // 直接塞 'banana' 验证防御 branch
    const interaction = makeInteraction({ userId: 'OWNER1', modeOption: 'banana' });

    await handleReplyModeInteraction(interaction, ctx);

    expect(setMode).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    const arg = interaction.reply.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toHaveProperty('ephemeral', true);
    expect(String(arg['content']).toLowerCase()).toContain('invalid');
    // 既不打 changed 也不打 noop——非法路径走自己的 branch
    const allEvents = logger.info.mock.calls.map((c) => c[1]);
    expect(allEvents).not.toContain('discord_reply_mode_changed');
    expect(allEvents).not.toContain('discord_reply_mode_noop');
  });

  it('空字符串 mode → 同样走防御 branch', async () => {
    const logger = makeLogger();
    const setMode = vi.fn(async () => undefined);
    const ctx: ReplyModeContext = {
      allowedUserIds: ['OWNER1'],
      getMode: () => 'mention',
      setMode,
      logger,
    };
    const interaction = makeInteraction({ userId: 'OWNER1', modeOption: '' });

    await handleReplyModeInteraction(interaction, ctx);

    expect(setMode).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    const arg = interaction.reply.mock.calls[0]![0] as Record<string, unknown>;
    expect(String(arg['content']).toLowerCase()).toContain('invalid');
  });
});

describe('assertBotUserIdMatch', () => {
  it('一致 → info discord_ready，不打 warn', () => {
    const logger = makeLogger();
    assertBotUserIdMatch({
      actualId: 'BOT_ID_1',
      configId: 'BOT_ID_1',
      tag: 'mybot#0001',
      logger,
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'mybot#0001' }),
      'discord_ready',
    );
  });

  it('漂移 → warn discord_bot_user_id_mismatch，含 config + actual', () => {
    const logger = makeLogger();
    assertBotUserIdMatch({
      actualId: 'ACTUAL_ID',
      configId: 'CONFIG_ID',
      tag: 'mybot#0001',
      logger,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        configBotUserId: 'CONFIG_ID',
        actualUserId: 'ACTUAL_ID',
      }),
      'discord_bot_user_id_mismatch',
    );
    // ready info 仍然要打（不阻断启动）
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'mybot#0001' }),
      'discord_ready',
    );
  });

  it('actualId 是 undefined（client.user 还没就绪）→ 也按漂移处理 warn', () => {
    const logger = makeLogger();
    assertBotUserIdMatch({
      actualId: undefined,
      configId: 'CONFIG_ID',
      tag: undefined,
      logger,
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});
