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
  modeOption?: 'mention' | 'all' | null;
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
  it('未命中 ownerUserIds → 不调用 reply、不修改状态、打 unauthorized 日志', async () => {
    const logger = makeLogger();
    const setMode = vi.fn();
    const ctx: ReplyModeContext = {
      ownerUserIds: ['OWNER1', 'OWNER2'],
      getMode: () => 'mention',
      setMode,
      logger,
    };
    const interaction = makeInteraction({ userId: 'NOT_OWNER', modeOption: 'all' });

    await handleReplyModeInteraction(interaction, ctx);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'NOT_OWNER' }),
      'discord_reply_mode_unauthorized',
    );
  });

  it('ownerUserIds 为空数组 → 任意用户都被拒', async () => {
    const logger = makeLogger();
    const setMode = vi.fn();
    const ctx: ReplyModeContext = {
      ownerUserIds: [],
      getMode: () => 'mention',
      setMode,
      logger,
    };
    const interaction = makeInteraction({ userId: 'ANY_USER', modeOption: 'all' });

    await handleReplyModeInteraction(interaction, ctx);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
  });

  it('日志只记 user id，不写 username（避免 PII 漂移）', async () => {
    const logger = makeLogger();
    const ctx: ReplyModeContext = {
      ownerUserIds: ['OWNER1'],
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
      ownerUserIds: ['OWNER1'],
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
      ownerUserIds: ['OWNER1'],
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
      ownerUserIds: ['OWNER1'],
      getMode: () => 'all',
      setMode,
      logger,
    };
    const interaction = makeInteraction({ userId: 'OWNER1', modeOption: 'mention' });

    await handleReplyModeInteraction(interaction, ctx);

    expect(setMode).toHaveBeenCalledWith('mention');
  });

  it('打 info 日志 discord_reply_mode_changed，含 from/to', async () => {
    const logger = makeLogger();
    const ctx: ReplyModeContext = {
      ownerUserIds: ['OWNER1'],
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
