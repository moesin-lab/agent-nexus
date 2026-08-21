import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexAppServerConfigError,
  DEFAULT_CODEX_APP_SERVER_CONFIG,
  parseCodexAppServerConfig,
} from './config.js';

const created: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-nexus-codex-app-server-config-'));
  created.push(dir);
  return realpathSync(dir);
}

afterEach(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.length = 0;
});

describe('parseCodexAppServerConfig', () => {
  it('should_apply_fail_closed_defaults_when_only_working_dir_is_set', () => {
    const workingDir = workspace();

    expect(parseCodexAppServerConfig({ workingDir })).toEqual({
      ...DEFAULT_CODEX_APP_SERVER_CONFIG,
      workingDir,
    });
  });

  it('should_not_share_mutable_viewer_defaults_between_parsed_configs', () => {
    const first = parseCodexAppServerConfig({ workingDir: workspace() });
    first.supplementalViewer.enabled = true;

    const second = parseCodexAppServerConfig({ workingDir: workspace() });

    expect(second.supplementalViewer).toEqual({ enabled: false });
    expect(DEFAULT_CODEX_APP_SERVER_CONFIG.supplementalViewer).toEqual({ enabled: false });
  });

  it('should_canonicalize_and_deduplicate_add_dirs_when_paths_are_valid', () => {
    const workingDir = workspace();
    const addDir = workspace();

    expect(
      parseCodexAppServerConfig({
        workingDir,
        sandbox: 'workspace-write',
        addDirs: [addDir],
        maxInputBytes: 1024,
        requestTimeoutMs: 1234,
        interruptGraceMs: 2345,
        terminateGraceMs: 3456,
        conversationRetentionMs: 60_000,
        supplementalViewer: { enabled: true },
      }),
    ).toEqual({
      bin: 'codex',
      workingDir,
      sandbox: 'workspace-write',
      addDirs: [addDir],
      maxInputBytes: 1024,
      requestTimeoutMs: 1234,
      interruptGraceMs: 2345,
      terminateGraceMs: 3456,
      conversationRetentionMs: 60_000,
      supplementalViewer: { enabled: true },
    });
  });

  it('should_reject_unknown_or_forbidden_fields_instead_of_ignoring_them', () => {
    const workingDir = workspace();

    expect(() =>
      parseCodexAppServerConfig({ workingDir, approvalPolicy: 'never' }),
    ).toThrow(CodexAppServerConfigError);
    expect(() =>
      parseCodexAppServerConfig({ workingDir, experimentalApi: true }),
    ).toThrow(CodexAppServerConfigError);
    expect(() =>
      parseCodexAppServerConfig({ workingDir, typoField: true }),
    ).toThrow(/typoField/);
    expect(() =>
      parseCodexAppServerConfig({
        workingDir,
        supplementalViewer: { enabled: true, endpoint: 'ws://127.0.0.1:1234' },
      }),
    ).toThrow(/supplementalViewer/);
    expect(() =>
      parseCodexAppServerConfig({ workingDir, supplementalViewer: { enabled: 'yes' } }),
    ).toThrow(CodexAppServerConfigError);
  });

  it('should_reject_missing_non_absolute_or_non_directory_working_dir', () => {
    expect(() => parseCodexAppServerConfig({})).toThrow(/workingDir/);
    expect(() => parseCodexAppServerConfig({ workingDir: 'relative' })).toThrow(
      /absolute|绝对/,
    );
    expect(() =>
      parseCodexAppServerConfig({ workingDir: join(workspace(), 'missing') }),
    ).toThrow(CodexAppServerConfigError);
  });

  it('should_reject_duplicate_add_dirs_after_canonicalization', () => {
    const workingDir = workspace();
    const addDir = workspace();

    expect(() =>
      parseCodexAppServerConfig({ workingDir, addDirs: [addDir, addDir] }),
    ).toThrow(/duplicate|重复/);
  });

  it.each([
    ['maxInputBytes', 0],
    ['maxInputBytes', 1_048_577],
    ['requestTimeoutMs', 300_001],
    ['interruptGraceMs', 60_001],
    ['terminateGraceMs', 0],
    ['conversationRetentionMs', 59_999],
  ])('should_reject_out_of_range_%s', (field, value) => {
    expect(() =>
      parseCodexAppServerConfig({ workingDir: workspace(), [field]: value }),
    ).toThrow(CodexAppServerConfigError);
  });
});
