import { describe, expect, it } from 'vitest';
import {
  LarkConfigError,
  parseLarkBindingMatchConfig,
  parseLarkPlatformConfig,
} from './config.js';

const VALID_PLATFORM = {
  name: 'lark-main',
  type: 'lark',
  appId: 'cli_0123456789abcdef',
  appSecretRef: 'LARK_APP_SECRET',
  botOpenId: 'ou_bot_open_id',
  auth: { allowlist: { userIds: ['ou_user_open_id'] } },
};

describe('parseLarkPlatformConfig', () => {
  it('解析中国版飞书 platform owner 字段', () => {
    expect(
      parseLarkPlatformConfig(VALID_PLATFORM, { path: 'platforms[0]' }),
    ).toEqual({
      name: 'lark-main',
      type: 'lark',
      appId: 'cli_0123456789abcdef',
      appSecretRef: 'LARK_APP_SECRET',
      botOpenId: 'ou_bot_open_id',
    });
  });

  it('拒绝非法 appId、appSecretRef 与 botOpenId 并保留字段路径', () => {
    expect(() =>
      parseLarkPlatformConfig(
        { ...VALID_PLATFORM, appId: 'app-invalid' },
        { path: 'platforms[0]' },
      ),
    ).toThrow(/platforms\[0\]\.appId/);

    expect(() =>
      parseLarkPlatformConfig(
        { ...VALID_PLATFORM, appSecretRef: '../LARK_APP_SECRET' },
        { path: 'platforms[0]' },
      ),
    ).toThrow(/platforms\[0\]\.appSecretRef/);

    expect(() =>
      parseLarkPlatformConfig(
        { ...VALID_PLATFORM, botOpenId: 'u_bot' },
        { path: 'platforms[0]' },
      ),
    ).toThrow(/platforms\[0\]\.botOpenId/);
  });

  it('未知字段 fail-closed', () => {
    expect(() =>
      parseLarkPlatformConfig(
        { ...VALID_PLATFORM, domain: 'larksuite' },
        { path: 'platforms[0]' },
      ),
    ).toThrow(LarkConfigError);
    expect(() =>
      parseLarkPlatformConfig(
        { ...VALID_PLATFORM, domain: 'larksuite' },
        { path: 'platforms[0]' },
      ),
    ).toThrow(/platforms\[0\]\.domain/);
  });
});

describe('parseLarkBindingMatchConfig', () => {
  it('解析飞书 binding match chatIds', () => {
    expect(
      parseLarkBindingMatchConfig(
        { chatIds: ['oc_chat_1'] },
        { path: 'bindings[0].match.lark' },
      ),
    ).toEqual({ chatIds: ['oc_chat_1'] });
  });

  it('chatIds 缺失、空数组、非字符串元素都拒绝并带字段路径', () => {
    for (const raw of [{}, { chatIds: [] }, { chatIds: ['oc_chat_1', 42] }]) {
      expect(() =>
        parseLarkBindingMatchConfig(raw, {
          path: 'bindings[0].match.lark',
        }),
      ).toThrow(/bindings\[0\]\.match\.lark\.chatIds/);
    }
  });

  it('未知 match 条件字段 fail-closed', () => {
    expect(() =>
      parseLarkBindingMatchConfig(
        { chatIds: ['oc_chat_1'], tenantKeys: ['tenant'] },
        { path: 'bindings[0].match.lark' },
      ),
    ).toThrow(/bindings\[0\]\.match\.lark\.tenantKeys/);
  });
});
