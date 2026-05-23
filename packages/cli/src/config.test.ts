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
  ConfigError,
  SecretsPermissionError,
  loadConfig,
  loadDiscordToken,
} from './config.js';

// 最小合法 discord 段——allowedUserIds 必填，下游测试统一用同一个 fixture。
const VALID_DISCORD = {
  botUserId: '12345',
  allowedUserIds: ['U1'],
};

describe('config loader', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'agent-nexus-cfg-'));
    vi.mocked(homedir).mockReturnValue(tmp);
    await mkdir(join(tmp, '.agent-nexus', 'secrets'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('loadConfig 首次运行自动创建 config 模板和 token 文件', async () => {
    await rm(join(tmp, '.agent-nexus'), { recursive: true, force: true });

    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError);
    await expect(loadConfig()).rejects.toThrow(/config\.json/);

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
    expect(configText).toMatch(/allowedUserIds/);
    expect(configText).toMatch(/workingDir/);
    expect(configText).toMatch(/permissionLevel/);
    expect(configText).toMatch(/_permissionLevelComment/);
    expect(configText).toMatch(/_levelComment/);
  });

  it('loadConfig 缺 discord.botUserId → ConfigError（含字段名）', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({ claudeCode: { workingDir: '/x' } }),
    );
    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError);
    await expect(loadConfig()).rejects.toThrow(/botUserId/);
  });

  it('loadConfig 缺 claudeCode.workingDir → ConfigError（含字段名）', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({ discord: VALID_DISCORD }),
    );
    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError);
    await expect(loadConfig()).rejects.toThrow(/workingDir/);
  });

  it('loadConfig 默认值兜底（bin / allowedTools / log.level）：Bash 默认禁用', async () => {
    // spec/security/tool-boundary.md：Bash 必须默认禁用，启用须显式列入 allowedTools。
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({
        discord: VALID_DISCORD,
        claudeCode: { workingDir: '/x' },
      }),
    );
    const cfg = await loadConfig();
    expect(cfg.claudeCode.bin).toBe('claude');
    expect(cfg.claudeCode.permissionLevel).toBe('default');
    expect(cfg.claudeCode.allowedTools).not.toContain('Bash');
    // spec 默认集 Read/Grep/Glob/Edit/Write
    expect(cfg.claudeCode.allowedTools).toEqual(
      expect.arrayContaining(['Read', 'Grep', 'Glob', 'Edit', 'Write']),
    );
    expect(cfg.log.level).toBe('info');
  });

  it('loadConfig 自动补齐缺失的默认字段到 config 文件', async () => {
    const path = join(tmp, '.agent-nexus', 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        discord: VALID_DISCORD,
        claudeCode: { workingDir: '/x' },
      }),
    );

    const cfg = await loadConfig();
    const normalized = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;

    expect(cfg.claudeCode.bin).toBe('claude');
    expect(normalized).toMatchObject({
      claudeCode: {
        workingDir: '/x',
        bin: 'claude',
        _permissionLevelComment:
          'allowed: default, acceptEdits, auto, bypassPermissions, dontAsk, plan',
        permissionLevel: 'default',
        allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
      },
      log: {
        _levelComment: 'allowed: trace, debug, info, warn, error, fatal',
        level: 'info',
      },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('loadConfig 校验失败前也会补齐缺失的占位字段', async () => {
    const path = join(tmp, '.agent-nexus', 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        claudeCode: { workingDir: '/x' },
      }),
    );

    await expect(loadConfig()).rejects.toThrow(/botUserId/);
    const normalized = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(normalized).toMatchObject({
      discord: {
        botUserId: '',
        allowedUserIds: [],
      },
      claudeCode: {
        workingDir: '/x',
        bin: 'claude',
        _permissionLevelComment:
          'allowed: default, acceptEdits, auto, bypassPermissions, dontAsk, plan',
        permissionLevel: 'default',
        allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
      },
      log: {
        _levelComment: 'allowed: trace, debug, info, warn, error, fatal',
        level: 'info',
      },
    });
  });

  it.each([
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'default',
    'dontAsk',
    'plan',
  ] as const)('loadConfig 用户显式 permissionLevel=%s → 保留', async (permissionLevel) => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({
        discord: VALID_DISCORD,
        claudeCode: { workingDir: '/x', permissionLevel },
      }),
    );
    const cfg = await loadConfig();
    expect(cfg.claudeCode.permissionLevel).toBe(permissionLevel);
  });

  it('loadConfig 用户显式列出 Bash → 保留', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({
        discord: VALID_DISCORD,
        claudeCode: { workingDir: '/x', allowedTools: ['Read', 'Bash'] },
      }),
    );
    const cfg = await loadConfig();
    expect(cfg.claudeCode.allowedTools).toEqual(['Read', 'Bash']);
  });

  it('loadConfig 缺 discord.allowedUserIds → ConfigError（fail-closed）', async () => {
    // PR #50 把 discord 解析下沉到 platform-discord，但 allowedUserIds 必填判定
    // 仍属 cli loader 路由层的可观察契约（错误经包装回 ConfigError 抛出）。
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({
        discord: { botUserId: '12345' },
        claudeCode: { workingDir: '/x' },
      }),
    );
    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError);
    await expect(loadConfig()).rejects.toThrow(/allowedUserIds/);
  });

  it('loadConfig discord.statePath 缺省 → 路由传递默认 ~/.agent-nexus/state/discord.json', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({
        discord: VALID_DISCORD,
        claudeCode: { workingDir: '/x' },
      }),
    );
    const cfg = await loadConfig();
    expect(cfg.discord.statePath).toBe(
      join(tmp, '.agent-nexus', 'state', 'discord.json'),
    );
  });

  it('loadDiscordToken 缺 token 文件 → SecretsPermissionError', async () => {
    await expect(loadDiscordToken()).rejects.toBeInstanceOf(
      SecretsPermissionError,
    );
    const token = await stat(
      join(tmp, '.agent-nexus', 'secrets', 'DISCORD_BOT_TOKEN'),
    );
    expect(token.mode & 0o777).toBe(0o600);
  });

  it('loadDiscordToken 权限非 0600 → SecretsPermissionError', async () => {
    const path = join(tmp, '.agent-nexus', 'secrets', 'DISCORD_BOT_TOKEN');
    await writeFile(path, 'token-abc');
    await chmod(path, 0o644);
    await expect(loadDiscordToken()).rejects.toThrow(/0600/);
  });

  it('loadDiscordToken 0600 + 非空 → 返回 trim 后的 token', async () => {
    const path = join(tmp, '.agent-nexus', 'secrets', 'DISCORD_BOT_TOKEN');
    await writeFile(path, '  token-abc\n');
    await chmod(path, 0o600);
    const t = await loadDiscordToken();
    expect(t).toBe('token-abc');
  });
});
