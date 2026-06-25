import {
  claudeCodeCommandDescriptors,
  createClaudeCodeRuntime,
  runCompatibilityProbe as runClaudeCodeCompatibilityProbe,
} from '@agent-nexus/agent-claudecode';
import {
  codexCommandDescriptors,
  createCodexRuntime,
  runCompatibilityProbe as runCodexCompatibilityProbe,
} from '@agent-nexus/agent-codex';
import type { Logger } from '@agent-nexus/daemon';
import type {
  AgentRuntime,
  CommandDescriptor,
  SessionConfig,
} from '@agent-nexus/protocol';
import type { EngineAgent } from '@agent-nexus/daemon';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  type AgentConfig,
  type AgentNexusConfig,
} from './config.js';

const CODEX_COMPATIBILITY_PROBE_TIMEOUT_MS = DEFAULT_AGENT_TIMEOUT_MS;

export interface SelectedAgent {
  agent: AgentRuntime;
  defaultSessionConfig: Omit<
    SessionConfig,
    'resumeFromAgentSessionId' | 'sessionId'
  >;
}

export async function createAgentRuntime(
  agentConfig: AgentConfig,
  logger: Logger,
): Promise<SelectedAgent> {
  const timeoutMs = agentConfig.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  if (agentConfig.backend === 'codex') {
    const codex = agentConfig.codex;
    await runCodexCompatibilityProbe({
      config: codex,
      logger,
      timeoutMs: CODEX_COMPATIBILITY_PROBE_TIMEOUT_MS,
    });
    return {
      agent: createCodexRuntime({ config: codex, logger }),
      defaultSessionConfig: {
        workingDir: codex.workingDir,
        timeoutMs,
      },
    };
  }

  const claudeCode = agentConfig.claudeCode;
  await runClaudeCodeCompatibilityProbe({
    claudeBin: claudeCode.bin,
    logger,
    permissionLevel: claudeCode.permissionLevel,
  });

  if (claudeCode.allowedTools.includes('Bash')) {
    // spec/security/tool-boundary.md：危险工具显式启用必须打 warn。
    logger.warn(
      { tools: claudeCode.allowedTools },
      'tool_boundary_bash_enabled',
    );
  }
  if (claudeCode.permissionLevel !== 'default') {
    logger.warn(
      { permissionLevel: claudeCode.permissionLevel },
      'cc_permission_level_non_default',
    );
  }

  return {
    agent: createClaudeCodeRuntime({
      claudeBin: claudeCode.bin,
      allowedTools: claudeCode.allowedTools,
      permissionLevel: claudeCode.permissionLevel,
      defaultWorkingDir: claudeCode.workingDir,
      logger,
    }),
    defaultSessionConfig: {
      workingDir: claudeCode.workingDir,
      timeoutMs,
    },
  };
}

export async function createAgentRegistry(
  config: AgentNexusConfig,
  logger: Logger,
): Promise<EngineAgent[]> {
  const registry: EngineAgent[] = [];
  for (const agentConfig of config.agents) {
    const selected = await createAgentRuntime(agentConfig, logger);
    const commandDescriptors: readonly CommandDescriptor[] =
      agentConfig.backend === 'codex'
        ? codexCommandDescriptors
        : claudeCodeCommandDescriptors;
    registry.push({
      agentName: agentConfig.name,
      agentOwner: agentConfig.backend,
      commandDescriptors,
      agent: selected.agent,
      defaultSessionConfig: selected.defaultSessionConfig,
    });
  }
  return registry;
}
