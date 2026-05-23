import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentRuntime } from '@agent-nexus/protocol';
import type { Logger } from '@agent-nexus/daemon';
import type { AgentNexusConfig } from './config.js';

const claudeRuntime = { name: () => 'claudecode' } as AgentRuntime;
const codexRuntime = { name: () => 'codex' } as AgentRuntime;

const createClaudeCodeRuntimeMock = vi.hoisted(() => vi.fn(() => claudeRuntime));
const runClaudeProbeMock = vi.hoisted(() => vi.fn(async () => {}));
const createCodexRuntimeMock = vi.hoisted(() => vi.fn(() => codexRuntime));
const runCodexProbeMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@agent-nexus/agent-claudecode', () => ({
  createClaudeCodeRuntime: createClaudeCodeRuntimeMock,
  runCompatibilityProbe: runClaudeProbeMock,
}));

vi.mock('@agent-nexus/agent-codex', () => ({
  createCodexRuntime: createCodexRuntimeMock,
  runCompatibilityProbe: runCodexProbeMock,
}));

import { createSelectedAgent } from './agent.js';

const logger = {
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function baseConfig(): Omit<AgentNexusConfig, 'agent' | 'claudeCode' | 'codex'> {
  return {
    discord: {
      botUserId: 'bot',
      allowedUserIds: ['U1'],
      statePath: '/state/discord.json',
    },
    ui: { toolMessages: 'append' },
    log: { level: 'info' },
  };
}

describe('createSelectedAgent', () => {
  beforeEach(() => {
    createClaudeCodeRuntimeMock.mockClear();
    runClaudeProbeMock.mockClear();
    createCodexRuntimeMock.mockClear();
    runCodexProbeMock.mockClear();
    vi.mocked(logger.warn).mockClear();
  });

  it('claudecode backend 跑 Claude probe 并注入 Claude runtime，保持默认 session config', async () => {
    const selected = await createSelectedAgent(
      {
        ...baseConfig(),
        agent: { backend: 'claudecode' },
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
      toolWhitelist: ['Read', 'Bash'],
      timeoutMs: 300_000,
    });
  });

  it('codex backend 跑 Codex probe 并注入 Codex runtime，不把 toolWhitelist 翻译成 Codex allowlist', async () => {
    const codex = {
      bin: 'codex',
      workingDir: '/codex',
      sandbox: 'read-only',
      addDirs: [],
      loadUserConfig: false,
      loadRules: false,
    } as const;

    const selected = await createSelectedAgent(
      {
        ...baseConfig(),
        agent: { backend: 'codex' },
        codex,
      },
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
      toolWhitelist: [],
      timeoutMs: 300_000,
    });
  });
});
