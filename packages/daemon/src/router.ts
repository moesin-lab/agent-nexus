import type { NormalizedEvent } from '@agent-nexus/protocol';

export interface DiscordRouteMatch {
  channelIds: string[];
}

export interface RoutingEntry {
  bindingName: string;
  platformName: string;
  platformType: 'discord';
  agentName: string;
  match: {
    discord: DiscordRouteMatch;
  };
}

export interface RouteContext {
  platformName: string;
  platformType: 'discord';
  event: NormalizedEvent;
}

export interface RouteDecision {
  bindingName: string;
  platformName: string;
  agentName: string;
}

export class RouteError extends Error {
  constructor(
    public readonly code: 'route_not_found' | 'route_ambiguous',
    message: string,
    public readonly details: {
      platformName: string;
      platformType: string;
      channelId: string;
      bindingNames?: string[];
    },
  ) {
    super(message);
    this.name = 'RouteError';
  }
}

function matches(entry: RoutingEntry, context: RouteContext): boolean {
  if (entry.platformName !== context.platformName) return false;
  if (entry.platformType !== context.platformType) return false;
  if (context.platformType === 'discord') {
    return entry.match.discord.channelIds.includes(
      context.event.sessionKey.channelId,
    );
  }
  return false;
}

export function selectRoute(
  entries: readonly RoutingEntry[],
  context: RouteContext,
): RouteDecision {
  const matched = entries.filter((entry) => matches(entry, context));
  if (matched.length === 0) {
    throw new RouteError(
      'route_not_found',
      `no binding matched platform ${context.platformName}`,
      {
        platformName: context.platformName,
        platformType: context.platformType,
        channelId: context.event.sessionKey.channelId,
      },
    );
  }
  if (matched.length > 1) {
    throw new RouteError(
      'route_ambiguous',
      `multiple bindings matched platform ${context.platformName}`,
      {
        platformName: context.platformName,
        platformType: context.platformType,
        channelId: context.event.sessionKey.channelId,
        bindingNames: matched.map((entry) => entry.bindingName),
      },
    );
  }
  const [entry] = matched;
  return {
    bindingName: entry!.bindingName,
    platformName: entry!.platformName,
    agentName: entry!.agentName,
  };
}
