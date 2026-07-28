import { describe, expect, it } from 'vitest';
import { RouteError, selectRoute, type RoutingEntry } from './router.js';
import type { NormalizedEvent } from '@agent-nexus/protocol';

const entries: RoutingEntry[] = [
  {
    bindingName: 'discord-main-codex',
    platformName: 'discord-main',
    platformType: 'discord',
    agentName: 'codex-dev',
    channelIds: ['C1'],
  },
  {
    bindingName: 'discord-main-claude',
    platformName: 'discord-main',
    platformType: 'discord',
    agentName: 'claude-prod',
    channelIds: ['C2'],
  },
  {
    bindingName: 'discord-side-codex',
    platformName: 'discord-side',
    platformType: 'discord',
    agentName: 'codex-dev',
    channelIds: ['C1'],
  },
];

function makeEvent(
  channelId: string,
  platform: string = 'discord',
): NormalizedEvent {
  return {
    eventId: 'e-1',
    platform,
    sessionKey: {
      platform,
      channelId,
      initiatorUserId: 'U1',
    },
    messageId: 'm-1',
    traceId: 't-1',
    type: 'message',
    text: 'hello',
    rawPayload: {},
    rawContentType: 'application/json',
    receivedAt: new Date(0),
    initiator: { userId: 'U1', displayName: 'U1', isBot: false },
  };
}

describe('selectRoute', () => {
  it('selects the unique agent by platform instance and Discord channel', () => {
    expect(
      selectRoute(entries, {
        platformName: 'discord-main',
        platformType: 'discord',
        event: makeEvent('C2'),
      }),
    ).toEqual({
      bindingName: 'discord-main-claude',
      platformName: 'discord-main',
      agentName: 'claude-prod',
    });
  });

  it('does not let another platform instance match the same channel/user', () => {
    expect(
      selectRoute(entries, {
        platformName: 'discord-side',
        platformType: 'discord',
        event: makeEvent('C1'),
      }),
    ).toEqual({
      bindingName: 'discord-side-codex',
      platformName: 'discord-side',
      agentName: 'codex-dev',
    });
  });

  it('selects the unique agent by Lark platform instance and chat', () => {
    const larkEntries: RoutingEntry[] = [
      {
        bindingName: 'lark-main-codex',
        platformName: 'lark-main',
        platformType: 'lark',
        agentName: 'codex-dev',
        channelIds: ['oc_chat_1'],
      },
      {
        bindingName: 'lark-main-claude',
        platformName: 'lark-main',
        platformType: 'lark',
        agentName: 'claude-prod',
        channelIds: ['oc_chat_2'],
      },
    ];

    expect(
      selectRoute(larkEntries, {
        platformName: 'lark-main',
        platformType: 'lark',
        event: makeEvent('oc_chat_2', 'lark'),
      }),
    ).toEqual({
      bindingName: 'lark-main-claude',
      platformName: 'lark-main',
      agentName: 'claude-prod',
    });
  });

  it('routes an arbitrary platform without daemon-side platform schema changes', () => {
    const matrixEntries: RoutingEntry[] = [
      {
        bindingName: 'matrix-main-codex',
        platformName: 'matrix-main',
        platformType: 'matrix',
        agentName: 'codex-dev',
        channelIds: ['room-1'],
      },
    ];

    expect(
      selectRoute(matrixEntries, {
        platformName: 'matrix-main',
        platformType: 'matrix',
        event: makeEvent('room-1', 'matrix'),
      }),
    ).toEqual({
      bindingName: 'matrix-main-codex',
      platformName: 'matrix-main',
      agentName: 'codex-dev',
    });
  });

  it('fails closed when no binding matches', () => {
    expect(() =>
      selectRoute(entries, {
        platformName: 'discord-main',
        platformType: 'discord',
        event: makeEvent('C3'),
      }),
    ).toThrow(RouteError);
  });

  it('fails closed when multiple bindings match', () => {
    expect(() =>
      selectRoute(
        [
          entries[0]!,
          {
            bindingName: 'discord-main-codex-duplicate',
            platformName: 'discord-main',
            platformType: 'discord',
            agentName: 'codex-dev',
            channelIds: ['C1'],
          },
        ],
        {
          platformName: 'discord-main',
          platformType: 'discord',
          event: makeEvent('C1'),
        },
      ),
    ).toThrow(RouteError);
  });
});
