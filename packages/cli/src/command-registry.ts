import { claudeCodeCommandDescriptors } from '@agent-nexus/agent-claudecode';
import { codexCommandDescriptors } from '@agent-nexus/agent-codex';
import {
  discordReplyModeCommandDescriptor,
} from '@agent-nexus/platform-discord';
import {
  buildCommandRegistrationPlan,
  DEFAULT_COMMAND_NAME_POLICY,
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

function descriptorsForAgent(agent: AgentConfig): readonly CommandDescriptor[] {
  if (agent.backend === 'codex') return codexCommandDescriptors;
  return claudeCodeCommandDescriptors;
}

function enabledCommandDescriptors(
  config: AgentNexusConfig,
): CommandDescriptor[] {
  const descriptors: CommandDescriptor[] = [discordReplyModeCommandDescriptor];
  const seenAgentOwners = new Set<AgentConfig['backend']>();
  for (const agent of config.agents) {
    if (seenAgentOwners.has(agent.backend)) continue;
    seenAgentOwners.add(agent.backend);
    descriptors.push(...descriptorsForAgent(agent));
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
    descriptors: enabledCommandDescriptors(input.config),
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
