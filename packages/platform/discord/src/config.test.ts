import { describe, expect, it } from 'vitest';
import { parseDiscordConfig, DiscordConfigError } from './config.js';

const DEFAULT_STATE_PATH = '/default/state/discord.json';
const ctx = { defaultStatePath: DEFAULT_STATE_PATH };

describe('parseDiscordConfig', () => {
  it('缺 botUserId → DiscordConfigError', () => {
    expect(() => parseDiscordConfig({}, ctx)).toThrow(DiscordConfigError);
    expect(() => parseDiscordConfig({}, ctx)).toThrow(/botUserId/);
  });

  it('botUserId 空字符串 → DiscordConfigError', () => {
    expect(() => parseDiscordConfig({ botUserId: '' }, ctx)).toThrow(DiscordConfigError);
  });

  it('botUserId 非字符串 → DiscordConfigError', () => {
    expect(() => parseDiscordConfig({ botUserId: 42 }, ctx)).toThrow(DiscordConfigError);
  });

  it('最小合法配置 → 返回默认值', () => {
    const result = parseDiscordConfig({ botUserId: '12345' }, ctx);
    expect(result.botUserId).toBe('12345');
    expect(result.ownerUserIds).toEqual([]);
    expect(result.statePath).toBe(DEFAULT_STATE_PATH);
  });

  it('ownerUserIds 缺省 → 默认空数组', () => {
    const result = parseDiscordConfig({ botUserId: '12345' }, ctx);
    expect(result.ownerUserIds).toEqual([]);
  });

  it('ownerUserIds 显式提供 → 原样保留', () => {
    const result = parseDiscordConfig({ botUserId: '12345', ownerUserIds: ['U1', 'U2'] }, ctx);
    expect(result.ownerUserIds).toEqual(['U1', 'U2']);
  });

  it('ownerUserIds 非数组 → DiscordConfigError', () => {
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', ownerUserIds: 'not-array' }, ctx),
    ).toThrow(/ownerUserIds/);
  });

  it('ownerUserIds 含非字符串元素 → DiscordConfigError', () => {
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', ownerUserIds: ['U1', 42] }, ctx),
    ).toThrow(/ownerUserIds/);
  });

  it('statePath 缺省 → 使用 ctx.defaultStatePath', () => {
    const result = parseDiscordConfig({ botUserId: '12345' }, ctx);
    expect(result.statePath).toBe(DEFAULT_STATE_PATH);
  });

  it('statePath 显式提供 → 原样保留', () => {
    const result = parseDiscordConfig(
      { botUserId: '12345', statePath: '/var/lib/foo.json' },
      ctx,
    );
    expect(result.statePath).toBe('/var/lib/foo.json');
  });

  it('statePath 非字符串 → DiscordConfigError', () => {
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', statePath: 123 }, ctx),
    ).toThrow(/statePath/);
  });

  it('statePath 空字符串 → DiscordConfigError', () => {
    expect(() =>
      parseDiscordConfig({ botUserId: '12345', statePath: '' }, ctx),
    ).toThrow(/statePath/);
  });

  it('raw 为 undefined → DiscordConfigError（缺 botUserId）', () => {
    expect(() => parseDiscordConfig(undefined, ctx)).toThrow(DiscordConfigError);
  });
});
