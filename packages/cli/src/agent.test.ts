import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import {
  TerminalSessionStartError,
  type Logger,
} from '@agent-nexus/daemon';
import type { AgentRuntime } from '@agent-nexus/protocol';
import type { AgentConfig, AgentNexusConfig } from './config.js';

const claudeRuntime = { name: () => 'claudecode' } as AgentRuntime;
const codexRuntime = { name: () => 'codex' } as AgentRuntime;
const appServerRuntime = { name: () => 'codex-app-server' } as AgentRuntime;

const createClaudeCodeRuntimeMock = vi.hoisted(() => vi.fn(() => claudeRuntime));
const runClaudeProbeMock = vi.hoisted(() => vi.fn(async () => {}));
const createCodexRuntimeMock = vi.hoisted(() => vi.fn(() => codexRuntime));
const runCodexProbeMock = vi.hoisted(() => vi.fn(async () => {}));
const createAppServerRuntimeMock = vi.hoisted(() => vi.fn(() => appServerRuntime));
const defaultEngine = vi.hoisted(() => {
  const prepare = vi.fn(async () => undefined);
  const factory = Object.assign(vi.fn(), { prepare });
  return { prepare, factory };
});
const createDefaultEngineFactoryMock = vi.hoisted(() => vi.fn(() => defaultEngine.factory));
const codexProfileCatalog = vi.hoisted(() => ({
  profileId: vi.fn(() => 'codex-profile:test'),
  listRecent: vi.fn(async () => []),
}));
const createCodexProfileCatalogMock = vi.hoisted(() => vi.fn(() => codexProfileCatalog));
const runAppServerProbeMock = vi.hoisted(() => vi.fn(async () => ({ codexVersion: '0.146.0' })));
const runAppServerViewerProbeMock = vi.hoisted(() => vi.fn(async () => ({ codexVersion: '0.146.0' })));
const viewerAdapter = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  reconcileConversation: vi.fn(async () => undefined),
}));

vi.mock('@agent-nexus/agent-claudecode', () => ({
  claudeCodeCommandDescriptors: [{ handlerKey: 'new' }],
  createClaudeCodeRuntime: createClaudeCodeRuntimeMock,
  runCompatibilityProbe: runClaudeProbeMock,
}));

vi.mock('@agent-nexus/agent-codex', () => ({
  codexCommandDescriptors: [{ handlerKey: 'new' }],
  createCodexRuntime: createCodexRuntimeMock,
  runCompatibilityProbe: runCodexProbeMock,
}));

vi.mock('@agent-nexus/agent-codex-app-server', () => ({
  CodexProfileSessionCatalog: createCodexProfileCatalogMock,
  codexAppServerCommandDescriptors: [{ handlerKey: 'new' }],
  createCodexAppServerRuntime: createAppServerRuntimeMock,
  createDefaultCodexAppServerEngineFactory: createDefaultEngineFactoryMock,
  runCodexAppServerCompatibilityProbe: runAppServerProbeMock,
  runCodexAppServerViewerCompatibilityProbe: runAppServerViewerProbeMock,
}));

import { createAgentRegistry, createAgentRuntime } from './agent.js';

const logger = {
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function baseConfig(agentName: string, agents: AgentConfig[]): AgentNexusConfig {
  return {
    platforms: [
      {
        name: 'discord-main',
        type: 'discord',
        botUserId: 'bot',
        tokenRef: 'DISCORD_BOT_TOKEN',
        statePath: '/state/discord.json',
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
    agents,
    bindings: [
      {
        name: 'discord-main-binding',
        platformName: 'discord-main',
        agentName,
        match: { discord: { channelIds: ['C1'] } },
      },
    ],
    ui: { toolMessages: 'append' },
    log: { level: 'info' },
  };
}

describe('createAgentRuntime', () => {
  beforeEach(() => {
    createClaudeCodeRuntimeMock.mockClear();
    runClaudeProbeMock.mockClear();
    createCodexRuntimeMock.mockClear();
    runCodexProbeMock.mockClear();
    createAppServerRuntimeMock.mockClear();
    createDefaultEngineFactoryMock.mockClear();
    createCodexProfileCatalogMock.mockClear();
    defaultEngine.prepare.mockReset().mockResolvedValue(undefined);
    defaultEngine.factory.mockClear();
    runAppServerProbeMock.mockClear();
    runAppServerViewerProbeMock.mockClear();
    vi.mocked(logger.warn).mockClear();
  });

  it('codex-app-server backend 注入私有持久化依赖并创建结构化 runtime', async () => {
    const appServer = {
      bin: 'codex',
      workingDir: '/workspace',
      sandbox: 'read-only' as const,
      addDirs: [],
      maxInputBytes: 262_144,
      requestTimeoutMs: 30_000,
      interruptGraceMs: 5_000,
      terminateGraceMs: 5_000,
      conversationRetentionMs: null,
      supplementalViewer: { enabled: false },
    };
    const selected = await createAgentRuntime(
      { name: 'codex-persistent', backend: 'codex-app-server', codexAppServer: appServer },
      logger,
      {
        sourceCodexHome: '/private/source-codex',
        persistenceRoot: '/private/agent-nexus/codex-persistent',
        environment: { PATH: '/usr/bin', FEISHU_APP_SECRET: 'not-forwarded-by-engine' },
        clientVersion: 'test-version',
        viewerAdapter,
      },
    );

    expect(createDefaultEngineFactoryMock).toHaveBeenCalledWith({
      sourceCodexHome: '/private/source-codex',
      persistenceRoot: '/private/agent-nexus/codex-persistent',
      agentName: 'codex-persistent',
      clientVersion: 'test-version',
      environment: { PATH: '/usr/bin', FEISHU_APP_SECRET: 'not-forwarded-by-engine' },
      onMaintenanceError: expect.any(Function),
      viewerAdapter,
    });
    expect(runAppServerProbeMock).toHaveBeenCalledWith({ bin: 'codex' });
    expect(defaultEngine.prepare).toHaveBeenCalledTimes(1);
    expect(createAppServerRuntimeMock).toHaveBeenCalledWith(appServer, {
      createEngine: defaultEngine.factory,
    });
    expect(selected.agent).toBe(appServerRuntime);
    expect(selected.defaultSessionConfig).toEqual({
      workingDir: '/workspace',
      timeoutMs: 300_000,
    });
  });

  it('codex-app-server danger-full-access 保留日志告警并把模式传给平台告警 runtime', async () => {
    const config = appServerAgentConfig();
    config.codexAppServer.sandbox = 'danger-full-access';

    await createAgentRuntime(config, logger, {
      sourceCodexHome: '/private/source-codex',
      persistenceRoot: '/private/agent-nexus/codex-persistent',
      environment: {},
      viewerAdapter,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      { agentName: 'codex-persistent' },
      'codex_app_server_danger_full_access',
    );
    expect(createAppServerRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ sandbox: 'danger-full-access' }),
      { createEngine: defaultEngine.factory },
    );
  });

  it('codex-app-server maintenance 日志不序列化 terminal owner token', async () => {
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const realLogger = pino({ base: undefined, timestamp: false }, output);
    const appServer = appServerAgentConfig();

    await createAgentRuntime(appServer, realLogger, {
      sourceCodexHome: '/private/source-codex',
      persistenceRoot: '/private/agent-nexus/codex-persistent',
      environment: {},
    });

    const factoryOptions = createDefaultEngineFactoryMock.mock.calls.at(-1)?.[0] as {
      onMaintenanceError?: (error: Error) => void;
    };
    const ownerToken = 'terminal-owner-token-must-not-be-logged';
    factoryOptions.onMaintenanceError?.(new TerminalSessionStartError('ambiguous', {
      sessionId: '1'.repeat(32),
      ownerToken,
      incarnationId: '2'.repeat(32),
      state: 'Lost',
    }));

    const serialized = chunks.join('');
    expect(serialized).toContain('codex_app_server_maintenance_warning');
    expect(serialized).not.toContain(ownerToken);
    expect(serialized).not.toContain('ownerToken');
  });

  it('codex-app-server viewer gate 成功时注入 adapter 并保留 WebSocket intent', async () => {
    const runTerminalViewerProbe = vi.fn(async () => undefined);
    const config = appServerAgentConfig();
    config.codexAppServer.supplementalViewer = { enabled: true };

    await createAgentRuntime(config, logger, {
      sourceCodexHome: '/private/source-codex',
      persistenceRoot: '/private/agent-nexus/codex-persistent',
      environment: {},
      viewerAdapter,
      runTerminalViewerProbe,
    });

    expect(runAppServerViewerProbeMock).toHaveBeenCalledWith({ bin: 'codex' });
    expect(runTerminalViewerProbe).toHaveBeenCalledTimes(1);
    expect(createDefaultEngineFactoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ viewerAdapter }),
    );
    expect(createAppServerRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ supplementalViewer: { enabled: true } }),
      { createEngine: defaultEngine.factory },
    );
  });

  it('codex-app-server viewer gate 失败时告警并在 listener 前回退 stdio', async () => {
    const gateError = new Error('viewer surface unavailable');
    runAppServerViewerProbeMock.mockRejectedValueOnce(gateError);
    const config = appServerAgentConfig();
    config.codexAppServer.supplementalViewer = { enabled: true };

    await createAgentRuntime(config, logger, {
      sourceCodexHome: '/private/source-codex',
      persistenceRoot: '/private/agent-nexus/codex-persistent',
      environment: {},
      viewerAdapter,
      runTerminalViewerProbe: vi.fn(async () => undefined),
    });

    expect(createAppServerRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ supplementalViewer: { enabled: false } }),
      { createEngine: defaultEngine.factory },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { agentName: 'codex-persistent', err: gateError },
      'codex_supplemental_viewer_unavailable',
    );
  });

  it('codex-app-server terminal gate 失败时不选择 WebSocket host', async () => {
    const terminalError = new Error('tmux missing');
    const config = appServerAgentConfig();
    config.codexAppServer.supplementalViewer = { enabled: true };

    await createAgentRuntime(config, logger, {
      sourceCodexHome: '/private/source-codex',
      persistenceRoot: '/private/agent-nexus/codex-persistent',
      environment: {},
      viewerAdapter,
      runTerminalViewerProbe: vi.fn(async () => { throw terminalError; }),
    });

    expect(runAppServerViewerProbeMock).toHaveBeenCalledTimes(1);
    expect(createAppServerRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ supplementalViewer: { enabled: false } }),
      { createEngine: defaultEngine.factory },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { agentName: 'codex-persistent', err: terminalError },
      'codex_supplemental_viewer_unavailable',
    );
  });

  it('codex-app-server backend 在 reconciliation 完成前不创建 runtime', async () => {
    let releasePrepare!: () => void;
    defaultEngine.prepare.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releasePrepare = resolve;
      }),
    );
    const creating = createAgentRuntime(appServerAgentConfig(), logger, {
      sourceCodexHome: '/private/source-codex',
      persistenceRoot: '/private/agent-nexus/codex-persistent',
      environment: {},
      viewerAdapter,
    });

    await vi.waitFor(() => expect(defaultEngine.prepare).toHaveBeenCalledTimes(1));
    expect(createAppServerRuntimeMock).not.toHaveBeenCalled();

    releasePrepare();
    await creating;
    expect(createAppServerRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it('codex-app-server reconciliation 失败时阻止 runtime 创建', async () => {
    defaultEngine.prepare.mockRejectedValueOnce(new Error('registry reconciliation failed'));

    await expect(
      createAgentRuntime(appServerAgentConfig(), logger, {
        sourceCodexHome: '/private/source-codex',
        persistenceRoot: '/private/agent-nexus/codex-persistent',
      environment: {},
      viewerAdapter,
      }),
    ).rejects.toThrow('registry reconciliation failed');
    expect(createAppServerRuntimeMock).not.toHaveBeenCalled();
  });

  it('claudecode backend 跑 Claude probe 并注入 Claude runtime，保持默认 session config', async () => {
    const selected = await createAgentRuntime(
      {
        name: 'claude-prod',
        backend: 'claudecode',
        timeoutMs: 600_000,
        claudeCode: {
          bin: 'claude',
          workingDir: '/work',
          allowedTools: ['Read', 'Bash'],
          permissionLevel: 'default',
        },
      },
      logger,
    );

    expect(runClaudeProbeMock).toHaveBeenCalledWith({
      claudeBin: 'claude',
      logger,
      permissionLevel: 'default',
    });
    expect(createClaudeCodeRuntimeMock).toHaveBeenCalledWith({
      claudeBin: 'claude',
      allowedTools: ['Read', 'Bash'],
      permissionLevel: 'default',
      defaultWorkingDir: '/work',
      logger,
    });
    expect(runCodexProbeMock).not.toHaveBeenCalled();
    expect(createCodexRuntimeMock).not.toHaveBeenCalled();
    expect(selected.agent).toBe(claudeRuntime);
    expect(selected.defaultSessionConfig).toEqual({
      workingDir: '/work',
      timeoutMs: 600_000,
    });
  });

  it('codex backend 跑 Codex probe 并注入 Codex runtime', async () => {
    const codex = {
      bin: 'codex',
      workingDir: '/codex',
      sandbox: 'read-only',
      addDirs: [],
      loadUserConfig: false,
      loadRules: false,
    } as const;

    const selected = await createAgentRuntime(
      { name: 'codex-dev', backend: 'codex', timeoutMs: 1_800_000, codex },
      logger,
      {
        sourceCodexHome: '/profiles/codex-main',
        environment: { PATH: '/usr/bin:/bin' },
      },
    );

    const effectiveCodex = {
      ...codex,
      codexHome: '/profiles/codex-main',
    };

    expect(runCodexProbeMock).toHaveBeenCalledWith({
      config: effectiveCodex,
      logger,
      timeoutMs: 1_800_000,
    });
    expect(createCodexRuntimeMock).toHaveBeenCalledWith({
      config: effectiveCodex,
      logger,
    });
    expect(createCodexProfileCatalogMock).toHaveBeenCalledWith(
      {
        bin: 'codex',
        codexHome: '/profiles/codex-main',
        allowedWorkingDirs: ['/codex'],
        clientVersion: '0.146.0',
        requestTimeoutMs: 30_000,
        terminateGraceMs: 5_000,
      },
      { environment: { PATH: '/usr/bin:/bin' } },
    );
    expect(selected.sessionCatalog).toBe(codexProfileCatalog);
    expect(selected.sessionProfileRequired).toBe(true);
    expect(runClaudeProbeMock).not.toHaveBeenCalled();
    expect(createClaudeCodeRuntimeMock).not.toHaveBeenCalled();
    expect(selected.agent).toBe(codexRuntime);
    expect(selected.defaultSessionConfig).toEqual({
      workingDir: '/codex',
      timeoutMs: 1_800_000,
    });
  });

  it('codex backend 未配置 timeoutMs 时 probe 使用默认 timeout', async () => {
    const codex = {
      bin: 'codex',
      workingDir: '/codex',
      sandbox: 'read-only',
      addDirs: [],
      loadUserConfig: false,
      loadRules: false,
    } as const;

    const selected = await createAgentRuntime(
      { name: 'codex-dev', backend: 'codex', codex },
      logger,
      { sourceCodexHome: '/profiles/codex-main' },
    );

    expect(runCodexProbeMock).toHaveBeenCalledWith({
      config: { ...codex, codexHome: '/profiles/codex-main' },
      logger,
      timeoutMs: 300_000,
    });
    expect(selected.defaultSessionConfig).toEqual({
      workingDir: '/codex',
      timeoutMs: 300_000,
    });
  });
});

function appServerAgentConfig(): AgentConfig {
  return {
    name: 'codex-persistent',
    backend: 'codex-app-server',
    codexAppServer: {
      bin: 'codex',
      workingDir: '/workspace',
      sandbox: 'read-only',
      addDirs: [],
      maxInputBytes: 262_144,
      requestTimeoutMs: 30_000,
      interruptGraceMs: 5_000,
      terminateGraceMs: 5_000,
      conversationRetentionMs: null,
      supplementalViewer: { enabled: false },
    },
  };
}

describe('createAgentRegistry', () => {
  it('registers codex-app-server with its own owner and command descriptors', async () => {
    const appServerAgent: AgentConfig = {
      name: 'codex-persistent',
      backend: 'codex-app-server',
      codexAppServer: {
        bin: 'codex',
        workingDir: '/workspace',
        sandbox: 'read-only',
        addDirs: [],
        maxInputBytes: 262_144,
        requestTimeoutMs: 30_000,
        interruptGraceMs: 5_000,
        terminateGraceMs: 5_000,
        conversationRetentionMs: null,
        supplementalViewer: { enabled: false },
      },
    };
    const registry = await createAgentRegistry(
      baseConfig('codex-persistent', [appServerAgent]),
      logger,
      {
        sourceCodexHome: '/private/source-codex',
        persistenceRoot: '/private/persistence',
        environment: {},
        viewerAdapter,
      },
    );

    expect(registry).toEqual([
      expect.objectContaining({
        agentName: 'codex-persistent',
        agentOwner: 'codex-app-server',
        agent: appServerRuntime,
        commandDescriptors: [{ handlerKey: 'new' }],
      }),
    ]);
  });
});

describe('createAgentRegistry', () => {
  it('为每个命名 agent 创建 runtime，binding 选择交给 daemon router', async () => {
    const registry = await createAgentRegistry(
      baseConfig('codex-dev', [
        {
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
        },
        {
          name: 'claude-prod',
          backend: 'claudecode',
          claudeCode: {
            bin: 'claude',
            workingDir: '/claude',
            allowedTools: ['Read'],
            permissionLevel: 'default',
          },
        },
      ]),
      logger,
    );

    expect(registry).toHaveLength(2);
    expect(registry[0]).toMatchObject({
      agentName: 'codex-dev',
      agentOwner: 'codex',
      agent: codexRuntime,
    });
    expect(registry[1]).toMatchObject({
      agentName: 'claude-prod',
      agentOwner: 'claudecode',
      agent: claudeRuntime,
    });
  });

  it('多个 binding 不再阻止 agent registry 创建', async () => {
    const config = baseConfig('codex-dev', [
      {
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
      },
    ]);
    config.bindings.push({
      name: 'discord-main-binding-2',
      platformName: 'discord-main',
      agentName: 'codex-dev',
      match: { discord: { channelIds: ['C2'] } },
    });

    await expect(createAgentRegistry(config, logger)).resolves.toHaveLength(1);
  });
});
