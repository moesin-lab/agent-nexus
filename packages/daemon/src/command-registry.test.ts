import { describe, expect, it } from 'vitest';
import type {
  CapabilitySet,
  CommandDescriptor,
  CommandRegistrationScope,
} from '@agent-nexus/protocol';
import {
  ActiveCommandRegistry,
  buildCommandRegistrationPlan,
  CommandRegistryError,
  DEFAULT_COMMAND_NAME_POLICY,
} from './command-registry.js';

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

function agentCommand(agentOwner: string, localName: string): CommandDescriptor {
  return {
    canonicalId: `agent:${agentOwner}:${localName}`,
    owner: { type: 'agent', agentOwner },
    localName,
    summary: `Start a new ${agentOwner} conversation`,
    options: [],
    handlerKey: localName,
    applicability: { requiredCapabilities: ['slash-command-registration'] },
    legacyNames: [],
  };
}

describe('buildCommandRegistrationPlan', () => {
  it('fails closed when canonical ids are duplicated', () => {
    const descriptor = agentCommand('codex', 'new');

    expect(() =>
      buildCommandRegistrationPlan({
        descriptors: [descriptor, descriptor],
        scope,
        capabilities: caps,
        policy: DEFAULT_COMMAND_NAME_POLICY,
        agentOwnersInScope: ['codex'],
        generation: 'g1',
      }),
    ).toThrow(CommandRegistryError);
  });

  it('fails closed when canonical id disagrees with owner or local name', () => {
    expect(() =>
      buildCommandRegistrationPlan({
        descriptors: [
          {
            ...agentCommand('codex', 'new'),
            canonicalId: 'agent:claudecode:new',
          },
        ],
        scope,
        capabilities: caps,
        policy: DEFAULT_COMMAND_NAME_POLICY,
        agentOwnersInScope: ['codex'],
        generation: 'g1',
      }),
    ).toThrow(CommandRegistryError);
  });

  it('fails closed when handler keys repeat within one owner', () => {
    expect(() =>
      buildCommandRegistrationPlan({
        descriptors: [
          agentCommand('codex', 'new'),
          { ...agentCommand('codex', 'reset'), handlerKey: 'new' },
        ],
        scope,
        capabilities: caps,
        policy: DEFAULT_COMMAND_NAME_POLICY,
        agentOwnersInScope: ['codex'],
        generation: 'g1',
      }),
    ).toThrow(CommandRegistryError);
  });

  it('rejects active agent prefixes that collide with product reserved prefixes', () => {
    expect(() =>
      buildCommandRegistrationPlan({
        descriptors: [agentCommand('nexus', 'new')],
        scope,
        capabilities: caps,
        policy: DEFAULT_COMMAND_NAME_POLICY,
        agentOwnersInScope: ['nexus'],
        generation: 'g1',
      }),
    ).toThrow(CommandRegistryError);
  });

  it('does not generate a bare alias for a historical reserved name', () => {
    expect(() =>
      buildCommandRegistrationPlan({
        descriptors: [agentCommand('codex', 'reply-mode')],
        scope,
        capabilities: caps,
        policy: DEFAULT_COMMAND_NAME_POLICY,
        agentOwnersInScope: ['codex'],
        generation: 'g1',
      }),
    ).toThrow(CommandRegistryError);
  });

  it('does not generate a bare alias that looks like an active agent stable name', () => {
    expect(() =>
      buildCommandRegistrationPlan({
        descriptors: [agentCommand('codex', 'codex-new')],
        scope,
        capabilities: caps,
        policy: DEFAULT_COMMAND_NAME_POLICY,
        agentOwnersInScope: ['codex'],
        generation: 'g1',
      }),
    ).toThrow(CommandRegistryError);
  });

  it('generates a single-agent alias and removes it in multi-agent scope', () => {
    const single = buildCommandRegistrationPlan({
      descriptors: [agentCommand('codex', 'new')],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['codex'],
      generation: 'g1',
    });

    expect(single.commands.map((command) => command.commandName).sort()).toEqual([
      'codex-new',
      'new',
    ]);
    expect(single.reverseMap.entries['new']).toMatchObject({
      canonicalId: 'agent:codex:new',
      aliasKind: 'single-agent-alias',
    });

    const multi = buildCommandRegistrationPlan({
      descriptors: [
        agentCommand('codex', 'new'),
        agentCommand('claudecode', 'new'),
      ],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['codex', 'claudecode'],
      generation: 'g2',
    });

    expect(multi.commands.map((command) => command.commandName).sort()).toEqual([
      'claudecode-new',
      'codex-new',
    ]);
    expect(multi.reverseMap.entries['new']).toBeUndefined();
  });
});

describe('ActiveCommandRegistry', () => {
  it('fails closed when a command name misses the active reverse map', () => {
    const plan = buildCommandRegistrationPlan({
      descriptors: [agentCommand('codex', 'new')],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['codex'],
      generation: 'g1',
    });
    const registry = new ActiveCommandRegistry();
    registry.activate(plan, new Date(0));

    expect(() => registry.resolve(scope, 'discord-reply-mode')).toThrow(
      CommandRegistryError,
    );
  });
});
