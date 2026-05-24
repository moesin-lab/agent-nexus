import { describe, expect, it } from 'vitest';
import {
  parseDiscordConfig,
  parseDiscordBindingMatchConfig,
  parseDiscordPlatformConfig,
  DiscordConfigError,
} from './config.js';

const DEFAULT_STATE_PATH = '/default/state/discord.json';
const ctx = { defaultStatePath: DEFAULT_STATE_PATH };

// allowedUserIds 必填——下面测试除了校验它本身的，统一带上一个最小合法 fixture。
const MIN_ALLOW = ['U1'];

describe('parseDiscordConfig', () => {
  it('缺 botUserId → DiscordConfigError', () => {
    expect(() => parseDiscordConfig({ allowedUserIds: MIN_ALLOW }, ctx)).toThrow(DiscordConfigError);
    expect(() => parseDiscordConfig({ allowedUserIds: MIN_ALLOW }, ctx)).toThrow(/botUserId/);
  });

  it('botUserId 空字符串 → DiscordConfigError', () => {
    expect(() => parseDiscordConfig({ botUserId: '', allowedUserIds: MIN_ALLOW }, ctx)).toThrow(DiscordConfigError);
  });

  it('botUserId 非字符串 → DiscordConfigError', () => {
    expect(() => parseDiscordConfig({ botUserId: 42, allowedUserIds: MIN_ALLOW }, ctx)).toThrow(DiscordConfigError);
  });

  it('raw 为 undefined → DiscordConfigError（缺 botUserId）', () => {
    expect(() => parseDiscordConfig(undefined, ctx)).toThrow(DiscordConfigError);
  });

  // ---- allowedUserIds（必填，fail-closed）----

  it('缺 allowedUserIds → DiscordConfigError，hint 提示字段名 + 修复样例', () => {
    // 第一条断言：错误消息明确说出缺哪个字段
    expect(() => parseDiscordConfig({ botUserId: '12345' }, ctx)).toThrow(
      /缺字段 discord\.allowedUserIds/,
    );
    // 第二条断言：错误消息含 fix hint（json 片段示例），让用户能直接照着改
    expect(() => parseDiscordConfig({ botUserId: '12345' }, ctx)).toThrow(/"allowedUserIds":/);
  });

  it('allowedUserIds = [] → DiscordConfigError（空数组拒绝所有，等价于 bot 永远不响应）', () => {
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', allowedUserIds: [] }, ctx),
    ).toThrow(/allowedUserIds/);
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', allowedUserIds: [] }, ctx),
    ).toThrow(/不能是空数组|没人|至少加一个/);
  });

  it('allowedUserIds 非数组 → DiscordConfigError', () => {
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', allowedUserIds: 'not-array' }, ctx),
    ).toThrow(/allowedUserIds/);
  });

  it('allowedUserIds 含非字符串元素 → DiscordConfigError', () => {
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', allowedUserIds: ['U1', 42] }, ctx),
    ).toThrow(/allowedUserIds/);
  });

  it('allowedUserIds 含空字符串元素 → DiscordConfigError', () => {
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', allowedUserIds: ['U1', ''] }, ctx),
    ).toThrow(/allowedUserIds/);
  });

  it('allowedUserIds 显式合法 → 原样保留', () => {
    const result = parseDiscordConfig({ botUserId: '12345', allowedUserIds: ['U1', 'U2'] }, ctx);
    expect(result.allowedUserIds).toEqual(['U1', 'U2']);
  });

  // ---- statePath ----

  it('statePath 缺省 → 使用 ctx.defaultStatePath', () => {
    const result = parseDiscordConfig({ botUserId: '12345', allowedUserIds: MIN_ALLOW }, ctx);
    expect(result.statePath).toBe(DEFAULT_STATE_PATH);
  });

  it('statePath 显式提供 → 原样保留', () => {
    const result = parseDiscordConfig(
      { botUserId: '12345', allowedUserIds: MIN_ALLOW, statePath: '/var/lib/foo.json' },
      ctx,
    );
    expect(result.statePath).toBe('/var/lib/foo.json');
  });

  it('statePath 非字符串 → DiscordConfigError', () => {
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', allowedUserIds: MIN_ALLOW, statePath: 123 }, ctx),
    ).toThrow(/statePath/);
  });

  it('statePath 空字符串 → DiscordConfigError', () => {
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', allowedUserIds: MIN_ALLOW, statePath: '' }, ctx),
    ).toThrow(/statePath/);
  });

  // ---- testGuildId（可选） ----

  it('testGuildId 缺省 → undefined（生产形态走全局注册）', () => {
    const result = parseDiscordConfig({ botUserId: '12345', allowedUserIds: MIN_ALLOW }, ctx);
    expect(result.testGuildId).toBeUndefined();
  });

  it('testGuildId 显式提供非空字符串 → 原样保留', () => {
    const result = parseDiscordConfig(
      { botUserId: '12345', allowedUserIds: MIN_ALLOW, testGuildId: '1234567890' },
      ctx,
    );
    expect(result.testGuildId).toBe('1234567890');
  });

  it('testGuildId 空字符串 → DiscordConfigError', () => {
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', allowedUserIds: MIN_ALLOW, testGuildId: '' }, ctx),
    ).toThrow(/testGuildId/);
  });

  it('testGuildId 非字符串 → DiscordConfigError', () => {
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', allowedUserIds: MIN_ALLOW, testGuildId: 12345 }, ctx),
    ).toThrow(/testGuildId/);
  });

  // ---- 最小合法配置 ----

  it('最小合法配置（含 allowedUserIds）→ 返回默认值', () => {
    const result = parseDiscordConfig({ botUserId: '12345', allowedUserIds: MIN_ALLOW }, ctx);
    expect(result.botUserId).toBe('12345');
    expect(result.allowedUserIds).toEqual(['U1']);
    expect(result.statePath).toBe(DEFAULT_STATE_PATH);
    expect(result.testGuildId).toBeUndefined();
  });
});

describe('parseDiscordPlatformConfig', () => {
  const validPlatform = {
    name: 'discord-main',
    type: 'discord',
    botUserId: '12345',
    tokenRef: 'DISCORD_BOT_TOKEN',
    auth: { allowlist: { userIds: ['U1'], allowedGuildIds: ['G1'] } },
  };

  it('解析 Discord platform owner 字段', () => {
    const result = parseDiscordPlatformConfig(validPlatform, {
      path: 'platforms[0]',
      defaultStatePath: DEFAULT_STATE_PATH,
    });

    expect(result).toEqual({
      name: 'discord-main',
      type: 'discord',
      botUserId: '12345',
      tokenRef: 'DISCORD_BOT_TOKEN',
      statePath: DEFAULT_STATE_PATH,
      publicChannelMode: 'thread',
    });
  });

  it('未知 platform 字段 fail-closed，避免把 token 明文混进配置', () => {
    expect(() =>
      parseDiscordPlatformConfig(
        { ...validPlatform, token: 'secret-value' },
        { path: 'platforms[0]', defaultStatePath: DEFAULT_STATE_PATH },
      ),
    ).toThrow(/platforms\[0\]\.token/);
  });

  it('platform 内 bindings 字段 fail-closed，binding 必须住在顶层 bindings[]', () => {
    expect(() =>
      parseDiscordPlatformConfig(
        { ...validPlatform, bindings: [{ agentName: 'codex-dev', channelIds: ['C1'] }] },
        { path: 'platforms[0]', defaultStatePath: DEFAULT_STATE_PATH },
      ),
    ).toThrow(/platforms\[0\]\.bindings/);
  });

  it('tokenRef 必须是 secret ref 名称，不能包含路径分隔符', () => {
    expect(() =>
      parseDiscordPlatformConfig(
        { ...validPlatform, tokenRef: '../DISCORD_BOT_TOKEN' },
        { path: 'platforms[0]', defaultStatePath: DEFAULT_STATE_PATH },
      ),
    ).toThrow(/platforms\[0\]\.tokenRef/);
  });
});

describe('parseDiscordBindingMatchConfig', () => {
  it('解析 Discord binding match channelIds', () => {
    expect(
      parseDiscordBindingMatchConfig(
        { channelIds: ['C1'] },
        { path: 'bindings[0].match.discord' },
      ),
    ).toEqual({ channelIds: ['C1'] });
  });

  it('channelIds 缺失、空数组、非字符串元素都拒绝并带字段路径', () => {
    expect(() =>
      parseDiscordBindingMatchConfig({}, { path: 'bindings[0].match.discord' }),
    ).toThrow(/bindings\[0\]\.match\.discord\.channelIds/);

    expect(() =>
      parseDiscordBindingMatchConfig(
        { channelIds: [] },
        { path: 'bindings[0].match.discord' },
      ),
    ).toThrow(/bindings\[0\]\.match\.discord\.channelIds/);

    expect(() =>
      parseDiscordBindingMatchConfig(
        { channelIds: ['C1', 42] },
        { path: 'bindings[0].match.discord' },
      ),
    ).toThrow(/bindings\[0\]\.match\.discord\.channelIds/);
  });

  it('未知 match 条件字段 fail-closed', () => {
    expect(() =>
      parseDiscordBindingMatchConfig(
        { channelIds: ['C1'], guildIds: ['G1'] },
        { path: 'bindings[0].match.discord' },
      ),
    ).toThrow(/bindings\[0\]\.match\.discord\.guildIds/);
  });
});
