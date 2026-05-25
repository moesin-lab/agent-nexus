import { describe, expect, it } from 'vitest';
import type { CapabilitySet } from '@agent-nexus/protocol';
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

describe('buildCliCommandRegistrationPlan', () => {
  it('builds a Discord plan with platform commands and a single-agent alias for the bound Codex owner', () => {
    const plan = buildCliCommandRegistrationPlan({
      config: baseConfig(),
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
      'discord-reply-mode:platform:discord:reply-mode:stable',
      'codex-new:agent:codex:new:stable',
      'reply-mode:platform:discord:reply-mode:legacy',
      'new:agent:codex:new:single-agent-alias',
    ]);
    expect(plan.reverseMap.entries['new']).toMatchObject({
      canonicalId: 'agent:codex:new',
      aliasKind: 'single-agent-alias',
    });
  });

  it('removes the bare /new alias when one platform scope exposes multiple agent owners', () => {
    const plan = buildCliCommandRegistrationPlan({
      config: baseConfig({
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
      }),
      platformName: 'discord-main',
      capabilities,
      generation: 'g2',
    });

    expect(commandKeys(plan)).toEqual([
      'discord-reply-mode:platform:discord:reply-mode:stable',
      'codex-new:agent:codex:new:stable',
      'claudecode-new:agent:claudecode:new:stable',
      'reply-mode:platform:discord:reply-mode:legacy',
    ]);
    expect(plan.reverseMap.entries).not.toHaveProperty('new');
  });

  it('deduplicates descriptors when multiple agent instances use the same backend owner', () => {
    const secondCodexAgent: AgentConfig = {
      ...codexAgent,
      name: 'codex-prod',
    };

    const plan = buildCliCommandRegistrationPlan({
      config: baseConfig({
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
      }),
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
    const plan = buildCliCommandRegistrationPlan({
      config: baseConfig({
        platforms: [
          {
            ...baseConfig().platforms[0]!,
            testGuildId: 'GUILD123',
          },
        ],
      }),
      platformName: 'discord-main',
      capabilities,
      generation: 'g3',
    });

    expect(plan.scope.nativeScope).toEqual({
      kind: 'guild',
      guildId: 'GUILD123',
    });
  });

  it('fails clearly when the requested platform is absent', () => {
    expect(() =>
      buildCliCommandRegistrationPlan({
        config: baseConfig(),
        platformName: 'discord-missing',
        capabilities,
        generation: 'g4',
      }),
    ).toThrow(ConfigError);
  });
});
