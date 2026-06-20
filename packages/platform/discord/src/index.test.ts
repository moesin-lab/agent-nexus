import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { ApplicationCommandOptionType, ChannelType, type Message } from 'discord.js';
import {
  buildBotMentionRegex,
  buildSlices,
  createDiscordPlatform,
  parseInbound,
  PartialSendError,
  SLICE_SIZE,
  type ParsedInbound,
} from './index.js';

const discordMock = vi.hoisted(() => ({
  applicationCommands: undefined as undefined | { set: ReturnType<typeof vi.fn> },
  channelsFetch: vi.fn(),
  clientDestroy: vi.fn(async () => undefined),
  clientLogin: vi.fn(async () => 'logged-in'),
  clientOn: vi.fn(),
}));

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  return {
    ...actual,
    Client: vi.fn(() => ({
      channels: { fetch: discordMock.channelsFetch },
      destroy: discordMock.clientDestroy,
      login: discordMock.clientLogin,
      on: discordMock.clientOn,
      application: { commands: discordMock.applicationCommands },
      user: { id: '900000000000000001', tag: 'bot#0000' },
    })),
  };
});

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

beforeEach(() => {
  vi.clearAllMocks();
  discordMock.applicationCommands = undefined;
});

function makeLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
}

function registeredHandler(eventName: string) {
  const call = discordMock.clientOn.mock.calls.find(
    ([name]) => name === eventName,
  );
  if (!call) throw new Error(`missing handler for ${eventName}`);
  return call[1] as (...args: unknown[]) => unknown;
}

function makeMsg(overrides: {
  content: string;
  authorId?: string;
  authorBot?: boolean;
  authorUsername?: string;
  channelId?: string;
  guildId?: string | null;
  roleIds?: string[];
  id?: string;
  system?: boolean;
  channel?: unknown;
}): Message {
  const {
    content,
    authorId = OTHER_ID,
    authorBot = false,
    authorUsername = 'alice',
    channelId = 'C1',
    guildId,
    roleIds = [],
    id = 'm-1',
    system = false,
    channel,
  } = overrides;
  // 只构造测试覆盖路径需要的字段；rawPayload 直接挂整个 mock。
  return {
    id,
    content,
    channelId,
    guildId,
    createdAt: new Date(0),
    system,
    author: {
      id: authorId,
      username: authorUsername,
      bot: authorBot,
    },
    member: {
      roles: {
        cache: new Map(roleIds.map((roleId) => [roleId, { id: roleId }])),
      },
    },
    ...(channel ? { channel } : {}),
  } as unknown as Message;
}

function makePlatform() {
  return createDiscordPlatform({
    token: 'test-token',
    botUserId: BOT_ID,
    logger: makeLogger(),
    statePath: '/tmp/agent-nexus-discord-state-test.json',
    allowedUserIds: ALLOWED,
  });
}

describe('command registry integration', () => {
  it('ready 时用外部 command registration plan apply，而不是 adapter 内置 legacy 注册', async () => {
    const set = vi.fn(async () => undefined);
    discordMock.applicationCommands = { set };
    const apply = vi.fn(async () => ({ status: 'applied' as const, generation: 'g1' }));
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger: makeLogger(),
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
      commandRegistration: {
        plan: {
          scope: {
            platformName: 'discord-main',
            platformType: 'discord',
            nativeScope: { kind: 'global' },
          },
          commands: [],
          reverseMap: { entries: {} },
          generation: 'g1',
        },
        apply,
      },
    });

    await platform.start(vi.fn());
    const ready = registeredHandler('ready');
    ready();
    await Promise.resolve();

    expect(apply).toHaveBeenCalledTimes(1);
    const [port, plan] = apply.mock.calls[0]!;
    expect(plan.generation).toBe('g1');
    await port.applyCommandPlan(plan);
    expect(set).toHaveBeenCalledWith([], undefined);
  });

  it('ready 时 command registration apply 返回 failed 会明确记录未激活', async () => {
    const logger = makeLogger();
    const apply = vi.fn(async () => ({
      status: 'failed' as const,
      error: {
        code: 'command_registration_failed' as const,
        message: 'remote failed',
      },
    }));
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger,
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
      commandRegistration: {
        plan: {
          scope: {
            platformName: 'discord-main',
            platformType: 'discord',
            nativeScope: { kind: 'global' },
          },
          commands: [],
          reverseMap: { entries: {} },
          generation: 'g1',
        },
        apply,
      },
    });

    await platform.start(vi.fn());
    const ready = registeredHandler('ready');
    ready();
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 'g1',
        errorCode: 'command_registration_failed',
        errorMessage: 'remote failed',
      }),
      'command_registration_apply_failed',
    );
  });

  it('把非 reply-mode chat input slash command 转成 normalized command event', async () => {
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger: makeLogger(),
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
      testGuildId: 'G-dev',
    });
    const handler = vi.fn(async () => undefined);

    await platform.start(handler);
    const interactionCreate = registeredHandler('interactionCreate');
    const deferReply = vi.fn(async () => undefined);
    const deleteReply = vi.fn(async () => undefined);
    const editReply = vi.fn(async () => undefined);
    await interactionCreate({
      id: 'i-1',
      commandName: 'new',
      channelId: 'C1',
      guildId: 'G-dev',
      createdAt: new Date(123),
      user: { id: OTHER_ID, username: 'alice', bot: false },
      member: { roles: { cache: new Map([['R1', { id: 'R1' }]]) } },
      channel: { isThread: () => false },
      options: {
        data: [
          {
            name: 'reason',
            type: ApplicationCommandOptionType.String,
            value: 'fresh',
          },
        ],
      },
      deferReply,
      deleteReply,
      editReply,
      isChatInputCommand: () => true,
    });

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(deleteReply).toHaveBeenCalledTimes(1);
    expect(editReply).not.toHaveBeenCalled();
    const event = handler.mock.calls[0]![0];
    expect(event).toMatchObject({
      eventId: 'i-1',
      platform: 'discord',
      type: 'command',
      command: {
        name: 'new',
        args: { reason: 'fresh' },
        registrationScope: {
          platformName: 'discord',
          platformType: 'discord',
          nativeScope: { kind: 'guild', guildId: 'G-dev' },
        },
      },
      sessionKey: {
        platform: 'discord',
        channelId: 'C1',
        initiatorUserId: OTHER_ID,
      },
      guildId: 'G-dev',
      initiatorRoleIds: ['R1'],
      initiator: {
        userId: OTHER_ID,
        displayName: 'alice',
        isBot: false,
      },
      rawContentType: 'discord:interaction',
    });
    expect(event.traceId).toBeTruthy();
  });

  it('thread slash command event carries the parent channel id', async () => {
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger: makeLogger(),
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
      testGuildId: 'G-dev',
    });
    const handler = vi.fn(async () => undefined);

    await platform.start(handler);
    const interactionCreate = registeredHandler('interactionCreate');
    await interactionCreate({
      id: 'i-thread-command',
      commandName: 'new',
      channelId: 'T1',
      guildId: 'G-dev',
      createdAt: new Date(123),
      user: { id: OTHER_ID, username: 'alice', bot: false },
      member: { roles: { cache: new Map() } },
      channel: { isThread: () => true, parentId: 'C1' },
      options: { data: [] },
      deferReply: vi.fn(async () => undefined),
      deleteReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      isChatInputCommand: () => true,
    });

    expect(handler.mock.calls[0]![0]).toMatchObject({
      sessionKey: { channelId: 'T1' },
      threadParentChannelId: 'C1',
    });
  });

  it('daemon 返回 commandResponse 时用 deferred ephemeral reply 展示反馈', async () => {
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger: makeLogger(),
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
      testGuildId: 'G-dev',
    });
    const handler = vi.fn(async () => ({
      commandResponse: {
        text: 'This command is not available in this channel.',
        ephemeral: true,
      },
    }));

    await platform.start(handler);
    const interactionCreate = registeredHandler('interactionCreate');
    const deferReply = vi.fn(async () => undefined);
    const deleteReply = vi.fn(async () => undefined);
    const editReply = vi.fn(async () => undefined);
    await interactionCreate({
      id: 'i-response',
      commandName: 'new',
      channelId: 'C1',
      guildId: 'G-dev',
      createdAt: new Date(123),
      user: { id: OTHER_ID, username: 'alice', bot: false },
      member: { roles: { cache: new Map() } },
      options: { data: [] },
      deferReply,
      deleteReply,
      editReply,
      isChatInputCommand: () => true,
    });

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(editReply).toHaveBeenCalledWith({
      content: 'This command is not available in this channel.',
    });
    expect(deleteReply).not.toHaveBeenCalled();
  });

  it('daemon commandResponse 带 components 时传给 Discord deferred reply', async () => {
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger: makeLogger(),
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
      testGuildId: 'G-dev',
    });
    const handler = vi.fn(async () => ({
      commandResponse: {
        text: 'Select a session to resume.',
        ephemeral: true,
        components: [
          {
            type: 'string-select' as const,
            customId: 'nexus:sessions:resume',
            placeholder: 'Resume session',
            options: [
              {
                label: 'C-old',
                value: 'mem-1',
                description: 'sid-old',
              },
            ],
          },
        ],
      },
    }));

    await platform.start(handler);
    const interactionCreate = registeredHandler('interactionCreate');
    const editReply = vi.fn(async () => undefined);
    await interactionCreate({
      id: 'i-components',
      commandName: 'nexus-sessions',
      channelId: 'C1',
      guildId: 'G-dev',
      createdAt: new Date(123),
      user: { id: OTHER_ID, username: 'alice', bot: false },
      member: { roles: { cache: new Map() } },
      options: { data: [] },
      deferReply: vi.fn(async () => undefined),
      deleteReply: vi.fn(async () => undefined),
      editReply,
      isChatInputCommand: () => true,
    });

    expect(editReply).toHaveBeenCalledWith({
      content: 'Select a session to resume.',
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: 'nexus:sessions:resume',
              placeholder: 'Resume session',
              options: [
                {
                  label: 'C-old',
                  value: 'mem-1',
                  description: 'sid-old',
                },
              ],
              min_values: 1,
              max_values: 1,
            },
          ],
        },
      ],
    });
  });

  it('string select component interaction 转成 normalized interaction event 并展示 handler 反馈', async () => {
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger: makeLogger(),
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
      testGuildId: 'G-dev',
    });
    const handler = vi.fn(async () => ({
      commandResponse: {
        text: '[session resumed: sid-old]',
        ephemeral: true,
      },
    }));

    await platform.start(handler);
    const interactionCreate = registeredHandler('interactionCreate');
    const deferReply = vi.fn(async () => undefined);
    const editReply = vi.fn(async () => undefined);
    await interactionCreate({
      id: 'i-select',
      customId: 'nexus:sessions:resume',
      values: ['mem-1'],
      channelId: 'C1',
      guildId: 'G-dev',
      createdAt: new Date(123),
      user: { id: OTHER_ID, username: 'alice', bot: false },
      member: { roles: { cache: new Map([['R1', { id: 'R1' }]]) } },
      channel: { isThread: () => true, parentId: 'C1' },
      deferReply,
      editReply,
      isChatInputCommand: () => false,
      isStringSelectMenu: () => true,
      isButton: () => false,
    });

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatchObject({
      eventId: 'i-select',
      platform: 'discord',
      type: 'interaction',
      interaction: {
        customId: 'nexus:sessions:resume',
        componentType: 'string-select',
        values: ['mem-1'],
      },
      sessionKey: {
        platform: 'discord',
        channelId: 'C1',
        initiatorUserId: OTHER_ID,
      },
      guildId: 'G-dev',
      initiatorRoleIds: ['R1'],
      threadParentChannelId: 'C1',
      rawContentType: 'discord:component-interaction',
    });
    expect(editReply).toHaveBeenCalledWith({
      content: '[session resumed: sid-old]',
    });
  });

  it('settings workingDir button can open a Discord modal before defer', async () => {
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger: makeLogger(),
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
      testGuildId: 'G-dev',
    });
    const handler = vi.fn(async () => ({
      modalResponse: {
        customId: 'nexus:settings:working-dir-modal',
        title: 'Set working directory',
        textInputs: [
          {
            customId: 'path',
            label: 'Absolute path',
            style: 'short' as const,
            required: true,
          },
        ],
      },
    }));

    await platform.start(handler);
    const interactionCreate = registeredHandler('interactionCreate');
    const deferReply = vi.fn(async () => undefined);
    const showModal = vi.fn(async () => undefined);
    await interactionCreate({
      id: 'i-working-dir',
      customId: 'nexus:settings:working-dir',
      channelId: 'C1',
      guildId: 'G-dev',
      createdAt: new Date(123),
      user: { id: OTHER_ID, username: 'alice', bot: false },
      member: { roles: { cache: new Map() } },
      channel: { isThread: () => false },
      deferReply,
      showModal,
      isChatInputCommand: () => false,
      isStringSelectMenu: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
    });

    expect(deferReply).not.toHaveBeenCalled();
    expect(showModal).toHaveBeenCalledWith({
      custom_id: 'nexus:settings:working-dir-modal',
      title: 'Set working directory',
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'path',
              label: 'Absolute path',
              style: 1,
              required: true,
            },
          ],
        },
      ],
    });
  });

  it('modal submit 转成 normalized interaction fields 并展示 handler 反馈', async () => {
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger: makeLogger(),
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
      testGuildId: 'G-dev',
    });
    const handler = vi.fn(async () => ({
      commandResponse: {
        text: '[channel workingDir: /tmp/app]',
        ephemeral: true,
      },
    }));

    await platform.start(handler);
    const interactionCreate = registeredHandler('interactionCreate');
    const deferReply = vi.fn(async () => undefined);
    const editReply = vi.fn(async () => undefined);
    await interactionCreate({
      id: 'i-modal',
      customId: 'nexus:settings:working-dir-modal',
      channelId: 'C1',
      guildId: 'G-dev',
      createdAt: new Date(123),
      user: { id: OTHER_ID, username: 'alice', bot: false },
      member: { roles: { cache: new Map() } },
      channel: { isThread: () => false },
      fields: {
        fields: new Map([['path', { customId: 'path' }]]),
        getTextInputValue: vi.fn((customId: string) =>
          customId === 'path' ? '/tmp/app' : '',
        ),
      },
      deferReply,
      editReply,
      isChatInputCommand: () => false,
      isStringSelectMenu: () => false,
      isButton: () => false,
      isModalSubmit: () => true,
    });

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'interaction',
        interaction: {
          customId: 'nexus:settings:working-dir-modal',
          componentType: 'modal-submit',
          values: [],
          fields: { path: '/tmp/app' },
        },
      }),
    );
    expect(editReply).toHaveBeenCalledWith({
      content: '[channel workingDir: /tmp/app]',
    });
  });

  it('settingsSnapshot exposes reply-mode with user-scoped permission', async () => {
    const statePath = '/tmp/agent-nexus-discord-settings-snapshot-test.json';
    await rm(statePath, { force: true });
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger: makeLogger(),
      statePath,
      allowedUserIds: [OTHER_ID],
      testGuildId: 'G-dev',
    });

    await platform.start(vi.fn());

    expect(
      await platform.settingsSnapshot!({ userId: OTHER_ID, channelId: 'C1' }),
    ).toEqual({
      items: [
        {
          key: 'discord.replyMode',
          label: 'Reply mode',
          owner: 'platform',
          value: 'mention',
          source: 'discord state',
          durability: 'durable',
          canChange: true,
        },
      ],
    });
    expect(
      await platform.settingsSnapshot!({ userId: 'U-denied', channelId: 'C1' }),
    ).toMatchObject({
      items: [
        {
          key: 'discord.replyMode',
          canChange: false,
        },
      ],
    });
  });

  it('applySettingsAction changes reply-mode through the Discord owner state', async () => {
    const statePath = '/tmp/agent-nexus-discord-settings-action-test.json';
    await rm(statePath, { force: true });
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger: makeLogger(),
      statePath,
      allowedUserIds: [OTHER_ID],
      testGuildId: 'G-dev',
    });

    await platform.start(vi.fn());
    const result = await platform.applySettingsAction!({
      action: 'discord.replyMode',
      value: 'all',
      userId: OTHER_ID,
      channelId: 'C1',
    });

    expect(result).toEqual({
      status: 'handled',
      message: 'reply mode: `mention` -> `all`',
    });
    expect(
      await platform.settingsSnapshot!({ userId: OTHER_ID, channelId: 'C1' }),
    ).toMatchObject({
      items: [
        {
          key: 'discord.replyMode',
          value: 'all',
          canChange: true,
        },
      ],
    });
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({
      replyMode: 'all',
    });
  });

  it('command registration plan 存在时用 plan scope 构造 command event', async () => {
    const plan = {
      scope: {
        platformName: 'discord-main',
        platformType: 'discord' as const,
        nativeScope: { kind: 'guild' as const, guildId: 'G-dev' },
      },
      commands: [],
      reverseMap: { entries: {} },
      generation: 'g-scope',
    };
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger: makeLogger(),
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
      commandRegistration: {
        plan,
        apply: vi.fn(async () => ({ status: 'applied' as const, generation: 'g-scope' })),
      },
    });
    const handler = vi.fn(async () => undefined);

    await platform.start(handler);
    const interactionCreate = registeredHandler('interactionCreate');
    await interactionCreate({
      id: 'i-scope',
      commandName: 'new',
      channelId: 'C1',
      guildId: 'G-dev',
      createdAt: new Date(123),
      user: { id: OTHER_ID, username: 'alice', bot: false },
      member: { roles: { cache: new Map() } },
      options: { data: [] },
      deferReply: vi.fn(async () => undefined),
      deleteReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      isChatInputCommand: () => true,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatchObject({
      command: {
        name: 'new',
        registrationScope: plan.scope,
      },
    });
  });

  it('registration plan 未包含 legacy /reply-mode 时把它作为普通 command 事件交给 daemon', async () => {
    const plan = {
      scope: {
        platformName: 'discord-main',
        platformType: 'discord' as const,
        nativeScope: { kind: 'global' as const },
      },
      commands: [],
      reverseMap: {
        entries: {
          'discord-reply-mode': {
            canonicalId: 'platform:discord:reply-mode',
            aliasKind: 'stable' as const,
            owner: { type: 'platform' as const, platformType: 'discord' },
            handlerKey: 'reply-mode',
          },
        },
      },
      generation: 'g-no-legacy',
    };
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger: makeLogger(),
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
      commandRegistration: {
        plan,
        apply: vi.fn(async () => ({ status: 'applied' as const, generation: 'g-no-legacy' })),
      },
    });
    const handler = vi.fn(async () => undefined);
    const deferReply = vi.fn(async () => undefined);
    const deleteReply = vi.fn(async () => undefined);
    const reply = vi.fn(async () => undefined);

    await platform.start(handler);
    const interactionCreate = registeredHandler('interactionCreate');
    await interactionCreate({
      id: 'i-legacy-off',
      commandName: 'reply-mode',
      channelId: 'C1',
      guildId: 'G-dev',
      createdAt: new Date(123),
      user: { id: OTHER_ID, username: 'alice', bot: false },
      member: { roles: { cache: new Map() } },
      options: { data: [], getString: vi.fn(() => null) },
      deferReply,
      deleteReply,
      editReply: vi.fn(async () => undefined),
      reply,
      isChatInputCommand: () => true,
    });

    expect(reply).not.toHaveBeenCalled();
    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(deleteReply).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatchObject({
      command: {
        name: 'reply-mode',
        registrationScope: plan.scope,
      },
    });
  });

  it('updateAuth 热替换后 reply-mode 授权立即按新 allowlist 判定', async () => {
    const logger = makeLogger();
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger,
      statePath: '/tmp/agent-nexus-missing-dir/reply-mode-auth.json',
      allowedUserIds: ['U-old'],
      commandRegistration: {
        plan: {
          scope: {
            platformName: 'discord-main',
            platformType: 'discord' as const,
            nativeScope: { kind: 'global' as const },
          },
          commands: [],
          reverseMap: {
            entries: {
              'discord-reply-mode': {
                canonicalId: 'platform:discord:reply-mode',
                aliasKind: 'stable' as const,
                owner: { type: 'platform' as const, platformType: 'discord' },
                handlerKey: 'reply-mode',
              },
            },
          },
          generation: 'g-auth-update',
        },
        apply: vi.fn(async () => ({
          status: 'applied' as const,
          generation: 'g-auth-update',
        })),
      },
    });

    await platform.start(vi.fn());
    const interactionCreate = registeredHandler('interactionCreate');
    const makeReplyModeInteraction = (
      userId: string,
      reply: ReturnType<typeof vi.fn>,
    ) => ({
      id: `i-auth-${userId}`,
      commandName: 'discord-reply-mode',
      channelId: 'C1',
      guildId: 'G-dev',
      createdAt: new Date(123),
      user: { id: userId, username: 'u', bot: false },
      member: { roles: { cache: new Map() } },
      options: { data: [], getString: vi.fn(() => null) },
      reply,
      isChatInputCommand: () => true,
    });

    const replyBefore = vi.fn(async () => undefined);
    await interactionCreate(makeReplyModeInteraction('U-new', replyBefore));
    expect(replyBefore).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Permission denied'),
      }),
    );

    platform.updateAuth({ allowedUserIds: ['U-new'], inboundAllowedUserIds: null });

    const replyAfter = vi.fn(async () => undefined);
    await interactionCreate(makeReplyModeInteraction('U-new', replyAfter));
    expect(replyAfter).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('current reply mode'),
      }),
    );

    const replyRemoved = vi.fn(async () => undefined);
    await interactionCreate(makeReplyModeInteraction('U-old', replyRemoved));
    expect(replyRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Permission denied'),
      }),
    );
  });

  it('stable /discord-reply-mode 内部失败时仍回复 ephemeral 错误，避免 Discord 显示未响应', async () => {
    const logger = makeLogger();
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger,
      statePath: '/tmp/agent-nexus-missing-dir/reply-mode.json',
      allowedUserIds: ALLOWED,
      commandRegistration: {
        plan: {
          scope: {
            platformName: 'discord-main',
            platformType: 'discord' as const,
            nativeScope: { kind: 'global' as const },
          },
          commands: [],
          reverseMap: {
            entries: {
              'discord-reply-mode': {
                canonicalId: 'platform:discord:reply-mode',
                aliasKind: 'stable' as const,
                owner: { type: 'platform' as const, platformType: 'discord' },
                handlerKey: 'reply-mode',
              },
            },
          },
          generation: 'g-stable-reply-mode',
        },
        apply: vi.fn(async () => ({
          status: 'applied' as const,
          generation: 'g-stable-reply-mode',
        })),
      },
    });
    const reply = vi.fn(async () => undefined);

    await platform.start(vi.fn());
    const interactionCreate = registeredHandler('interactionCreate');
    await interactionCreate({
      id: 'i-stable-reply-mode-fail',
      commandName: 'discord-reply-mode',
      channelId: 'C1',
      guildId: 'G-dev',
      createdAt: new Date(123),
      user: { id: OTHER_ID, username: 'alice', bot: false },
      member: { roles: { cache: new Map() } },
      options: { data: [], getString: vi.fn(() => 'all') },
      reply,
      isChatInputCommand: () => true,
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ commandName: 'discord-reply-mode' }),
      'discord_interaction_handler_error',
    );
    expect(reply).toHaveBeenCalledWith({
      content: 'Command failed. Try again later.',
      ephemeral: true,
    });
  });
});

function makeTextChannel(overrides: {
  edit?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
  send?: ReturnType<typeof vi.fn>;
  sendTyping?: ReturnType<typeof vi.fn>;
  sendable?: boolean;
} = {}) {
  return {
    isTextBased: () => true,
    isSendable: () => overrides.sendable ?? true,
    messages: {
      edit: overrides.edit ?? vi.fn(async (id: string) => ({ id })),
      delete: overrides.delete ?? vi.fn(async () => undefined),
    },
    send: overrides.send ?? vi.fn(async () => ({ id: 'new-1' })),
    sendTyping: overrides.sendTyping ?? vi.fn(async () => undefined),
  };
}

function makeThreadParentChannel(overrides: {
  create?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    isTextBased: () => true,
    isSendable: () => true,
    threads: {
      create:
        overrides.create ??
        vi.fn(async () => ({
          id: 'T1',
          guildId: 'G1',
          members: { add: vi.fn(async () => undefined) },
          send: vi.fn(async () => ({ id: 'm-thread' })),
          delete: vi.fn(async () => undefined),
        })),
    },
  };
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
      // 真·检测 lone surrogate：用 /\p{Surrogate}/u 找 0xD800-0xDFFF 区间字符
      // （配对正常的 emoji 内部 surrogate 在 code point 迭代后已被合成单字符，
      // 不会被这个正则当 lone 命中——属性匹配看的是 code point，不是 code unit）
      expect(slice).not.toMatch(/\p{Surrogate}/u);
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

  it('退化路径不产生 trailing 空切片：buildSlices("😀😀", 1) === ["😀","😀"]', () => {
    // 预算比单个 code point 还小（cpLen=2 > maxUtf16=1）时走强行切分支；
    // 旧实现末尾无条件 push 会留下 trailing 空串。直接钉住该回归。
    expect(buildSlices('😀😀', 1)).toEqual(['😀', '😀']);
  });

  /**
   * 已知限制（src/index.ts buildSlices doc 已注明）：当前按 code point 迭代，不识别
   * grapheme cluster。下面这组用例把"当前接受的折中行为"显式钉死，避免：
   *   1. 未来误以为已经做到 grapheme-safe；
   *   2. 等 issue #56 stream-json epic 落地后切换到 `Intl.Segmenter` 时，这些用例
   *      会以"应失败"形式提醒重写预期。
   *
   * 注：这些切法不是 lone surrogate（surrogate pair 在 `for…of` 迭代下已被正确合成单
   * code point），只是 grapheme 被劈成两个独立 code point；Discord 渲染端看到的会是
   * 两个独立字符而不是 �。
   */
  describe('known degenerate behavior（grapheme cluster 当前可被劈，钉死等 #56 收掉）', () => {
    it('VS-16（❤️ = U+2764 + U+FE0F）：变体选择符可被切到下一片', () => {
      // ❤(U+2764) 与 VS-16(U+FE0F) 都在 BMP，各 1 UTF-16 单位。
      // 预算 1：第一片 ❤，第二片只剩孤立 VS-16。
      const slices = buildSlices('❤️', 1);
      expect(slices).toHaveLength(2);
      expect(slices[0]).toBe('❤');
      expect(slices[1]).toBe('️');
      expect(slices.join('')).toBe('❤️');
    });

    it('国旗（🇨🇳 = 两个 regional indicator）：可在两个 indicator 间被切', () => {
      // 每个 regional indicator 占 2 UTF-16。预算 2：第一片 🇨，第二片 🇳。
      const slices = buildSlices('🇨🇳', 2);
      expect(slices).toEqual(['\u{1F1E8}', '\u{1F1F3}']);
      expect(slices.join('')).toBe('🇨🇳');
    });

    it('肤色修饰符（👋🏽 = 👋 + 🏽）：可在基础 emoji 与肤色修饰符间被切', () => {
      // 各占 2 UTF-16。预算 2：第一片 👋（无肤色），第二片孤立肤色修饰符。
      const slices = buildSlices('👋🏽', 2);
      expect(slices).toEqual(['\u{1F44B}', '\u{1F3FD}']);
      expect(slices.join('')).toBe('👋🏽');
    });

    it('ZWJ 序列（👨‍👩 = 👨 + ZWJ + 👩）：可在 ZWJ 前后被切', () => {
      // 👨(2) + ZWJ(1) + 👩(2) = 5 UTF-16。预算 3：第一片 👨+ZWJ(3)，第二片 👩(2)。
      const slices = buildSlices('👨‍👩', 3);
      expect(slices).toHaveLength(2);
      expect(slices[0]).toBe('\u{1F468}‍');
      expect(slices[1]).toBe('\u{1F469}');
      expect(slices.join('')).toBe('👨‍👩');
    });
  });
});

describe('PartialSendError', () => {
  it('携带 sentIds / totalSlices / cause 作为 enumerable own props', () => {
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
    // pino 默认 err serializer 会把 enumerable own props 平铺到日志（sentIds / totalSlices 直接落字段）；
    // `cause` 走 pino 自己的 cause-chain 处理（折进 stack 末尾，不作为顶层 key），
    // 但 own property 仍需保留 enumerable 以便 cause 内容随同序列化。
    const ownKeys = Object.keys(err);
    expect(ownKeys).toContain('sentIds');
    expect(ownKeys).toContain('totalSlices');
    expect(ownKeys).toContain('cause');
  });
});

describe('edit / typing capabilities', () => {
  it('声明 supportsEdit=true 和 supportsTypingIndicator=true', () => {
    const platform = makePlatform();

    expect(platform.capabilities()).toMatchObject({
      supportsEdit: true,
      supportsTypingIndicator: true,
      supportsSlashCommands: true,
      supportsThreads: true,
      supportsThreadCreation: true,
    });
  });

  it('createThread creates a private thread, adds the user, and posts the initial message', async () => {
    const memberAdd = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({ id: 'm-thread' }));
    const create = vi.fn(async () => ({
      id: 'T1',
      guildId: 'G1',
      members: { add: memberAdd },
      send,
      delete: vi.fn(async () => undefined),
    }));
    discordMock.channelsFetch.mockResolvedValueOnce(makeThreadParentChannel({ create }));
    const platform = makePlatform();

    const result = await platform.createThread!({
      parentChannelId: 'C1',
      initiatorUserId: OTHER_ID,
      title: 'Design auth flow',
      visibility: 'private',
      autoArchiveDurationMinutes: 1440,
      initialMessage: '[new Nexus session: Design auth flow]',
      traceId: 't-1',
    });

    expect(create).toHaveBeenCalledWith({
      name: 'Design auth flow',
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 1440,
      invitable: false,
      reason: 'agent-nexus new thread',
    });
    expect(memberAdd).toHaveBeenCalledWith(OTHER_ID);
    expect(send).toHaveBeenCalledWith({
      content: '[new Nexus session: Design auth flow]',
      allowedMentions: { parse: [] },
    });
    expect(result).toEqual({
      threadId: 'T1',
      parentChannelId: 'C1',
      url: 'https://discord.com/channels/G1/T1',
    });
  });

  it('createThread deletes the created thread if member add fails', async () => {
    const cleanup = vi.fn(async () => undefined);
    const create = vi.fn(async () => ({
      id: 'T1',
      guildId: 'G1',
      members: { add: vi.fn(async () => Promise.reject(new Error('missing access'))) },
      send: vi.fn(async () => ({ id: 'm-thread' })),
      delete: cleanup,
    }));
    discordMock.channelsFetch.mockResolvedValueOnce(makeThreadParentChannel({ create }));
    const platform = makePlatform();

    await expect(
      platform.createThread!({
        parentChannelId: 'C1',
        initiatorUserId: OTHER_ID,
        title: 'Design auth flow',
        visibility: 'private',
        autoArchiveDurationMinutes: 1440,
        traceId: 't-1',
      }),
    ).rejects.toThrow('missing access');
    expect(cleanup).toHaveBeenCalledWith('agent-nexus thread setup failed');
  });

  it('updateThread renames the Discord thread', async () => {
    const setName = vi.fn(async () => undefined);
    discordMock.channelsFetch.mockResolvedValueOnce({
      setName,
    });
    const platform = makePlatform();

    await platform.updateThread!({
      threadId: 'T1',
      title: 'First user message',
      traceId: 't-1',
    });

    expect(setName).toHaveBeenCalledWith(
      'First user message',
      'agent-nexus session title',
    );
  });

  it('edit 单片消息：用 MessageManager.edit 更新已有 message id', async () => {
    const edit = vi.fn(async (id: string) => ({ id }));
    discordMock.channelsFetch.mockResolvedValueOnce(makeTextChannel({ edit }));
    const platform = makePlatform();
    const ref = {
      platform: 'discord',
      channelId: 'C1',
      messageId: 'm-1',
      messageIds: ['m-1'],
      sentAt: new Date(0),
    };

    await platform.edit(ref, {
      text: 'updated',
      traceId: 't-1',
      sessionKey: { platform: 'discord', channelId: 'C1', initiatorUserId: OTHER_ID },
    });

    expect(edit).toHaveBeenCalledWith('m-1', 'updated');
    expect(ref.messageIds).toEqual(['m-1']);
    expect(ref.messageId).toBe('m-1');
  });

  it('edit 增长到多片：追加发送新 slice 并回写 MessageRef', async () => {
    const edit = vi.fn(async (id: string) => ({ id }));
    const send = vi.fn(async () => ({ id: 'm-2' }));
    discordMock.channelsFetch.mockResolvedValueOnce(makeTextChannel({ edit, send }));
    const platform = makePlatform();
    const ref = {
      platform: 'discord',
      channelId: 'C1',
      messageId: 'm-1',
      messageIds: ['m-1'],
      sentAt: new Date(0),
    };
    const text = 'x'.repeat(SLICE_SIZE + 1);

    await platform.edit(ref, {
      text,
      traceId: 't-1',
      sessionKey: { platform: 'discord', channelId: 'C1', initiatorUserId: OTHER_ID },
    });

    expect(edit).toHaveBeenCalledWith('m-1', 'x'.repeat(SLICE_SIZE));
    expect(send).toHaveBeenCalledWith('x');
    expect(ref.messageIds).toEqual(['m-1', 'm-2']);
    expect(ref.messageId).toBe('m-2');
  });

  it('edit 多片数量不变：只 edit 既有片，不 send / delete，ref 不变', async () => {
    const edit = vi.fn(async (id: string) => ({ id }));
    const send = vi.fn(async () => ({ id: 'new' }));
    const deleteMessage = vi.fn(async () => undefined);
    discordMock.channelsFetch.mockResolvedValueOnce(makeTextChannel({ edit, send, delete: deleteMessage }));
    const platform = makePlatform();
    const ref = {
      platform: 'discord',
      channelId: 'C1',
      messageId: 'm-2',
      messageIds: ['m-1', 'm-2'],
      sentAt: new Date(0),
    };
    const text = 'y'.repeat(SLICE_SIZE + 1);

    await platform.edit(ref, {
      text,
      traceId: 't-1',
      sessionKey: { platform: 'discord', channelId: 'C1', initiatorUserId: OTHER_ID },
    });

    expect(edit).toHaveBeenNthCalledWith(1, 'm-1', 'y'.repeat(SLICE_SIZE));
    expect(edit).toHaveBeenNthCalledWith(2, 'm-2', 'y');
    expect(send).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(ref.messageIds).toEqual(['m-1', 'm-2']);
    expect(ref.messageId).toBe('m-2');
  });

  it('edit 在 channel 不存在或非 text-based 时拒绝', async () => {
    discordMock.channelsFetch.mockResolvedValueOnce(null);
    const platform = makePlatform();

    await expect(platform.edit({
      platform: 'discord',
      channelId: 'missing',
      messageId: 'm-1',
      messageIds: ['m-1'],
      sentAt: new Date(0),
    }, {
      text: 'updated',
      traceId: 't-1',
      sessionKey: { platform: 'discord', channelId: 'missing', initiatorUserId: OTHER_ID },
    })).rejects.toThrow('not text-based or not found');
  });

  it('edit 增长到新片但 channel 不可 send 时拒绝', async () => {
    discordMock.channelsFetch.mockResolvedValueOnce(
      makeTextChannel({ sendable: false }),
    );
    const platform = makePlatform();

    await expect(platform.edit({
      platform: 'discord',
      channelId: 'C1',
      messageId: 'm-1',
      messageIds: ['m-1'],
      sentAt: new Date(0),
    }, {
      text: 'z'.repeat(SLICE_SIZE + 1),
      traceId: 't-1',
      sessionKey: { platform: 'discord', channelId: 'C1', initiatorUserId: OTHER_ID },
    })).rejects.toThrow('cannot send extra edit slices');
  });

  it('edit 收缩到更少片：删除多余旧片并回写 MessageRef', async () => {
    const edit = vi.fn(async (id: string) => ({ id }));
    const deleteMessage = vi.fn(async () => undefined);
    discordMock.channelsFetch.mockResolvedValueOnce(makeTextChannel({ edit, delete: deleteMessage }));
    const platform = makePlatform();
    const ref = {
      platform: 'discord',
      channelId: 'C1',
      messageId: 'm-2',
      messageIds: ['m-1', 'm-2'],
      sentAt: new Date(0),
    };

    await platform.edit(ref, {
      text: 'short',
      traceId: 't-1',
      sessionKey: { platform: 'discord', channelId: 'C1', initiatorUserId: OTHER_ID },
    });

    expect(edit).toHaveBeenCalledWith('m-1', 'short');
    expect(deleteMessage).toHaveBeenCalledWith('m-2');
    expect(ref.messageIds).toEqual(['m-1']);
    expect(ref.messageId).toBe('m-1');
  });

  it('edit 增长中途 send 失败：保留已发送新片 id，下一次从断点继续', async () => {
    const edit = vi.fn(async (id: string) => ({ id }));
    const sendErr = new Error('send extra failed');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ id: 'm-2' })
      .mockRejectedValueOnce(sendErr)
      .mockResolvedValueOnce({ id: 'm-3' });
    discordMock.channelsFetch.mockResolvedValue(makeTextChannel({ edit, send }));
    const platform = makePlatform();
    const ref = {
      platform: 'discord',
      channelId: 'C1',
      messageId: 'm-1',
      messageIds: ['m-1'],
      sentAt: new Date(0),
    };
    const text = 'x'.repeat(SLICE_SIZE * 2 + 1);

    await expect(platform.edit(ref, {
      text,
      traceId: 't-1',
      sessionKey: { platform: 'discord', channelId: 'C1', initiatorUserId: OTHER_ID },
    })).rejects.toBe(sendErr);
    expect(ref.messageIds).toEqual(['m-1', 'm-2']);
    expect(ref.messageId).toBe('m-2');

    await platform.edit(ref, {
      text,
      traceId: 't-2',
      sessionKey: { platform: 'discord', channelId: 'C1', initiatorUserId: OTHER_ID },
    });

    expect(send).toHaveBeenCalledTimes(3);
    expect(ref.messageIds).toEqual(['m-1', 'm-2', 'm-3']);
    expect(ref.messageId).toBe('m-3');
  });

  it('edit 收缩中途 delete 失败：已删除 id 先从 ref 移除，下一次从断点继续', async () => {
    const edit = vi.fn(async (id: string) => ({ id }));
    const deleteErr = new Error('delete failed');
    const deleteMessage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(deleteErr)
      .mockResolvedValueOnce(undefined);
    discordMock.channelsFetch.mockResolvedValue(makeTextChannel({ edit, delete: deleteMessage }));
    const platform = makePlatform();
    const ref = {
      platform: 'discord',
      channelId: 'C1',
      messageId: 'm-3',
      messageIds: ['m-1', 'm-2', 'm-3'],
      sentAt: new Date(0),
    };

    await expect(platform.edit(ref, {
      text: 'short',
      traceId: 't-1',
      sessionKey: { platform: 'discord', channelId: 'C1', initiatorUserId: OTHER_ID },
    })).rejects.toBe(deleteErr);
    expect(ref.messageIds).toEqual(['m-1', 'm-3']);
    expect(ref.messageId).toBe('m-3');

    await platform.edit(ref, {
      text: 'short',
      traceId: 't-2',
      sessionKey: { platform: 'discord', channelId: 'C1', initiatorUserId: OTHER_ID },
    });

    expect(deleteMessage).toHaveBeenNthCalledWith(1, 'm-2');
    expect(deleteMessage).toHaveBeenNthCalledWith(2, 'm-3');
    expect(deleteMessage).toHaveBeenNthCalledWith(3, 'm-3');
    expect(ref.messageIds).toEqual(['m-1']);
    expect(ref.messageId).toBe('m-1');
  });

  it('同一 MessageRef 的并发 edit 串行化，增长片只发送一次', async () => {
    let releaseFirstEdit: (() => void) | undefined;
    const firstEditStarted = new Promise<void>((resolve) => {
      const edit = vi.fn(async (id: string) => {
        if (id === 'm-1' && edit.mock.calls.length === 1) {
          resolve();
          await new Promise<void>((release) => {
            releaseFirstEdit = release;
          });
        }
        return { id };
      });
      const send = vi.fn(async () => ({ id: 'm-2' }));
      discordMock.channelsFetch.mockResolvedValue(makeTextChannel({ edit, send }));
    });
    const platform = makePlatform();
    const ref = {
      platform: 'discord',
      channelId: 'C1',
      messageId: 'm-1',
      messageIds: ['m-1'],
      sentAt: new Date(0),
    };
    const text = 'x'.repeat(SLICE_SIZE + 1);

    const p1 = platform.edit(ref, {
      text,
      traceId: 't-1',
      sessionKey: { platform: 'discord', channelId: 'C1', initiatorUserId: OTHER_ID },
    });
    await firstEditStarted;
    const p2 = platform.edit(ref, {
      text,
      traceId: 't-2',
      sessionKey: { platform: 'discord', channelId: 'C1', initiatorUserId: OTHER_ID },
    });

    releaseFirstEdit?.();
    await Promise.all([p1, p2]);

    const channel = await discordMock.channelsFetch.mock.results[0]!.value;
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(ref.messageIds).toEqual(['m-1', 'm-2']);
  });

  it('setTyping 调用 Discord sendTyping', async () => {
    const sendTyping = vi.fn(async () => undefined);
    discordMock.channelsFetch.mockResolvedValueOnce(makeTextChannel({ sendTyping }));
    const platform = makePlatform();

    await platform.setTyping({
      platform: 'discord',
      channelId: 'C1',
      initiatorUserId: OTHER_ID,
    });

    expect(sendTyping).toHaveBeenCalledTimes(1);
  });

  it('setTyping 在 fetch 或 sendTyping 失败时吞错并写 debug', async () => {
    const logger = makeLogger();
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger,
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
    });
    const fetchErr = new Error('fetch failed');
    discordMock.channelsFetch.mockRejectedValueOnce(fetchErr);

    await expect(platform.setTyping({
      platform: 'discord',
      channelId: 'C1',
      initiatorUserId: OTHER_ID,
    })).resolves.toBeUndefined();

    expect(logger.debug).toHaveBeenCalledWith(
      { err: fetchErr, channelId: 'C1' },
      'discord_typing_failed',
    );
  });

  it('setTyping 在 sendTyping 失败时也吞错并写 debug', async () => {
    const logger = makeLogger();
    const typingErr = new Error('typing failed');
    discordMock.channelsFetch.mockResolvedValueOnce(
      makeTextChannel({ sendTyping: vi.fn(async () => Promise.reject(typingErr)) }),
    );
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger,
      statePath: '/tmp/agent-nexus-discord-state-test.json',
      allowedUserIds: ALLOWED,
    });

    await expect(platform.setTyping({
      platform: 'discord',
      channelId: 'C1',
      initiatorUserId: OTHER_ID,
    })).resolves.toBeUndefined();

    expect(logger.debug).toHaveBeenCalledWith(
      { err: typingErr, channelId: 'C1' },
      'discord_typing_failed',
    );
  });

  it('clearTyping 幂等不抛', async () => {
    const platform = makePlatform();

    await expect(platform.clearTyping({
      platform: 'discord',
      channelId: 'C1',
      initiatorUserId: OTHER_ID,
    })).resolves.toBeUndefined();
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

  it('thread message carries parent channel id when Discord exposes it', () => {
    const msg = makeMsg({
      content: `<@${BOT_ID}> ping`,
      channelId: 'T42',
      channel: {
        isThread: () => true,
        parentId: 'C42',
      },
    });
    const ev = expectEvent(parseInbound(msg, BOT_ID, ALLOWED));

    expect(ev.sessionKey.channelId).toBe('T42');
    expect(ev.threadParentChannelId).toBe('C42');
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

  it('guildId 与 initiatorRoleIds 从 Discord message 上下文取', () => {
    const msg = makeMsg({
      content: `<@${BOT_ID}> hi`,
      guildId: 'G1',
      roleIds: ['R1', 'R2'],
    });
    const ev = expectEvent(parseInbound(msg, BOT_ID, ALLOWED));
    expect(ev.guildId).toBe('G1');
    expect(ev.initiatorRoleIds).toEqual(['R1', 'R2']);
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

  it('allowedUserIds=null → chat 路径跳过 adapter user guard，留给 daemon platform auth', () => {
    const msg = makeMsg({ content: `<@${BOT_ID}> hello`, authorId: 'NOT_ALLOWED' });
    expect(parseInbound(msg, BOT_ID, null).kind).toBe('event');
  });

  it('allowedUserIds=null + all 模式 → 未列入旧白名单的用户仍可进入 daemon auth', () => {
    const msg = makeMsg({ content: 'hi from role-authorized user', authorId: 'NOT_ALLOWED' });
    expect(parseInbound(msg, BOT_ID, null, 'all').kind).toBe('event');
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

describe('createDiscordPlatform: inboundAllowedUserIds 接线', () => {
  it('显式传 null 时 chat 不做 adapter guard，事件交给 daemon 判定', async () => {
    const logger = makeLogger();
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger,
      statePath: '/tmp/agent-nexus-missing-dir/inbound-null-guard.json',
      allowedUserIds: ['U-only'],
      inboundAllowedUserIds: null,
    });
    const handler = vi.fn(async () => undefined);
    await platform.start(handler);
    const messageCreate = registeredHandler('messageCreate');

    await messageCreate(
      makeMsg({ content: `<@${BOT_ID}> hi`, authorId: 'U-stranger' }),
    );
    expect(handler).toHaveBeenCalledTimes(1);

    // updateAuth 传 null 同语义：guard 保持关闭
    platform.updateAuth({ allowedUserIds: ['U-other'], inboundAllowedUserIds: null });
    await messageCreate(
      makeMsg({ content: `<@${BOT_ID}> hi again`, authorId: 'U-stranger-2', id: 'm-2' }),
    );
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('缺省（undefined）时沿用 allowedUserIds 做 chat guard', async () => {
    const logger = makeLogger();
    const platform = createDiscordPlatform({
      token: 'test-token',
      botUserId: BOT_ID,
      logger,
      statePath: '/tmp/agent-nexus-missing-dir/inbound-default-guard.json',
      allowedUserIds: ['U-only'],
    });
    const handler = vi.fn(async () => undefined);
    await platform.start(handler);
    const messageCreate = registeredHandler('messageCreate');

    await messageCreate(
      makeMsg({ content: `<@${BOT_ID}> hi`, authorId: 'U-stranger' }),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U-stranger' }),
      'discord_inbound_unauthorized',
    );
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
