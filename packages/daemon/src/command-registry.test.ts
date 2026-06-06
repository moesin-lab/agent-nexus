import { describe, expect, it, vi } from 'vitest';
import type {
  CapabilitySet,
  CommandDescriptor,
  CommandRegistrationPort,
  CommandRegistrationResult,
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

  it('can disable single-agent alias generation while keeping stable names', () => {
    const plan = buildCommandRegistrationPlan({
      descriptors: [agentCommand('codex', 'new')],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['codex'],
      generation: 'g1',
      singleAgentAliasesEnabled: false,
    });

    expect(plan.commands.map((command) => command.commandName)).toEqual([
      'codex-new',
    ]);
    expect(plan.reverseMap.entries).not.toHaveProperty('new');
  });
});

describe('ActiveCommandRegistry', () => {
  it('does not call the registration port or activate a map when registration is disabled', async () => {
    const plan = buildCommandRegistrationPlan({
      descriptors: [agentCommand('codex', 'new')],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['codex'],
      generation: 'g-disabled',
    });
    const registry = new ActiveCommandRegistry();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const port = { applyCommandPlan: vi.fn(async () => ({ status: 'applied' as const, generation: 'g-disabled' })) };

    const result = await registry.applyRegistrationPlan(plan, {
      enabled: false,
      logger,
      port,
      activatedAt: new Date(0),
    });

    expect(result).toEqual({
      status: 'failed',
      error: {
        code: 'command_registration_disabled',
        message: 'command registration disabled by config',
      },
    });
    expect(port.applyCommandPlan).not.toHaveBeenCalled();
    expect(() => registry.resolve(scope, 'codex-new')).toThrow(
      CommandRegistryError,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 'g-disabled' }),
      'command_registration_disabled',
    );
  });

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

  it('preserves the previous active map when remote registration fails', async () => {
    const initial = buildCommandRegistrationPlan({
      descriptors: [agentCommand('codex', 'new')],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['codex'],
      generation: 'g1',
    });
    const next = buildCommandRegistrationPlan({
      descriptors: [agentCommand('claudecode', 'new')],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['claudecode'],
      generation: 'g2',
    });
    const registry = new ActiveCommandRegistry();
    registry.activate(initial, new Date(0));
    const logger = { error: vi.fn() };

    const result = await registry.applyRegistrationPlan(next, {
      logger,
      port: portReturning({
        status: 'failed',
        error: { code: 'command_registration_failed', message: 'remote failed' },
      }),
      activatedAt: new Date(1),
      retry: { maxAttempts: 1, backoffMs: 0 },
    });

    expect(result).toMatchObject({ status: 'failed' });
    expect(registry.resolve(scope, 'codex-new')).toMatchObject({
      canonicalId: 'agent:codex:new',
    });
    expect(() => registry.resolve(scope, 'claudecode-new')).toThrow(
      CommandRegistryError,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 'g2',
        error: { code: 'command_registration_failed', message: 'remote failed' },
      }),
      'command_registration_failed',
    );
  });

  it('does not log registration error causes', async () => {
    const plan = buildCommandRegistrationPlan({
      descriptors: [agentCommand('codex', 'new')],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['codex'],
      generation: 'g1',
    });
    const registry = new ActiveCommandRegistry();
    const logger = { error: vi.fn() };

    await registry.applyRegistrationPlan(plan, {
      logger,
      port: portReturning({
        status: 'failed',
        error: {
          code: 'command_registration_failed',
          message: 'remote failed',
          cause: { rawPayload: 'SECRET_PAYLOAD' },
        },
      }),
      activatedAt: new Date(0),
      retry: { maxAttempts: 1, backoffMs: 0 },
    });

    const [logFields] = logger.error.mock.calls[0]!;
    expect(logFields).toMatchObject({
      error: { code: 'command_registration_failed', message: 'remote failed' },
    });
    expect(JSON.stringify(logFields)).not.toContain('SECRET_PAYLOAD');
  });

  it('does not activate a stale generation result', async () => {
    const initial = buildCommandRegistrationPlan({
      descriptors: [agentCommand('codex', 'new')],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['codex'],
      generation: 'g1',
    });
    const next = buildCommandRegistrationPlan({
      descriptors: [agentCommand('claudecode', 'new')],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['claudecode'],
      generation: 'g2',
    });
    const registry = new ActiveCommandRegistry();
    registry.activate(initial, new Date(0));
    const logger = { error: vi.fn() };

    const result = await registry.applyRegistrationPlan(next, {
      logger,
      port: portReturning({ status: 'applied', generation: 'stale-g1' }),
      activatedAt: new Date(1),
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'command_activation_generation_mismatch' },
    });
    expect(registry.resolve(scope, 'codex-new')).toMatchObject({
      canonicalId: 'agent:codex:new',
    });
    expect(() => registry.resolve(scope, 'claudecode-new')).toThrow(
      CommandRegistryError,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 'g2',
        resultGeneration: 'stale-g1',
      }),
      'command_activation_generation_mismatch',
    );
  });

  it('treats registration timeout as failure and preserves the previous active map', async () => {
    const initial = buildCommandRegistrationPlan({
      descriptors: [agentCommand('codex', 'new')],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['codex'],
      generation: 'g1',
    });
    const next = buildCommandRegistrationPlan({
      descriptors: [agentCommand('claudecode', 'new')],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['claudecode'],
      generation: 'g2',
    });
    const registry = new ActiveCommandRegistry();
    registry.activate(initial, new Date(0));
    const logger = { error: vi.fn() };

    const result = await registry.applyRegistrationPlan(next, {
      logger,
      port: { applyCommandPlan: vi.fn(() => new Promise(() => {})) },
      activatedAt: new Date(1),
      timeoutMs: 1,
      retry: { maxAttempts: 1, backoffMs: 0 },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'command_registration_failed' },
    });
    expect(registry.resolve(scope, 'codex-new')).toMatchObject({
      canonicalId: 'agent:codex:new',
    });
    expect(() => registry.resolve(scope, 'claudecode-new')).toThrow(
      CommandRegistryError,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 'g2',
        error: {
          code: 'command_registration_failed',
          message: 'command registration timed out',
        },
      }),
      'command_registration_failed',
    );
  });

  it('retries remote registration failures before activating the matching generation', async () => {
    const plan = buildCommandRegistrationPlan({
      descriptors: [agentCommand('codex', 'new')],
      scope,
      capabilities: caps,
      policy: DEFAULT_COMMAND_NAME_POLICY,
      agentOwnersInScope: ['codex'],
      generation: 'g1',
    });
    const registry = new ActiveCommandRegistry();
    const logger = { error: vi.fn() };
    const applyCommandPlan = vi
      .fn<CommandRegistrationPort['applyCommandPlan']>()
      .mockResolvedValueOnce({
        status: 'failed',
        error: { code: 'command_registration_failed', message: 'remote failed' },
      })
      .mockResolvedValueOnce({ status: 'applied', generation: 'g1' });

    const result = await registry.applyRegistrationPlan(plan, {
      logger,
      port: { applyCommandPlan },
      activatedAt: new Date(1),
      retry: { maxAttempts: 2, backoffMs: 0 },
    });

    expect(result).toEqual({ status: 'applied', generation: 'g1' });
    expect(applyCommandPlan).toHaveBeenCalledTimes(2);
    expect(registry.resolve(scope, 'codex-new')).toMatchObject({
      canonicalId: 'agent:codex:new',
    });
  });
});

function portReturning(result: CommandRegistrationResult): CommandRegistrationPort {
  return { applyCommandPlan: vi.fn(async () => result) };
}
