import {
  discordReplyModeCommandDescriptor,
} from '@agent-nexus/platform-discord';
import {
  buildCommandRegistrationPlan,
  daemonCommandDescriptors,
  DEFAULT_COMMAND_NAME_POLICY,
  type EngineAgent,
} from '@agent-nexus/daemon';
import type {
  CapabilitySet,
  CommandDescriptor,
  CommandRegistrationPlan,
  CommandRegistrationScope,
} from '@agent-nexus/protocol';
import {
  ConfigError,
  type AgentConfig,
  type AgentNexusConfig,
  type PlatformConfig,
} from './config.js';

export interface BuildCliCommandRegistrationPlanInput {
  config: AgentNexusConfig;
  agents: readonly EngineAgent[];
  platformName: string;
  capabilities: CapabilitySet;
  generation: string;
}

function commandScopeForPlatform(
  platform: PlatformConfig,
): CommandRegistrationScope {
  return {
    platformName: platform.name,
    platformType: platform.type,
    nativeScope: platform.testGuildId
      ? { kind: 'guild', guildId: platform.testGuildId }
      : { kind: 'global' },
  };
}

function enabledCommandDescriptors(
  agents: readonly EngineAgent[],
): CommandDescriptor[] {
  const descriptors: CommandDescriptor[] = [
    ...daemonCommandDescriptors,
    discordReplyModeCommandDescriptor,
  ];
  const seenAgentOwners = new Set<string>();
  for (const agent of agents) {
    const owner = agent.agentOwner ?? agent.agent.name();
    if (seenAgentOwners.has(owner)) continue;
    seenAgentOwners.add(owner);
    descriptors.push(...(agent.commandDescriptors ?? []));
  }
  return descriptors;
}

function agentByName(config: AgentNexusConfig): Map<string, AgentConfig> {
  return new Map(config.agents.map((agent) => [agent.name, agent]));
}

function agentOwnersForPlatform(
  config: AgentNexusConfig,
  platformName: string,
): string[] {
  const agents = agentByName(config);
  const owners = new Set<string>();
  for (const binding of config.bindings) {
    if (binding.platformName !== platformName) continue;
    const agent = agents.get(binding.agentName);
    if (!agent) {
      throw new ConfigError(
        `binding "${binding.name}" 引用了不存在的 agent "${binding.agentName}"`,
      );
    }
    owners.add(agent.backend);
  }
  return [...owners];
}

export function buildCliCommandRegistrationPlan(
  input: BuildCliCommandRegistrationPlanInput,
): CommandRegistrationPlan {
  const platform = input.config.platforms.find(
    (candidate) => candidate.name === input.platformName,
  );
  if (!platform) {
    throw new ConfigError(`platform "${input.platformName}" 不存在`);
  }

  return buildCommandRegistrationPlan({
    descriptors: enabledCommandDescriptors(input.agents),
    scope: commandScopeForPlatform(platform),
    capabilities: input.capabilities,
    policy: DEFAULT_COMMAND_NAME_POLICY,
    agentOwnersInScope: agentOwnersForPlatform(input.config, platform.name),
    generation: input.generation,
    singleAgentAliasesEnabled:
      input.config.daemon.commandRegistry.aliases.singleAgent.enabled,
    legacyReplyModeEnabled:
      input.config.daemon.commandRegistry.aliases.legacy.replyMode,
  });
}
