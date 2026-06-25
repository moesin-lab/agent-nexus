import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: vi.fn(() => actual.tmpdir()) };
});

import { homedir } from 'node:os';
import {
  AGENT_NEXUS_HOME_ENV,
  applyConfigHomeArgv,
  ConfigError,
  SecretsPermissionError,
  configRoot,
  loadConfig,
  loadDiscordToken,
  loadSecret,
} from './config.js';

const VALID_AUTH = {
  allowlist: {
    userIds: ['U1'],
    allowedGuildIds: ['G1'],
  },
};

const VALID_PLATFORM = {
  name: 'discord-main',
  type: 'discord',
  botUserId: '12345',
  tokenRef: 'DISCORD_BOT_TOKEN',
  auth: VALID_AUTH,
};

const VALID_BINDING = {
  name: 'discord-main-codex-dev',
  platformName: 'discord-main',
  agentName: 'codex-dev',
  match: { discord: { channelIds: ['C1'] } },
};

const VALID_CODEX_AGENT = {
  name: 'codex-dev',
  backend: 'codex',
  codex: {
    workingDir: '/codex',
    sandbox: 'workspace-write',
    addDirs: ['/extra'],
    loadUserConfig: true,
    loadRules: true,
  },
};

const VALID_CLAUDE_AGENT = {
  name: 'claude-prod',
  backend: 'claudecode',
  claudeCode: {
    workingDir: '/claude',
    allowedTools: ['Read', 'Bash'],
    permissionLevel: 'default',
  },
};

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platforms: [VALID_PLATFORM],
    agents: [VALID_CODEX_AGENT, VALID_CLAUDE_AGENT],
    bindings: [VALID_BINDING],
    ...overrides,
  };
}

describe('config loader', () => {
  let tmp: string;
  let previousAgentNexusHome: string | undefined;

  beforeEach(async () => {
    previousAgentNexusHome = process.env[AGENT_NEXUS_HOME_ENV];
    delete process.env[AGENT_NEXUS_HOME_ENV];
    tmp = await mkdtemp(join(tmpdir(), 'agent-nexus-cfg-'));
    vi.mocked(homedir).mockReturnValue(tmp);
    await mkdir(join(tmp, '.agent-nexus', 'secrets'), { recursive: true });
  });

  afterEach(async () => {
    if (previousAgentNexusHome === undefined) {
      delete process.env[AGENT_NEXUS_HOME_ENV];
    } else {
      process.env[AGENT_NEXUS_HOME_ENV] = previousAgentNexusHome;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('loadConfig 首次运行自动创建新结构 config 模板和 tokenRef 对应 secret 文件', async () => {
    await rm(join(tmp, '.agent-nexus'), { recursive: true, force: true });

    await expect(loadConfig()).rejects.toThrow(ConfigError);
    await expect(loadConfig()).rejects.toThrow(/config\.json|workingDir/);

    const root = await stat(join(tmp, '.agent-nexus'));
    const secrets = await stat(join(tmp, '.agent-nexus', 'secrets'));
    const config = await stat(join(tmp, '.agent-nexus', 'config.json'));
    const token = await stat(
      join(tmp, '.agent-nexus', 'secrets', 'DISCORD_BOT_TOKEN'),
    );
    const configText = await readFile(join(tmp, '.agent-nexus', 'config.json'), 'utf8');

    expect(root.isDirectory()).toBe(true);
    expect(secrets.isDirectory()).toBe(true);
    expect(root.mode & 0o777).toBe(0o700);
    expect(secrets.mode & 0o777).toBe(0o700);
    expect(config.mode & 0o777).toBe(0o600);
    expect(token.mode & 0o777).toBe(0o600);
    expect(configText).toMatch(/"platforms"/);
    expect(configText).toMatch(/"agents"/);
    expect(configText).toMatch(/"tokenRef": "DISCORD_BOT_TOKEN"/);
    expect(configText).toMatch(/"bindings"/);
    expect(configText).toMatch(/"platformName": "discord-main"/);
    expect(configText).toMatch(/"match"/);
    expect(configText).toMatch(/"channelIds"/);
    expect(configText).toMatch(/"auth"/);
    expect(configText).toMatch(/"allowlist"/);
    expect(configText).toMatch(/"daemon"/);
    expect(configText).toMatch(/"commandRegistry"/);
    expect(configText).toMatch(/"applyTimeoutMs": 30000/);
    expect(configText).toMatch(/"trajectory"/);
    expect(configText).toMatch(/"externalImport"/);
    expect(configText).toMatch(/"providerCapture"/);
    expect(configText).not.toMatch(/"agent"\s*:/);
    expect(
      Object.prototype.hasOwnProperty.call(JSON.parse(configText), 'discord'),
    ).toBe(false);
  });

  it('AGENT_NEXUS_HOME 会作为 config / secrets / state 的实例根目录', async () => {
    const root = join(tmp, 'agent-nexus-dev-root');
    process.env[AGENT_NEXUS_HOME_ENV] = root;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'config.json'), JSON.stringify(validConfig()));

    const cfg = await loadConfig();

    expect(configRoot()).toBe(root);
    expect(cfg.platforms[0].statePath).toBe(
      join(root, 'state', 'discord-discord-main.json'),
    );

    await writeFile(join(root, 'secrets', 'DISCORD_BOT_TOKEN'), 'token-dev');
    await chmod(join(root, 'secrets', 'DISCORD_BOT_TOKEN'), 0o600);
    await expect(loadSecret('DISCORD_BOT_TOKEN')).resolves.toBe('token-dev');
  });

  it('applyConfigHomeArgv 解析 --home 并写入 AGENT_NEXUS_HOME', () => {
    const root = join(tmp, 'agent-nexus-flag-root');

    applyConfigHomeArgv(['--home', root]);

    expect(process.env[AGENT_NEXUS_HOME_ENV]).toBe(root);
    expect(configRoot()).toBe(root);
  });

  it('applyConfigHomeArgv 解析 --home=value 并展开 ~', () => {
    applyConfigHomeArgv(['--home=~/agent-nexus-flag-root']);

    expect(process.env[AGENT_NEXUS_HOME_ENV]).toBe(
      join(tmp, 'agent-nexus-flag-root'),
    );
    expect(configRoot()).toBe(join(tmp, 'agent-nexus-flag-root'));
  });

  it('AGENT_NEXUS_HOME 支持 ~ 展开，且 --home 优先级更高', () => {
    const flagRoot = join(tmp, 'agent-nexus-flag-priority-root');
    process.env[AGENT_NEXUS_HOME_ENV] = '~/agent-nexus-env-root';

    expect(configRoot()).toBe(join(tmp, 'agent-nexus-env-root'));

    applyConfigHomeArgv(['--home', flagRoot]);

    expect(process.env[AGENT_NEXUS_HOME_ENV]).toBe(flagRoot);
    expect(configRoot()).toBe(flagRoot);
  });

  it('applyConfigHomeArgv 跳过未知参数并继续解析 --home', () => {
    const root = join(tmp, 'agent-nexus-unknown-args-root');

    expect(() =>
      applyConfigHomeArgv(['--version', '--log-level', 'debug', '--home', root]),
    ).not.toThrow();

    expect(process.env[AGENT_NEXUS_HOME_ENV]).toBe(root);
  });

  it('applyConfigHomeArgv 遇到 -- 后不再预解析 --home', () => {
    const root = join(tmp, 'agent-nexus-passthrough-root');

    applyConfigHomeArgv(['--', '--home', root]);

    expect(process.env[AGENT_NEXUS_HOME_ENV]).toBeUndefined();
    expect(configRoot()).toBe(join(tmp, '.agent-nexus'));
  });

  it('applyConfigHomeArgv 对 --home 缺值或重复指定 fail-closed', () => {
    const root = join(tmp, 'agent-nexus-duplicate-root');

    expect(() => applyConfigHomeArgv(['--home'])).toThrow(/--home.*路径/);
    expect(() => applyConfigHomeArgv(['--home', '--version'])).toThrow(
      /--home.*路径/,
    );
    expect(() => applyConfigHomeArgv(['--home', '-relative'])).toThrow(
      /--home.*路径/,
    );
    expect(() => applyConfigHomeArgv(['--home', root, '--home=/other'])).toThrow(
      /--home.*只能指定一次/,
    );
    expect(() => applyConfigHomeArgv(['--home=/first', '--home'])).toThrow(
      /--home.*只能指定一次/,
    );
  });

  it('AGENT_NEXUS_HOME 和 --home 空白路径都 fail-closed', () => {
    process.env[AGENT_NEXUS_HOME_ENV] = '   ';

    expect(() => configRoot()).toThrow(ConfigError);
    expect(() => configRoot()).toThrow(/不能是空路径/);
    expect(() => applyConfigHomeArgv(['--home=   '])).toThrow(ConfigError);
    expect(() => applyConfigHomeArgv(['--home=   '])).toThrow(/不能是空路径/);
    expect(() => applyConfigHomeArgv(['--home', '   '])).toThrow(ConfigError);
    expect(() => applyConfigHomeArgv(['--home', '   '])).toThrow(/不能是空路径/);
    expect(() => applyConfigHomeArgv(['--home='])).toThrow(ConfigError);
    expect(() => applyConfigHomeArgv(['--home='])).toThrow(/不能是空路径/);
  });

  it('loadConfig 解析 platforms[] / agents[] / bindings[] 新结构并应用 owner parser 默认值', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(validConfig({ ui: { toolMessages: 'compact' }, log: { level: 'debug' } })),
    );

    const cfg = await loadConfig();

    expect(cfg.platforms).toHaveLength(1);
    expect(cfg.platforms[0]).toMatchObject({
      name: 'discord-main',
      type: 'discord',
      tokenRef: 'DISCORD_BOT_TOKEN',
      botUserId: '12345',
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
    });
    expect(cfg.platforms[0].statePath).toBe(
      join(tmp, '.agent-nexus', 'state', 'discord-discord-main.json'),
    );
    expect(cfg.agents).toHaveLength(2);
    expect(cfg.agents[0]).toMatchObject({
      name: 'codex-dev',
      backend: 'codex',
      codex: { bin: 'codex', workingDir: '/codex' },
    });
    expect(cfg.agents[1]).toMatchObject({
      name: 'claude-prod',
      backend: 'claudecode',
      claudeCode: { bin: 'claude', workingDir: '/claude' },
    });
    expect(cfg.bindings).toEqual([
      {
        name: 'discord-main-codex-dev',
        platformName: 'discord-main',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ]);
    expect(cfg.ui.toolMessages).toBe('compact');
    expect(cfg.daemon.commandRegistry.registration.enabled).toBe(true);
    expect(cfg.daemon.commandRegistry.registration.applyTimeoutMs).toBe(30000);
    expect(cfg.daemon.commandRegistry.aliases.singleAgent.enabled).toBe(true);
    expect(cfg.daemon.commandRegistry.aliases.legacy.replyMode).toBe(true);
    expect(cfg.daemon.commandRegistry.textPrefixes.newSession).toBe(true);
    expect(cfg.log.level).toBe('debug');
  });

  it('loadConfig 会把缺失的 daemon.commandRegistry 默认配置补回 config.json', async () => {
    const path = join(tmp, '.agent-nexus', 'config.json');
    await writeFile(path, JSON.stringify(validConfig()));

    const cfg = await loadConfig();
    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

    expect(cfg.daemon.commandRegistry.registration.applyTimeoutMs).toBe(30000);
    expect(cfg.daemon.trajectory.enabled).toBe(true);
    expect(cfg.daemon.trajectory.externalImport.enabled).toBe(false);
    expect(cfg.daemon.trajectory.providerCapture.enabled).toBe(false);
    expect(persisted).toMatchObject({
      daemon: {
        commandRegistry: {
          registration: {
            enabled: true,
            applyTimeoutMs: 30000,
            retry: {
              maxAttempts: 3,
              backoffMs: 1000,
            },
          },
          aliases: {
            singleAgent: { enabled: true },
            legacy: { replyMode: true },
          },
          textPrefixes: { newSession: true },
        },
        trajectory: {
          enabled: true,
          externalImport: {
            enabled: false,
            sources: [],
            metadataOnlyDiscovery: true,
            importContent: false,
          },
          providerCapture: {
            enabled: false,
            mode: 'transcript-only',
          },
        },
      },
    });
  });

  it('loadConfig 解析显式 daemon.trajectory 配置', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          daemon: {
            trajectory: {
              enabled: false,
              externalImport: {
                enabled: true,
                sources: [
                  {
                    adapter: 'claude-code-jsonl',
                    root: '/workspace/project/.claude',
                  },
                ],
              },
              providerCapture: {
                enabled: true,
                mode: 'forward-proxy',
                port: 7005,
              },
            },
          },
        }),
      ),
    );

    const cfg = await loadConfig();

    expect(cfg.daemon.trajectory).toMatchObject({
      enabled: false,
      externalImport: {
        enabled: true,
        sources: [
          {
            adapter: 'claude-code-jsonl',
            root: '/workspace/project/.claude',
            projectPathAllowlist: [],
          },
        ],
        importContent: false,
      },
      providerCapture: {
        enabled: true,
        mode: 'forward-proxy',
        bindHost: '127.0.0.1',
        port: 7005,
      },
    });
  });

  it('loadConfig 解析显式 daemon.commandRegistry 配置', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          daemon: {
            commandRegistry: {
              registration: {
                enabled: false,
                applyTimeoutMs: 5000,
                retry: { maxAttempts: 2, backoffMs: 10 },
              },
              aliases: {
                singleAgent: { enabled: false },
                legacy: { replyMode: false },
              },
              textPrefixes: { newSession: false },
            },
          },
        }),
      ),
    );

    const cfg = await loadConfig();

    expect(cfg.daemon.commandRegistry).toEqual({
      registration: {
        enabled: false,
        applyTimeoutMs: 5000,
        retry: { maxAttempts: 2, backoffMs: 10 },
      },
      aliases: {
        singleAgent: { enabled: false },
        legacy: { replyMode: false },
      },
      textPrefixes: { newSession: false },
    });
  });

  it('legacy 顶层字段被清晰拒绝，不做自动迁移', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({
        agent: { backend: 'codex' },
        discord: { botUserId: '12345', allowedUserIds: ['U1'] },
        codex: { workingDir: '/codex' },
      }),
    );

    await expect(loadConfig()).rejects.toThrow(/legacy|platforms\[\]|agents\[\]/);
  });

  it('platforms[] / agents[] 缺失或空数组 → ConfigError（含字段路径）', async () => {
    await writeFile(join(tmp, '.agent-nexus', 'config.json'), JSON.stringify({ agents: [] }));
    await expect(loadConfig()).rejects.toThrow(/platforms/);

    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({ platforms: [VALID_PLATFORM], agents: [] }),
    );
    await expect(loadConfig()).rejects.toThrow(/agents/);

    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({ platforms: [VALID_PLATFORM], agents: [VALID_CODEX_AGENT], bindings: [] }),
    );
    await expect(loadConfig()).rejects.toThrow(/bindings/);
  });

  it('重复 platform name / agent name → ConfigError（列出重复 name）', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          platforms: [VALID_PLATFORM, { ...VALID_PLATFORM, botUserId: '67890' }],
        }),
      ),
    );
    await expect(loadConfig()).rejects.toThrow(/platforms\[\]\.name.*discord-main/);

    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          agents: [VALID_CODEX_AGENT, { ...VALID_CLAUDE_AGENT, name: 'codex-dev' }],
        }),
      ),
    );
    await expect(loadConfig()).rejects.toThrow(/agents\[\]\.name.*codex-dev/);

    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          bindings: [VALID_BINDING, { ...VALID_BINDING, agentName: 'claude-prod' }],
        }),
      ),
    );
    await expect(loadConfig()).rejects.toThrow(/bindings\[\]\.name.*discord-main-codex-dev/);
  });

  it('允许多个同 type platform 实例，并按 platform name 派生独立 statePath', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          platforms: [
            VALID_PLATFORM,
            { ...VALID_PLATFORM, name: 'discord-alt', botUserId: '67890' },
          ],
        }),
      ),
    );

    const cfg = await loadConfig();
    expect(cfg.platforms).toHaveLength(2);
    expect(cfg.platforms.map((platform) => platform.statePath)).toEqual([
      join(tmp, '.agent-nexus', 'state', 'discord-discord-main.json'),
      join(tmp, '.agent-nexus', 'state', 'discord-discord-alt.json'),
    ]);
  });

  it('多个 platform 实例显式复用同一 statePath 时 fail-closed', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          platforms: [
            { ...VALID_PLATFORM, statePath: '/shared/state.json' },
            {
              ...VALID_PLATFORM,
              name: 'discord-alt',
              botUserId: '67890',
              statePath: '/shared/state.json',
            },
          ],
        }),
      ),
    );

    await expect(loadConfig()).rejects.toThrow(/platforms\[\]\.statePath.*重复/);
  });

  it('未知 platform type / backend → ConfigError', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          platforms: [{ ...VALID_PLATFORM, type: 'slack' }],
        }),
      ),
    );
    await expect(loadConfig()).rejects.toThrow(/platforms\[0\]\.type/);

    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          agents: [{ ...VALID_CODEX_AGENT, backend: 'other' }],
        }),
      ),
    );
    await expect(loadConfig()).rejects.toThrow(/agents\[0\]\.backend/);
  });

  it('未知顶层字段和 agent 顶层字段 fail-closed', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(validConfig({ routes: [] })),
    );
    await expect(loadConfig()).rejects.toThrow(/config\.json\.routes/);

    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          agents: [{ ...VALID_CODEX_AGENT, default: true }],
        }),
      ),
    );
    await expect(loadConfig()).rejects.toThrow(/agents\[0\]\.default/);
  });

  it('binding 引用不存在 platform / agent → ConfigError（含 binding 字段路径）', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          bindings: [{ ...VALID_BINDING, platformName: 'missing-platform' }],
        }),
      ),
    );
    await expect(loadConfig()).rejects.toThrow(/bindings\[0\]\.platformName/);

    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          bindings: [{ ...VALID_BINDING, agentName: 'missing-agent' }],
        }),
      ),
    );
    await expect(loadConfig()).rejects.toThrow(/bindings\[0\]\.agentName/);
  });

  it('platform auth 和 Discord binding owner parser 错误经 ConfigError 包装并保留字段路径', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          platforms: [
            {
              ...VALID_PLATFORM,
              auth: { allowlist: { userIds: [], allowedGuildIds: [] } },
            },
          ],
        }),
      ),
    );
    await expect(loadConfig()).rejects.toThrow(
      /platforms\[0\]\.auth\.allowlist.*至少/,
    );

    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          bindings: [
            {
              ...VALID_BINDING,
              match: { discord: { channelIds: [] } },
            },
          ],
        }),
      ),
    );
    await expect(loadConfig()).rejects.toThrow(
      /bindings\[0\]\.match\.discord\.channelIds/,
    );

    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          platforms: [{ ...VALID_PLATFORM, bindings: [{ agentName: 'codex-dev' }] }],
        }),
      ),
    );
    await expect(loadConfig()).rejects.toThrow(
      /platforms\[0\]\.bindings.*顶层 bindings\[\]/,
    );
  });

  it('tokenRef 非 secret ref 名称 → ConfigError（parse 期覆盖所有 platform）', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          platforms: [{ ...VALID_PLATFORM, tokenRef: '../DISCORD_BOT_TOKEN' }],
        }),
      ),
    );

    await expect(loadConfig()).rejects.toThrow(/platforms\[0\]\.tokenRef/);
  });

  it('agent backend 私有字段缺失或 inactive backend 块存在 → ConfigError', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(validConfig({ agents: [{ name: 'codex-dev', backend: 'codex' }] })),
    );
    await expect(loadConfig()).rejects.toThrow(/agents\[0\]\.codex/);

    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify(
        validConfig({
          agents: [
            {
              ...VALID_CODEX_AGENT,
              claudeCode: { workingDir: '/stale' },
            },
          ],
        }),
      ),
    );
    await expect(loadConfig()).rejects.toThrow(/agents\[0\]\.claudeCode/);
  });

  it('loadSecret 按 tokenRef 读取 ~/.agent-nexus/secrets/<name>，权限和值都 fail-closed', async () => {
    await expect(loadSecret('DISCORD_BOT_TOKEN')).rejects.toBeInstanceOf(
      SecretsPermissionError,
    );

    const path = join(tmp, '.agent-nexus', 'secrets', 'DISCORD_BOT_TOKEN');
    await writeFile(path, '  token-abc\n');
    await chmod(path, 0o644);
    await expect(loadSecret('DISCORD_BOT_TOKEN')).rejects.toThrow(/0600/);

    await chmod(path, 0o600);
    await expect(loadSecret('DISCORD_BOT_TOKEN')).resolves.toBe('token-abc');
    await expect(loadDiscordToken()).resolves.toBe('token-abc');
  });
});
