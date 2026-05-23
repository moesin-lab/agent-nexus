import { execa } from 'execa';
import type { Logger } from '@agent-nexus/daemon';
import type { CodexConfig } from './config.js';

export class CodexCompatibilityProbeError extends Error {
  override readonly name = 'CodexCompatibilityProbeError';
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

export interface CodexCompatibilityProbeOptions {
  config: CodexConfig;
  logger: Logger;
}

function addGlobalArgs(args: string[], config: CodexConfig): void {
  args.push('--sandbox', config.sandbox);
  args.push('--ask-for-approval', 'never');
  args.push('--cd', config.workingDir);
  for (const dir of config.addDirs) {
    args.push('--add-dir', dir);
  }
  if (config.model) {
    args.push('--model', config.model);
  }
}

function addExecArgs(args: string[], config: CodexConfig): void {
  args.push('--json', '--skip-git-repo-check');
  if (!config.loadUserConfig) {
    args.push('--ignore-user-config');
  }
  if (!config.loadRules) {
    args.push('--ignore-rules');
  }
}

export function buildCodexExecArgs(config: CodexConfig, prompt: string): string[] {
  const args: string[] = [];
  addGlobalArgs(args, config);
  args.push('exec');
  addExecArgs(args, config);
  args.push(prompt);
  return args;
}

export function buildCodexResumeArgs(
  config: CodexConfig,
  threadId: string,
  prompt: string,
): string[] {
  const args: string[] = [];
  addGlobalArgs(args, config);
  args.push('exec', 'resume');
  addExecArgs(args, config);
  args.push(threadId, prompt);
  return args;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasHelpToken(help: string, token: string): boolean {
  const escaped = escapeRegExp(token);
  return new RegExp(`(^|\\s)${escaped}(?=$|[\\s,;:=<>{}\\[\\]()]|\\|)`).test(help);
}

function requireHelpToken(help: string, token: string): void {
  if (!hasHelpToken(help, token)) {
    throw new Error(`missing ${token} in codex help`);
  }
}

function requireOneHelpToken(help: string, tokens: string[], label: string): void {
  if (!tokens.some((token) => hasHelpToken(help, token))) {
    throw new Error(`missing ${label} in codex help`);
  }
}

export async function runCompatibilityProbe(
  opts: CodexCompatibilityProbeOptions,
): Promise<void> {
  const { config, logger } = opts;
  try {
    // P3 only gates the static CLI surface. P4 must add behavioral exec/resume probes.
    const version = await execa(config.bin, ['--version']);
    const versionText = (version.stdout ?? '').toString().trim();
    if (!versionText) {
      throw new Error('empty stdout from --version');
    }
    logger.info({ version: versionText }, 'codex_cli_version');

    const topHelp = await execa(config.bin, ['--help']);
    const execHelp = await execa(config.bin, ['exec', '--help']);
    const combinedHelp = `${topHelp.stdout}\n${execHelp.stdout}`;
    for (const flag of [
      'exec',
      'resume',
      '--json',
      '--sandbox',
      '--ask-for-approval',
      '--cd',
      '--add-dir',
      '--ignore-user-config',
      '--ignore-rules',
    ]) {
      requireHelpToken(combinedHelp, flag);
    }
    if (config.model) {
      requireOneHelpToken(combinedHelp, ['--model', '-m'], '--model/-m');
    }
  } catch (err) {
    throw new CodexCompatibilityProbeError(
      `codex compatibility probe failed: ${(err as Error).message}`,
      err,
    );
  }
}
