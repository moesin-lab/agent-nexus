import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@agent-nexus/protocol';
import { checkPlatformAuth, type AuthDecision } from './auth.js';
import type { PlatformAuthConfig } from './config.js';

const auth: PlatformAuthConfig = {
  allowlist: {
    userIds: ['U1'],
    roleIds: [],
    allowedGuildIds: ['G1'],
    allowedChannelIds: ['C1'],
    allowDM: true,
    requireMentionOrSlash: true,
  },
};

function makeEvent(
  overrides: {
    channelId?: string;
    userId?: string;
  } = {},
): NormalizedEvent {
  return {
    eventId: 'e-1',
    platform: 'discord',
    sessionKey: {
      platform: 'discord',
      channelId: overrides.channelId ?? 'C1',
      initiatorUserId: overrides.userId ?? 'U1',
    },
    messageId: 'm-1',
    traceId: 't-1',
    type: 'message',
    text: 'hello',
    rawPayload: {},
    rawContentType: 'application/json',
    receivedAt: new Date(0),
    guildId: 'G1',
    initiator: {
      userId: overrides.userId ?? 'U1',
      displayName: 'user',
      isBot: false,
    },
  };
}

describe('checkPlatformAuth', () => {
  it('allows events whose user and channel are explicitly allowed', () => {
    expect(checkPlatformAuth(auth, makeEvent())).toEqual({
      allowed: true,
    } satisfies AuthDecision);
  });

  it('denies users outside allowlist userIds', () => {
    expect(checkPlatformAuth(auth, makeEvent({ userId: 'U2' }))).toEqual({
      allowed: false,
      reason: 'user_not_allowed',
    } satisfies AuthDecision);
  });

  it('allows identity by matching roleIds when userIds does not match', () => {
    expect(
      checkPlatformAuth(
        {
          allowlist: {
            ...auth.allowlist,
            userIds: ['U-other'],
            roleIds: ['R1'],
          },
        },
        {
          ...makeEvent({ userId: 'U2' }),
          initiatorRoleIds: ['R1'],
        },
      ),
    ).toEqual({ allowed: true } satisfies AuthDecision);
  });

  it('denies channels outside allowlist allowedChannelIds', () => {
    expect(checkPlatformAuth(auth, makeEvent({ channelId: 'C2' }))).toEqual({
      allowed: false,
      reason: 'channel_not_allowed',
    } satisfies AuthDecision);
  });

  it('treats empty identity/channel lists as unconstrained for guild events after parser validation', () => {
    expect(
      checkPlatformAuth(
        {
          allowlist: {
            ...auth.allowlist,
            userIds: [],
            roleIds: [],
            allowedGuildIds: ['G1'],
            allowedChannelIds: [],
          },
        },
        makeEvent({ channelId: 'C2', userId: 'U2' }),
      ),
    ).toEqual({ allowed: true } satisfies AuthDecision);
  });

  it('denies DM events when no userIds can constrain the DM identity', () => {
    const event = makeEvent({ userId: 'U2' });
    delete event.guildId;

    expect(
      checkPlatformAuth(
        {
          allowlist: {
            ...auth.allowlist,
            userIds: [],
            roleIds: [],
            allowedGuildIds: ['G1'],
            allowedChannelIds: [],
            allowDM: true,
          },
        },
        event,
      ),
    ).toEqual({
      allowed: false,
      reason: 'user_not_allowed',
    } satisfies AuthDecision);
  });

  it('allows DM events only when the initiator is explicitly in userIds', () => {
    const event = makeEvent({ userId: 'U2' });
    delete event.guildId;

    expect(
      checkPlatformAuth(
        {
          allowlist: {
            ...auth.allowlist,
            userIds: ['U2'],
            allowedGuildIds: [],
            allowedChannelIds: [],
          },
        },
        event,
      ),
    ).toEqual({ allowed: true } satisfies AuthDecision);
  });

  it('denies role-only DM because Discord DM events do not carry guild role context', () => {
    const event = makeEvent({ userId: 'U2' });
    delete event.guildId;

    expect(
      checkPlatformAuth(
        {
          allowlist: {
            ...auth.allowlist,
            userIds: [],
            roleIds: ['R1'],
            allowedGuildIds: [],
            allowedChannelIds: [],
            allowDM: true,
          },
        },
        event,
      ),
    ).toEqual({
      allowed: false,
      reason: 'user_not_allowed',
    } satisfies AuthDecision);
  });

  it('denies guilds outside allowlist allowedGuildIds', () => {
    expect(
      checkPlatformAuth(auth, {
        ...makeEvent(),
        guildId: 'G2',
      }),
    ).toEqual({
      allowed: false,
      reason: 'guild_not_allowed',
    } satisfies AuthDecision);
  });

  it('denies DM events when allowDM=false', () => {
    const event = makeEvent();
    delete event.guildId;

    expect(
      checkPlatformAuth(
        {
          allowlist: {
            ...auth.allowlist,
            allowDM: false,
          },
        },
        event,
      ),
    ).toEqual({
      allowed: false,
      reason: 'dm_not_allowed',
    } satisfies AuthDecision);
  });
});
