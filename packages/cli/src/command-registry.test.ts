import { describe, expect, it } from 'vitest';
import { codexCommandDescriptors } from '@agent-nexus/agent-codex';
import { claudeCodeCommandDescriptors } from '@agent-nexus/agent-claudecode';
import type { CapabilitySet, AgentRuntime } from '@agent-nexus/protocol';
import type { EngineAgent } from '@agent-nexus/daemon';
import { ConfigError, type AgentConfig, type AgentNexusConfig } from './config.js';
import { buildCliCommandRegistrationPlan } from './command-registry.js';

const capabilities: CapabilitySet = {
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

const codexAgent: AgentConfig = {
  name: 'codex-dev',
  backend: 'codex',
  codex: {
    bin: 'codex',
    workingDir: '/codex',
    sandbox: 'read-only',
    addDirs: [],
    loadUserConfig: false,
    loadRules: false,
  },
};

const claudeAgent: AgentConfig = {
  name: 'claude-prod',
  backend: 'claudecode',
  claudeCode: {
    bin: 'claude',
    workingDir: '/claude',
    allowedTools: ['Read'],
    permissionLevel: 'default',
  },
};

function baseConfig(overrides: Partial<AgentNexusConfig> = {}): AgentNexusConfig {
  return {
    platforms: [
      {
        name: 'discord-main',
        type: 'discord',
        botUserId: 'bot',
        tokenRef: 'DISCORD_BOT_TOKEN',
        statePath: '/state/discord-main.json',
        publicChannelMode: 'thread',
        auth: {
          allowlist: {
            userIds: ['U1'],
            roleIds: [],
            allowedGuildIds: ['G1'],
            allowedChannelIds: [],
            allowDM: true,
            requireMentionOrSlash: true,
          },
        },
      },
    ],
    agents: [codexAgent],
    bindings: [
      {
        name: 'discord-main-codex',
        platformName: 'discord-main',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ],
    daemon: {
      commandRegistry: {
        registration: {
          enabled: true,
          applyTimeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 0 },
        },
        aliases: {
          singleAgent: { enabled: true },
          legacy: { replyMode: true },
        },
        textPrefixes: { newSession: true },
      },
    },
    ui: { toolMessages: 'append' },
    log: { level: 'info' },
    ...overrides,
  };
}

function commandKeys(plan: ReturnType<typeof buildCliCommandRegistrationPlan>): string[] {
  return plan.commands.map(
    (command) =>
      `${command.commandName}:${command.canonicalId}:${command.aliasKind}`,
  );
}

function engineAgentsFor(config: AgentNexusConfig): EngineAgent[] {
  return config.agents.map((agent): EngineAgent => {
    const commandDescriptors =
      agent.backend === 'codex'
        ? codexCommandDescriptors
        : claudeCodeCommandDescriptors;
    return {
      agentName: agent.name,
      agentOwner: agent.backend,
      commandDescriptors,
      agent: { name: () => agent.backend } as AgentRuntime,
      defaultSessionConfig: { workingDir: '/tmp', timeoutMs: 300_000 },
    };
  });
}

describe('buildCliCommandRegistrationPlan', () => {
  it('builds a Discord plan with platform commands and a single-agent alias for the bound Codex owner', () => {
    const config = baseConfig();
    const plan = buildCliCommandRegistrationPlan({
      config,
      agents: engineAgentsFor(config),
      platformName: 'discord-main',
      capabilities,
      generation: 'g1',
    });

    expect(plan.scope).toEqual({
      platformName: 'discord-main',
      platformType: 'discord',
      nativeScope: { kind: 'global' },
    });
    expect(commandKeys(plan)).toEqual([
      'nexus-kill:daemon:kill:stable',
      'discord-reply-mode:platform:discord:reply-mode:stable',
      'codex-new:agent:codex:new:stable',
      'codex-stop:agent:codex:stop:stable',
      'reply-mode:platform:discord:reply-mode:legacy',
      'new:agent:codex:new:single-agent-alias',
      'stop:agent:codex:stop:single-agent-alias',
    ]);
    expect(plan.reverseMap.entries['new']).toMatchObject({
      canonicalId: 'agent:codex:new',
      aliasKind: 'single-agent-alias',
    });
  });

  it('removes bare agent aliases when one platform scope exposes multiple agent owners', () => {
    const config = baseConfig({
        agents: [codexAgent, claudeAgent],
        bindings: [
          {
            name: 'discord-main-codex',
            platformName: 'discord-main',
            agentName: 'codex-dev',
            match: { discord: { channelIds: ['C1'] } },
          },
          {
            name: 'discord-main-claude',
            platformName: 'discord-main',
            agentName: 'claude-prod',
            match: { discord: { channelIds: ['C2'] } },
          },
        ],
      });
    const plan = buildCliCommandRegistrationPlan({
      config,
      agents: engineAgentsFor(config),
      platformName: 'discord-main',
      capabilities,
      generation: 'g2',
    });

    expect(commandKeys(plan)).toEqual([
      'nexus-kill:daemon:kill:stable',
      'discord-reply-mode:platform:discord:reply-mode:stable',
      'codex-new:agent:codex:new:stable',
      'codex-stop:agent:codex:stop:stable',
      'claudecode-new:agent:claudecode:new:stable',
      'claudecode-stop:agent:claudecode:stop:stable',
      'reply-mode:platform:discord:reply-mode:legacy',
    ]);
    expect(plan.reverseMap.entries).not.toHaveProperty('new');
  });

  it('deduplicates descriptors when multiple agent instances use the same backend owner', () => {
    const secondCodexAgent: AgentConfig = {
      ...codexAgent,
      name: 'codex-prod',
    };

    const config = baseConfig({
        agents: [codexAgent, secondCodexAgent],
        bindings: [
          {
            name: 'discord-main-codex-dev',
            platformName: 'discord-main',
            agentName: 'codex-dev',
            match: { discord: { channelIds: ['C1'] } },
          },
          {
            name: 'discord-main-codex-prod',
            platformName: 'discord-main',
            agentName: 'codex-prod',
            match: { discord: { channelIds: ['C2'] } },
          },
        ],
      });
    const plan = buildCliCommandRegistrationPlan({
      config,
      agents: engineAgentsFor(config),
      platformName: 'discord-main',
      capabilities,
      generation: 'g2b',
    });

    expect(
      plan.commands.filter((command) => command.canonicalId === 'agent:codex:new'),
    ).toHaveLength(2);
    expect(plan.reverseMap.entries['new']).toMatchObject({
      canonicalId: 'agent:codex:new',
      aliasKind: 'single-agent-alias',
    });
  });

  it('uses testGuildId as the native registration scope', () => {
    const config = baseConfig({
        platforms: [
          {
            ...baseConfig().platforms[0]!,
            testGuildId: 'GUILD123',
          },
        ],
      });
    const plan = buildCliCommandRegistrationPlan({
      config,
      agents: engineAgentsFor(config),
      platformName: 'discord-main',
      capabilities,
      generation: 'g3',
    });

    expect(plan.scope.nativeScope).toEqual({
      kind: 'guild',
      guildId: 'GUILD123',
    });
  });

  it('daemon config can disable bare single-agent aliases without removing stable names', () => {
    const config = baseConfig({
        daemon: {
          ...baseConfig().daemon,
          commandRegistry: {
            ...baseConfig().daemon.commandRegistry,
            aliases: {
              ...baseConfig().daemon.commandRegistry.aliases,
              singleAgent: { enabled: false },
            },
          },
        },
      });
    const plan = buildCliCommandRegistrationPlan({
      config,
      agents: engineAgentsFor(config),
      platformName: 'discord-main',
      capabilities,
      generation: 'g-alias-off',
    });

    expect(commandKeys(plan)).toEqual([
      'nexus-kill:daemon:kill:stable',
      'discord-reply-mode:platform:discord:reply-mode:stable',
      'codex-new:agent:codex:new:stable',
      'codex-stop:agent:codex:stop:stable',
      'reply-mode:platform:discord:reply-mode:legacy',
    ]);
    expect(plan.reverseMap.entries).not.toHaveProperty('new');
  });

  it('daemon config can disable legacy /reply-mode while keeping the stable replacement', () => {
    const config = baseConfig({
        daemon: {
          ...baseConfig().daemon,
          commandRegistry: {
            ...baseConfig().daemon.commandRegistry,
            aliases: {
              ...baseConfig().daemon.commandRegistry.aliases,
              legacy: { replyMode: false },
            },
          },
        },
      });
    const plan = buildCliCommandRegistrationPlan({
      config,
      agents: engineAgentsFor(config),
      platformName: 'discord-main',
      capabilities,
      generation: 'g-legacy-off',
    });

    expect(commandKeys(plan)).toEqual([
      'nexus-kill:daemon:kill:stable',
      'discord-reply-mode:platform:discord:reply-mode:stable',
      'codex-new:agent:codex:new:stable',
      'codex-stop:agent:codex:stop:stable',
      'new:agent:codex:new:single-agent-alias',
      'stop:agent:codex:stop:single-agent-alias',
    ]);
    expect(plan.reverseMap.entries).not.toHaveProperty('reply-mode');
  });

  it('fails clearly when the requested platform is absent', () => {
    expect(() =>
      buildCliCommandRegistrationPlan({
        config: baseConfig(),
        agents: engineAgentsFor(baseConfig()),
        platformName: 'discord-missing',
        capabilities,
        generation: 'g4',
      }),
    ).toThrow(ConfigError);
  });
});
