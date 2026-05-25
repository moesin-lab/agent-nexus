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
import type { AgentRuntime, SessionConfig } from '@agent-nexus/protocol';
import type { EngineAgent } from '@agent-nexus/daemon';
import type { AgentConfig, AgentNexusConfig } from './config.js';

const DEFAULT_SESSION_TIMEOUT_MS = 300_000;

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
  if (agentConfig.backend === 'codex') {
    const codex = agentConfig.codex;
    await runCodexCompatibilityProbe({
      config: codex,
      logger,
      timeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    });
    return {
      agent: createCodexRuntime({ config: codex, logger }),
      defaultSessionConfig: {
        workingDir: codex.workingDir,
        timeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
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
      timeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
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
    registry.push({
      agentName: agentConfig.name,
      agentOwner: agentConfig.backend,
      commandHandlerKeys:
        agentConfig.backend === 'codex'
          ? codexCommandDescriptors.map((descriptor) => descriptor.handlerKey)
          : claudeCodeCommandDescriptors.map((descriptor) => descriptor.handlerKey),
      agent: selected.agent,
      defaultSessionConfig: selected.defaultSessionConfig,
    });
  }
  return registry;
}
