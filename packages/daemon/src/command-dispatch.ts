import type {
  CommandRoute,
  NormalizedEvent,
} from '@agent-nexus/protocol';
import {
  ActiveCommandRegistry,
  CommandRegistryError,
} from './command-registry.js';
import {
  RouteError,
  selectRoute,
  type RouteDecision,
  type RoutingEntry,
} from './router.js';

export interface CommandDispatchAgentTarget {
  agentName: string;
  agentOwner: string;
}

export interface CommandDispatchLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export type CommandDispatchDecision =
  | {
      ownerType: 'agent';
      commandName: string;
      canonicalId: string;
      aliasKind: CommandRoute['aliasKind'];
      localName: string;
      handlerKey: string;
      dispatchMode: CommandRoute['dispatchMode'];
      bindingName: string;
      agentName: string;
      agentOwner: string;
    }
  | {
      ownerType: 'platform';
      commandName: string;
      canonicalId: string;
      aliasKind: CommandRoute['aliasKind'];
      localName: string;
      handlerKey: string;
      platformType: string;
    }
  | {
      ownerType: 'daemon';
      commandName: string;
      canonicalId: string;
      aliasKind: CommandRoute['aliasKind'];
      localName: string;
      handlerKey: string;
    };

export interface CommandDispatchInput {
  event: NormalizedEvent;
  registry: ActiveCommandRegistry;
  platformName: string;
  platformType: 'discord';
  routingTable: readonly RoutingEntry[];
  agentTargets: readonly CommandDispatchAgentTarget[];
  platformHandlerKeys: readonly string[];
  daemonHandlerKeys: readonly string[];
}

export interface DispatchCommandEventInput extends CommandDispatchInput {
  logger: CommandDispatchLogger;
}

function requireCommand(event: NormalizedEvent): NonNullable<NormalizedEvent['command']> {
  if (event.type !== 'command' || !event.command) {
    throw new CommandRegistryError(
      'command_handler_missing',
      'command event requires command payload',
      { eventType: event.type },
    );
  }
  return event.command;
}

function hasHandler(handlerKeys: readonly string[], handlerKey: string): boolean {
  return handlerKeys.includes(handlerKey);
}

function dispatchError(
  code:
    | 'command_agent_binding_miss'
    | 'command_agent_owner_mismatch'
    | 'command_handler_missing',
  message: string,
  route: CommandRoute,
  commandName: string,
  details: Record<string, unknown>,
): CommandRegistryError {
  return new CommandRegistryError(code, message, {
    ...details,
    commandName,
    canonicalId: route.canonicalId,
    aliasKind: route.aliasKind,
    handlerKey: route.handlerKey,
  });
}

export function resolveCommandDispatch(
  input: CommandDispatchInput,
): CommandDispatchDecision {
  const command = requireCommand(input.event);
  const route = input.registry.resolve(command.registrationScope, command.name);

  if (route.owner.type === 'agent') {
    let routed: RouteDecision;
    try {
      routed = selectRoute(input.routingTable, {
        platformName: input.platformName,
        platformType: input.platformType,
        event: input.event,
      });
    } catch (err) {
      if (err instanceof RouteError) {
        throw dispatchError(
          'command_agent_binding_miss',
          'agent command did not match exactly one binding',
          route,
          command.name,
          { routeCode: err.code, routeDetails: err.details },
        );
      }
      throw err;
    }

    const target = input.agentTargets.find(
      (candidate) => candidate.agentName === routed.agentName,
    );
    if (!target || target.agentOwner !== route.owner.agentOwner) {
      throw dispatchError(
        'command_agent_owner_mismatch',
        'routed agent owner does not match command owner',
        route,
        command.name,
        {
          bindingName: routed.bindingName,
          agentName: routed.agentName,
          expectedAgentOwner: route.owner.agentOwner,
          actualAgentOwner: target?.agentOwner ?? null,
        },
      );
    }
    return {
      ownerType: 'agent',
      commandName: command.name,
      canonicalId: route.canonicalId,
      aliasKind: route.aliasKind,
      localName: route.localName,
      handlerKey: route.handlerKey,
      dispatchMode: route.dispatchMode,
      bindingName: routed.bindingName,
      agentName: routed.agentName,
      agentOwner: target.agentOwner,
    };
  }

  if (route.owner.type === 'platform') {
    if (
      route.owner.platformType !== input.platformType ||
      !hasHandler(input.platformHandlerKeys, route.handlerKey)
    ) {
      throw dispatchError(
        'command_handler_missing',
        'platform command handler is missing',
        route,
        command.name,
        { platformType: route.owner.platformType },
      );
    }
    return {
      ownerType: 'platform',
      commandName: command.name,
      canonicalId: route.canonicalId,
      aliasKind: route.aliasKind,
      localName: route.localName,
      handlerKey: route.handlerKey,
      platformType: route.owner.platformType,
    };
  }

  if (!hasHandler(input.daemonHandlerKeys, route.handlerKey)) {
    throw dispatchError(
      'command_handler_missing',
      'daemon command handler is missing',
      route,
      command.name,
      {},
    );
  }
  return {
    ownerType: 'daemon',
    commandName: command.name,
    canonicalId: route.canonicalId,
    aliasKind: route.aliasKind,
    localName: route.localName,
    handlerKey: route.handlerKey,
  };
}

export function dispatchCommandEvent(
  input: DispatchCommandEventInput,
): CommandDispatchDecision | undefined {
  try {
    return resolveCommandDispatch(input);
  } catch (err) {
    if (err instanceof CommandRegistryError) {
      const command = input.event.command;
      input.logger.error(
        {
          traceId: input.event.traceId,
          platformName: input.platformName,
          scope: command?.registrationScope,
          commandName: command?.name,
          ...err.details,
        },
        err.code,
      );
      return undefined;
    }
    throw err;
  }
}
