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
import { ConfigError, type AgentConfig, type AgentNexusConfig } from './config.js';

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
        toolWhitelist: [],
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
      toolWhitelist: claudeCode.allowedTools,
      timeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    },
  };
}

export async function createSelectedAgent(
  config: AgentNexusConfig,
  logger: Logger,
): Promise<SelectedAgent> {
  if (config.platforms.length !== 1) {
    throw new ConfigError('P9 CLI 启动暂只支持一个 platform；P10 会接入多 platform 路由');
  }
  const platform = config.platforms[0];
  if (!platform) {
    throw new ConfigError('P9 CLI 启动需要一个 platform');
  }
  if (config.bindings.length !== 1) {
    throw new ConfigError('P9 CLI 启动暂只支持一个 binding；P10 会接入多 agent 路由');
  }
  const binding = config.bindings[0];
  if (!binding) {
    throw new ConfigError('P9 CLI 启动需要一个 binding');
  }
  const agentConfig = config.agents.find(
    (agent) => agent.name === binding.agentName,
  );
  if (!agentConfig) {
    throw new ConfigError(`binding 引用了不存在的 agent：${binding.agentName}`);
  }
  return createAgentRuntime(agentConfig, logger);
}
