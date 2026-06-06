import { describe, expect, it, vi } from 'vitest';
import type {
  CapabilitySet,
  CommandDescriptor,
  CommandRegistrationScope,
  NormalizedEvent,
} from '@agent-nexus/protocol';
import {
  ActiveCommandRegistry,
  buildCommandRegistrationPlan,
  DEFAULT_COMMAND_NAME_POLICY,
} from './command-registry.js';
import {
  dispatchCommandEvent,
  resolveCommandDispatch,
  type CommandDispatchAgentTarget,
  type CommandDispatchLogger,
} from './command-dispatch.js';
import type { RoutingEntry } from './router.js';

const scope: CommandRegistrationScope = {
  platformName: 'discord-main',
  platformType: 'discord',
  nativeScope: { kind: 'guild', guildId: 'G1' },
};

const caps: CapabilitySet = {
  maxTextLength: 2000,
  supportsEdit: false,
  supportsDelete: false,
  supportsReactions: false,
  supportsEmbeds: false,
  supportsButtons: false,
  supportsThreads: false,
  supportsEphemeral: true,
  supportsAttachments: false,
  maxAttachmentsPerMessage: 0,
  supportsTypingIndicator: false,
  supportsSlashCommands: true,
};

const routeToCodex: RoutingEntry = {
  bindingName: 'discord-main-codex',
  platformName: 'discord-main',
  platformType: 'discord',
  agentName: 'codex-dev',
  match: { discord: { channelIds: ['C1'] } },
};

const codexTarget: CommandDispatchAgentTarget = {
  agentName: 'codex-dev',
  agentOwner: 'codex',
};

function agentCommand(agentOwner: string, localName: string): CommandDescriptor {
  return {
    canonicalId: `agent:${agentOwner}:${localName}`,
    owner: { type: 'agent', agentOwner },
    localName,
    summary: `Run ${localName}`,
    options: [],
    handlerKey: localName,
    applicability: { requiredCapabilities: ['slash-command-registration'] },
    legacyNames: [],
  };
}

function platformCommand(): CommandDescriptor {
  return {
    canonicalId: 'platform:discord:reply-mode',
    owner: { type: 'platform', platformType: 'discord' },
    localName: 'reply-mode',
    summary: 'Switch reply mode',
    options: [],
    handlerKey: 'reply-mode',
    applicability: {
      platformTypes: ['discord'],
      requiredCapabilities: [
        'slash-command-registration',
        'ephemeral-response',
      ],
    },
    legacyNames: [{ name: 'reply-mode', reason: 'historical-compatibility' }],
  };
}

function daemonCommand(): CommandDescriptor {
  return {
    canonicalId: 'daemon:status',
    owner: { type: 'daemon' },
    localName: 'status',
    summary: 'Show daemon status',
    options: [],
    handlerKey: 'status',
    applicability: {
      platformTypes: ['discord'],
      requiredCapabilities: ['slash-command-registration'],
    },
    legacyNames: [],
  };
}

function makeRegistry(descriptors: CommandDescriptor[]): ActiveCommandRegistry {
  const plan = buildCommandRegistrationPlan({
    descriptors,
    scope,
    capabilities: caps,
    policy: DEFAULT_COMMAND_NAME_POLICY,
    agentOwnersInScope: ['codex'],
    generation: 'g1',
  });
  const registry = new ActiveCommandRegistry();
  registry.activate(plan, new Date(0));
  return registry;
}

function makeCommandEvent(commandName: string, channelId = 'C1'): NormalizedEvent {
  return {
    eventId: `e-${commandName}`,
    platform: 'discord',
    sessionKey: {
      platform: 'discord',
      channelId,
      initiatorUserId: 'U1',
    },
    messageId: 'm-1',
    traceId: 't-1',
    type: 'command',
    command: {
      name: commandName,
      args: {},
      registrationScope: scope,
    },
    rawPayload: {},
    rawContentType: 'application/json',
    receivedAt: new Date(0),
    initiator: { userId: 'U1', displayName: 'U1', isBot: false },
  };
}

function logger(): CommandDispatchLogger & {
  error: ReturnType<typeof vi.fn>;
} {
  return { error: vi.fn() };
}

describe('resolveCommandDispatch', () => {
  it('routes agent commands through the active reverse map and binding owner', () => {
    const decision = resolveCommandDispatch({
      event: makeCommandEvent('codex-new'),
      registry: makeRegistry([agentCommand('codex', 'new')]),
      platformName: 'discord-main',
      platformType: 'discord',
      routingTable: [routeToCodex],
      agentTargets: [codexTarget],
      platformHandlerKeys: [],
      daemonHandlerKeys: [],
    });

    expect(decision).toMatchObject({
      ownerType: 'agent',
      canonicalId: 'agent:codex:new',
      commandName: 'codex-new',
      bindingName: 'discord-main-codex',
      agentName: 'codex-dev',
      agentOwner: 'codex',
      handlerKey: 'new',
    });
  });

  it('routes platform and daemon commands to their owner handlers', () => {
    const registry = makeRegistry([platformCommand(), daemonCommand()]);

    expect(
      resolveCommandDispatch({
        event: makeCommandEvent('reply-mode'),
        registry,
        platformName: 'discord-main',
        platformType: 'discord',
        routingTable: [routeToCodex],
        agentTargets: [codexTarget],
        platformHandlerKeys: ['reply-mode'],
        daemonHandlerKeys: ['status'],
      }),
    ).toMatchObject({
      ownerType: 'platform',
      canonicalId: 'platform:discord:reply-mode',
      handlerKey: 'reply-mode',
    });

    expect(
      resolveCommandDispatch({
        event: makeCommandEvent('nexus-status'),
        registry,
        platformName: 'discord-main',
        platformType: 'discord',
        routingTable: [routeToCodex],
        agentTargets: [codexTarget],
        platformHandlerKeys: ['reply-mode'],
        daemonHandlerKeys: ['status'],
      }),
    ).toMatchObject({
      ownerType: 'daemon',
      canonicalId: 'daemon:status',
      handlerKey: 'status',
    });
  });
});

describe('dispatchCommandEvent', () => {
  it('returns the dispatch decision for a valid agent command', () => {
    const log = logger();

    const decision = dispatchCommandEvent({
      event: makeCommandEvent('codex-new'),
      registry: makeRegistry([agentCommand('codex', 'new')]),
      platformName: 'discord-main',
      platformType: 'discord',
      routingTable: [routeToCodex],
      agentTargets: [codexTarget],
      platformHandlerKeys: [],
      daemonHandlerKeys: [],
      logger: log,
    });

    expect(decision).toMatchObject({
      ownerType: 'agent',
      canonicalId: 'agent:codex:new',
      bindingName: 'discord-main-codex',
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('fails closed when an agent command does not match a binding', () => {
    const log = logger();

    const decision = dispatchCommandEvent({
      event: makeCommandEvent('codex-new', 'C2'),
      registry: makeRegistry([agentCommand('codex', 'new')]),
      platformName: 'discord-main',
      platformType: 'discord',
      routingTable: [routeToCodex],
      agentTargets: [codexTarget],
      platformHandlerKeys: [],
      daemonHandlerKeys: [],
      logger: log,
    });

    expect(decision).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: 'codex-new',
        canonicalId: 'agent:codex:new',
        routeCode: 'route_not_found',
      }),
      'command_agent_binding_miss',
    );
  });

  it('fails closed when the reverse map route agent owner differs from the channel binding owner', () => {
    const log = logger();

    const decision = dispatchCommandEvent({
      event: makeCommandEvent('codex-new'),
      registry: makeRegistry([agentCommand('codex', 'new')]),
      platformName: 'discord-main',
      platformType: 'discord',
      routingTable: [routeToCodex],
      agentTargets: [
        { agentName: 'codex-dev', agentOwner: 'claudecode' },
      ],
      platformHandlerKeys: [],
      daemonHandlerKeys: [],
      logger: log,
    });

    expect(decision).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 't-1',
        platformName: 'discord-main',
        commandName: 'codex-new',
        canonicalId: 'agent:codex:new',
      }),
      'command_agent_owner_mismatch',
    );
  });

  it('fails closed when an owner handler key is missing', () => {
    const log = logger();

    const decision = dispatchCommandEvent({
      event: makeCommandEvent('nexus-status'),
      registry: makeRegistry([daemonCommand()]),
      platformName: 'discord-main',
      platformType: 'discord',
      routingTable: [routeToCodex],
      agentTargets: [codexTarget],
      platformHandlerKeys: [],
      daemonHandlerKeys: [],
      logger: log,
    });

    expect(decision).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: 'nexus-status',
        canonicalId: 'daemon:status',
        handlerKey: 'status',
      }),
      'command_handler_missing',
    );
  });

  it('does not validate agent handler keys during dispatch', () => {
    const log = logger();

    const decision = dispatchCommandEvent({
      event: makeCommandEvent('codex-new'),
      registry: makeRegistry([agentCommand('codex', 'new')]),
      platformName: 'discord-main',
      platformType: 'discord',
      routingTable: [routeToCodex],
      agentTargets: [codexTarget],
      platformHandlerKeys: [],
      daemonHandlerKeys: [],
      logger: log,
    });

    expect(decision).toMatchObject({
      ownerType: 'agent',
      canonicalId: 'agent:codex:new',
      handlerKey: 'new',
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('fails closed when a platform handler key is missing', () => {
    const log = logger();

    const decision = dispatchCommandEvent({
      event: makeCommandEvent('reply-mode'),
      registry: makeRegistry([platformCommand()]),
      platformName: 'discord-main',
      platformType: 'discord',
      routingTable: [routeToCodex],
      agentTargets: [codexTarget],
      platformHandlerKeys: [],
      daemonHandlerKeys: [],
      logger: log,
    });

    expect(decision).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: 'reply-mode',
        canonicalId: 'platform:discord:reply-mode',
        handlerKey: 'reply-mode',
      }),
      'command_handler_missing',
    );
  });

  it('fails closed when a command name misses the active reverse map', () => {
    const log = logger();

    const decision = dispatchCommandEvent({
      event: makeCommandEvent('discord-reply-mode'),
      registry: makeRegistry([agentCommand('codex', 'new')]),
      platformName: 'discord-main',
      platformType: 'discord',
      routingTable: [routeToCodex],
      agentTargets: [codexTarget],
      platformHandlerKeys: [],
      daemonHandlerKeys: [],
      logger: log,
    });

    expect(decision).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: 'discord-reply-mode',
      }),
      'command_reverse_map_miss',
    );
  });
});
