import { describe, expect, it } from 'vitest';
import { serializeSessionKey, withPlatformName } from './session-key.js';
import type { PlatformSessionKey, SessionKey } from './session-key.js';

describe('SessionKey', () => {
  it('serializes platform instance name before platform type/channel/user', () => {
    const key: SessionKey = {
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'C1',
      initiatorUserId: 'U1',
    };

    expect(serializeSessionKey(key)).toBe('discord-main:discord:C1:U1');
  });

  it('withPlatformName upgrades adapter key into routed session key without mutating input', () => {
    const adapterKey: PlatformSessionKey = {
      platform: 'discord',
      channelId: 'C1',
      initiatorUserId: 'U1',
    };

    expect(withPlatformName(adapterKey, 'discord-main')).toEqual({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'C1',
      initiatorUserId: 'U1',
    });
    expect(adapterKey).not.toHaveProperty('platformName');
  });
});
