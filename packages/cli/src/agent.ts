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
import {
  CodexRemoteViewerAdapter,
  codexAppServerCommandDescriptors,
  createCodexAppServerRuntime,
  createDefaultCodexAppServerEngineFactory,
  runCodexAppServerCompatibilityProbe,
  runCodexAppServerViewerCompatibilityProbe,
  type CodexRemoteViewerPort,
} from '@agent-nexus/agent-codex-app-server';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  ExperimentalTmuxTerminalSessionHost,
  type Logger,
} from '@agent-nexus/daemon';
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
  configRoot,
} from './config.js';

export interface SelectedAgent {
  agent: AgentRuntime;
  defaultSessionConfig: Omit<
    SessionConfig,
    'resumeFromAgentSessionId' | 'sessionId'
  >;
}

export interface AgentRuntimeAssemblyDependencies {
  sourceCodexHome?: string;
  persistenceRoot?: string;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  clientVersion?: string;
  viewerAdapter?: CodexRemoteViewerPort;
  runTerminalViewerProbe?: () => Promise<void>;
}

const execFileAsync = promisify(execFile);

export async function createAgentRuntime(
  agentConfig: AgentConfig,
  logger: Logger,
  assembly: AgentRuntimeAssemblyDependencies = {},
): Promise<SelectedAgent> {
  const timeoutMs = agentConfig.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  if (agentConfig.backend === 'codex') {
    const codex = agentConfig.codex;
    await runCodexCompatibilityProbe({
      config: codex,
      logger,
      timeoutMs,
    });
    return {
      agent: createCodexRuntime({ config: codex, logger }),
      defaultSessionConfig: {
        workingDir: codex.workingDir,
        timeoutMs,
      },
    };
  }

  if (agentConfig.backend === 'codex-app-server') {
    const appServer = agentConfig.codexAppServer;
    await runCodexAppServerCompatibilityProbe({ bin: appServer.bin });
    const sourceCodexHome = assembly.sourceCodexHome ?? await realpath(
      process.env['CODEX_HOME'] || join(homedir(), '.codex'),
    );
    const ownerId = createHash('sha256').update(agentConfig.name).digest('hex');
    const instanceRoot = assembly.persistenceRoot
      ? null
      : await realpath(configRoot());
    const persistenceRoot =
      assembly.persistenceRoot ?? join(instanceRoot!, 'state', 'codex-app-server', ownerId);
    let viewerGateAvailable = false;
    if (appServer.supplementalViewer.enabled) {
      try {
        await runCodexAppServerViewerCompatibilityProbe({ bin: appServer.bin });
        await (assembly.runTerminalViewerProbe ?? defaultTerminalViewerProbe)();
        viewerGateAvailable = true;
      } catch (err) {
        logger.warn(
          { agentName: agentConfig.name, err },
          'codex_supplemental_viewer_unavailable',
        );
      }
    }
    let viewerAdapter = assembly.viewerAdapter;
    if (!viewerAdapter) {
      try {
        viewerAdapter = new CodexRemoteViewerAdapter({
          terminalHost: new ExperimentalTmuxTerminalSessionHost({
            rootDir: join(persistenceRoot, 'terminal-sessions'),
          }),
          onMaintenanceError: (err) => {
            logger.warn(
              { agentName: agentConfig.name, err },
              'codex_supplemental_viewer_maintenance',
            );
          },
        });
      } catch (err) {
        if (appServer.supplementalViewer.enabled && viewerGateAvailable) {
          viewerGateAvailable = false;
          logger.warn(
            { agentName: agentConfig.name, err },
            'codex_supplemental_viewer_unavailable',
          );
        }
      }
    }
    const effectiveAppServer = appServer.supplementalViewer.enabled &&
      (!viewerGateAvailable || !viewerAdapter)
      ? { ...appServer, supplementalViewer: { enabled: false } }
      : appServer;
    const createEngine = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: agentConfig.name,
      clientVersion: assembly.clientVersion ?? '0.1.0',
      environment: assembly.environment ?? process.env,
      ...(viewerAdapter ? { viewerAdapter } : {}),
      onMaintenanceError: (error) => {
        logger.warn(
          { agentName: agentConfig.name, err: maintenanceDiagnostic(error) },
          'codex_app_server_maintenance_warning',
        );
      },
    });
    await createEngine.prepare();
    if (appServer.sandbox === 'danger-full-access') {
      logger.warn({ agentName: agentConfig.name }, 'codex_app_server_danger_full_access');
    }
    if (appServer.conversationRetentionMs !== null) {
      logger.warn(
        { agentName: agentConfig.name, retentionMs: appServer.conversationRetentionMs },
        'codex_app_server_retention_may_invalidate_history',
      );
    }
    return {
      agent: createCodexAppServerRuntime(effectiveAppServer, { createEngine }),
      defaultSessionConfig: { workingDir: appServer.workingDir, timeoutMs },
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

function maintenanceDiagnostic(source: Error): Error {
  const diagnostic = new Error(source.message);
  diagnostic.name = source.name;
  if (source.stack) diagnostic.stack = source.stack;
  const code = (source as Error & { code?: unknown }).code;
  if (typeof code === 'string') {
    Object.defineProperty(diagnostic, 'code', {
      value: code,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return diagnostic;
}

async function defaultTerminalViewerProbe(): Promise<void> {
  await execFileAsync('tmux', ['-V'], {
    timeout: 5_000,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
  });
}

export async function createAgentRegistry(
  config: AgentNexusConfig,
  logger: Logger,
  assembly: AgentRuntimeAssemblyDependencies = {},
): Promise<EngineAgent[]> {
  const registry: EngineAgent[] = [];
  for (const agentConfig of config.agents) {
    const selected = await createAgentRuntime(agentConfig, logger, assembly);
    const commandDescriptors: readonly CommandDescriptor[] =
      agentConfig.backend === 'codex'
        ? codexCommandDescriptors
        : agentConfig.backend === 'codex-app-server'
          ? codexAppServerCommandDescriptors
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
