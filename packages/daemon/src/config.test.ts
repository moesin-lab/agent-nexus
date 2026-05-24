import { describe, expect, it } from 'vitest';
import {
  DaemonConfigError,
  parseDaemonConfig,
  parsePlatformAuthConfig,
} from './config.js';

describe('daemon config', () => {
  it('缺省 toolMessages → append', () => {
    expect(parseDaemonConfig(undefined).toolMessages).toBe('append');
    expect(parseDaemonConfig({}).toolMessages).toBe('append');
  });

  it.each(['append', 'compact'] as const)('显式 toolMessages=%s → 保留', (mode) => {
    expect(parseDaemonConfig({ toolMessages: mode }).toolMessages).toBe(mode);
  });

  it('toolMessages 非允许值 → DaemonConfigError', () => {
    expect(() => parseDaemonConfig({ toolMessages: 'hidden' })).toThrow(
      DaemonConfigError,
    );
    expect(() => parseDaemonConfig({ toolMessages: 'hidden' })).toThrow(
      /ui\.toolMessages/,
    );
  });
});

describe('platform auth config', () => {
  const validAuth = {
    allowlist: {
      userIds: ['U1'],
      roleIds: [],
      allowedGuildIds: ['G1'],
      allowedChannelIds: ['C1'],
      allowDM: false,
      requireMentionOrSlash: true,
    },
  };

  it('解析 platforms[].auth.allowlist 并保留显式字段', () => {
    expect(
      parsePlatformAuthConfig(validAuth, { path: 'platforms[0].auth' }),
    ).toEqual(validAuth);
  });

  it('allowDM / requireMentionOrSlash 缺省为 true，role/channel 列表缺省为空', () => {
    expect(
      parsePlatformAuthConfig(
        {
          allowlist: {
            userIds: ['U1'],
            allowedGuildIds: ['G1'],
          },
        },
        { path: 'platforms[0].auth' },
      ),
    ).toEqual({
      allowlist: {
        userIds: ['U1'],
        roleIds: [],
        allowedGuildIds: ['G1'],
        allowedChannelIds: [],
        allowDM: true,
        requireMentionOrSlash: true,
      },
    });
  });

  it('ID 列表允许缺省或空数组，但至少一个 ID 列表要非空', () => {
    expect(
      parsePlatformAuthConfig(
        { allowlist: { userIds: [], roleIds: ['R1'], allowedGuildIds: ['G1'] } },
        { path: 'platforms[0].auth' },
      ).allowlist,
    ).toMatchObject({
      userIds: [],
      roleIds: ['R1'],
      allowedGuildIds: ['G1'],
    });

    expect(() =>
      parsePlatformAuthConfig(
        {
          allowlist: {
            userIds: [],
            roleIds: [],
            allowedGuildIds: [],
            allowedChannelIds: [],
          },
        },
        { path: 'platforms[0].auth' },
      ),
    ).toThrow(/platforms\[0\]\.auth\.allowlist.*至少/);
  });

  it('未知 allowlist 字段 fail-closed', () => {
    expect(() =>
      parsePlatformAuthConfig(
        {
          allowlist: {
            userIds: ['U1'],
            allowedGuildIds: ['G1'],
            shared_channel_mode: true,
          },
        },
        { path: 'platforms[0].auth' },
      ),
    ).toThrow(/shared_channel_mode/);
  });
});
