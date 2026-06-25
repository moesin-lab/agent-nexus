import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@agent-nexus/daemon';
import type { AgentRuntime } from '@agent-nexus/protocol';
import type { AgentConfig, AgentNexusConfig } from './config.js';

const claudeRuntime = { name: () => 'claudecode' } as AgentRuntime;
const codexRuntime = { name: () => 'codex' } as AgentRuntime;

const createClaudeCodeRuntimeMock = vi.hoisted(() => vi.fn(() => claudeRuntime));
const runClaudeProbeMock = vi.hoisted(() => vi.fn(async () => {}));
const createCodexRuntimeMock = vi.hoisted(() => vi.fn(() => codexRuntime));
const runCodexProbeMock = vi.hoisted(() => vi.fn(async () => {}));

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
    vi.mocked(logger.warn).mockClear();
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
    );

    expect(runCodexProbeMock).toHaveBeenCalledWith({
      config: codex,
      logger,
      timeoutMs: 300_000,
    });
    expect(createCodexRuntimeMock).toHaveBeenCalledWith({ config: codex, logger });
    expect(runClaudeProbeMock).not.toHaveBeenCalled();
    expect(createClaudeCodeRuntimeMock).not.toHaveBeenCalled();
    expect(selected.agent).toBe(codexRuntime);
    expect(selected.defaultSessionConfig).toEqual({
      workingDir: '/codex',
      timeoutMs: 1_800_000,
    });
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
