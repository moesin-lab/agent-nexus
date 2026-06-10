import { describe, expect, it, vi } from 'vitest';
import { createLogger, type EngineRuntimeUpdate } from '@agent-nexus/daemon';
import { ConfigError, type AgentConfig, type AgentNexusConfig } from './config.js';
import { createConfigReloader } from './config-reload.js';

const SILENT_LOGGER = createLogger({ level: 'fatal', pretty: false });

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
    daemon: {
      commandRegistry: {
        registration: {
          enabled: true,
          applyTimeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 0 },
        },
        aliases: {
          singleAgent: { enabled: true },
          legacy: { replyMode: true },
        },
        textPrefixes: { newSession: true },
      },
    },
    ui: { toolMessages: 'append' },
    log: { level: 'info' },
    ...overrides,
  };
}

function makeTarget(platformName: string): {
  platformName: string;
  applyRuntimeUpdate: ReturnType<typeof vi.fn>;
} {
  return { platformName, applyRuntimeUpdate: vi.fn() };
}

describe('createConfigReloader', () => {
  it('load 抛 ConfigError 时返回 failed、错误进消息、不应用任何改动', async () => {
    const target = makeTarget('discord-main');
    const reload = createConfigReloader({
      initialConfig: baseConfig(),
      load: vi.fn(async () => {
        throw new ConfigError('config.json 不是合法 JSON：Unexpected token');
      }),
      targets: [target],
      runningAgentNames: ['codex-dev'],
      logger: SILENT_LOGGER,
    });

    const result = await reload();

    expect(result.status).toBe('failed');
    expect(result.message).toContain('config.json 不是合法 JSON');
    expect(result.message).toContain('previous config kept');
    expect(target.applyRuntimeUpdate).not.toHaveBeenCalled();
  });

  it('成功 reload 把新 routing table / auth / ui / textPrefixes 应用到所有 target', async () => {
    const target = makeTarget('discord-main');
    const next = baseConfig({
      bindings: [
        {
          name: 'discord-main-codex',
          platformName: 'discord-main',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C2'] } },
        },
      ],
      ui: { toolMessages: 'compact' },
    });
    next.platforms[0]!.auth.allowlist.userIds = ['U2'];
    next.daemon.commandRegistry.textPrefixes.newSession = false;

    const reload = createConfigReloader({
      initialConfig: baseConfig(),
      load: async () => next,
      targets: [target],
      runningAgentNames: ['codex-dev'],
      logger: SILENT_LOGGER,
    });

    const result = await reload();

    expect(result.status).toBe('reloaded');
    expect(result.message).not.toContain('restart required');
    expect(target.applyRuntimeUpdate).toHaveBeenCalledTimes(1);
    const update = target.applyRuntimeUpdate.mock.calls[0]![0] as EngineRuntimeUpdate;
    expect(update.routingTable).toEqual([
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C2'] } },
      },
    ]);
    expect(update.platformAuth.allowlist.userIds).toEqual(['U2']);
    expect(update.toolMessageMode).toBe('compact');
    expect(update.newSessionTextPrefix).toBe(false);
  });

  it('binding 引用未运行的 agent 时按失败处理且不应用', async () => {
    const target = makeTarget('discord-main');
    const next = baseConfig({
      agents: [codexAgent, claudeAgent],
      bindings: [
        {
          name: 'discord-main-claude',
          platformName: 'discord-main',
          agentName: 'claude-prod',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
    });

    const reload = createConfigReloader({
      initialConfig: baseConfig(),
      load: async () => next,
      targets: [target],
      runningAgentNames: ['codex-dev'],
      logger: SILENT_LOGGER,
    });

    const result = await reload();

    expect(result.status).toBe('failed');
    expect(result.message).toContain('claude-prod');
    expect(target.applyRuntimeUpdate).not.toHaveBeenCalled();
  });

  it('bindings 变更改变 platform 的 agent owner 集合时按失败处理且不应用', async () => {
    const target = makeTarget('discord-main');
    const initial = baseConfig({ agents: [codexAgent, claudeAgent] });
    const next = baseConfig({
      agents: [codexAgent, claudeAgent],
      bindings: [
        {
          name: 'discord-main-claude',
          platformName: 'discord-main',
          agentName: 'claude-prod',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
    });

    const reload = createConfigReloader({
      initialConfig: initial,
      load: async () => next,
      targets: [target],
      runningAgentNames: ['codex-dev', 'claude-prod'],
      logger: SILENT_LOGGER,
    });

    const result = await reload();

    expect(result.status).toBe('failed');
    expect(result.message).toContain('agent owner');
    expect(target.applyRuntimeUpdate).not.toHaveBeenCalled();
  });

  it('新配置缺少运行中的 platform 时按失败处理且不应用', async () => {
    const target = makeTarget('discord-main');
    const next = baseConfig();
    next.platforms[0]!.name = 'discord-side';
    next.bindings[0]!.platformName = 'discord-side';

    const reload = createConfigReloader({
      initialConfig: baseConfig(),
      load: async () => next,
      targets: [target],
      runningAgentNames: ['codex-dev'],
      logger: SILENT_LOGGER,
    });

    const result = await reload();

    expect(result.status).toBe('failed');
    expect(result.message).toContain('discord-main');
    expect(target.applyRuntimeUpdate).not.toHaveBeenCalled();
  });

  it('仅重启生效 section 变化时成功响应带重启提示', async () => {
    const target = makeTarget('discord-main');
    const next = baseConfig({
      agents: [
        {
          ...codexAgent,
          codex: { ...codexAgent.codex, workingDir: '/codex-v2' },
        } as AgentConfig,
      ],
      log: { level: 'debug' },
    });

    const reload = createConfigReloader({
      initialConfig: baseConfig(),
      load: async () => next,
      targets: [target],
      runningAgentNames: ['codex-dev'],
      logger: SILENT_LOGGER,
    });

    const result = await reload();

    expect(result.status).toBe('reloaded');
    expect(target.applyRuntimeUpdate).toHaveBeenCalledTimes(1);
    expect(result.message).toContain('restart required');
    expect(result.message).toContain('agents');
    expect(result.message).toContain('log');
  });
});
