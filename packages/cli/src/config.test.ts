import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
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

  it('loadConfig 缺 config.json → ConfigError，hint 含 path', async () => {
    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError);
    await expect(loadConfig()).rejects.toThrow(/config\.json/);
  });

  it('loadConfig 缺 discord.botUserId → ConfigError', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({ claudeCode: { workingDir: '/x' } }),
    );
    await expect(loadConfig()).rejects.toThrow(/botUserId/);
  });

  it('loadConfig 缺 claudeCode.workingDir → ConfigError', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({ discord: { botUserId: '12345' } }),
    );
    await expect(loadConfig()).rejects.toThrow(/workingDir/);
  });

  it('loadConfig 默认值兜底（bin / allowedTools / log.level）：Bash 默认禁用', async () => {
    // spec/security/tool-boundary.md：Bash 必须默认禁用，启用须显式列入 allowedTools。
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({
        discord: { botUserId: '12345' },
        claudeCode: { workingDir: '/x' },
      }),
    );
    const cfg = await loadConfig();
    expect(cfg.claudeCode.bin).toBe('claude');
    expect(cfg.claudeCode.allowedTools).not.toContain('Bash');
    // spec 默认集 Read/Grep/Glob/Edit/Write
    expect(cfg.claudeCode.allowedTools).toEqual(
      expect.arrayContaining(['Read', 'Grep', 'Glob', 'Edit', 'Write']),
    );
    expect(cfg.log.level).toBe('info');
  });

  it('loadConfig 用户显式列出 Bash → 保留（启用走 cli warn 路径）', async () => {
    await writeFile(
      join(tmp, '.agent-nexus', 'config.json'),
      JSON.stringify({
        discord: { botUserId: '12345' },
        claudeCode: { workingDir: '/x', allowedTools: ['Read', 'Bash'] },
      }),
    );
    const cfg = await loadConfig();
    expect(cfg.claudeCode.allowedTools).toEqual(['Read', 'Bash']);
  });

  it('loadDiscordToken 缺 token 文件 → SecretsPermissionError', async () => {
    await expect(loadDiscordToken()).rejects.toBeInstanceOf(
      SecretsPermissionError,
    );
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
