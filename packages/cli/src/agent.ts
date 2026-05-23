import {
  createClaudeCodeRuntime,
  runCompatibilityProbe as runClaudeCodeCompatibilityProbe,
} from '@agent-nexus/agent-claudecode';
import {
  createCodexRuntime,
  runCompatibilityProbe as runCodexCompatibilityProbe,
} from '@agent-nexus/agent-codex';
import type { Logger } from '@agent-nexus/daemon';
import type { AgentRuntime, SessionConfig } from '@agent-nexus/protocol';
import type { AgentNexusConfig } from './config.js';

const DEFAULT_SESSION_TIMEOUT_MS = 300_000;

export interface SelectedAgent {
  agent: AgentRuntime;
  defaultSessionConfig: Omit<
    SessionConfig,
    'resumeFromAgentSessionId' | 'sessionId'
  >;
}

export async function createSelectedAgent(
  config: AgentNexusConfig,
  logger: Logger,
): Promise<SelectedAgent> {
  if (config.agent.backend === 'codex') {
    const codex = config.codex;
    if (!codex) throw new Error('agent.backend=codex 需要 codex 配置');

    await runCodexCompatibilityProbe({
      config: codex,
      logger,
      timeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    });
    return {
      agent: createCodexRuntime({ config: codex, logger }),
      defaultSessionConfig: {
        workingDir: codex.workingDir,
        toolWhitelist: [],
        timeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
      },
    };
  }

  const claudeCode = config.claudeCode;
  if (!claudeCode) {
    throw new Error('agent.backend=claudecode 需要 claudeCode 配置');
  }

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
      toolWhitelist: claudeCode.allowedTools,
      timeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    },
  };
}
