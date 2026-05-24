import { execa } from 'execa';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
  timeoutMs?: number;
  mode?: 'startup' | 'full';
}

interface JsonlProbeFacts {
  threadId?: string;
  sawTurnStarted: boolean;
  sawAgentMessage: boolean;
  sawTurnCompletedUsage: boolean;
  sawCommandStarted: boolean;
  sawCommandCompleted: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonl(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('non-object JSONL event in codex probe');
    }
    events.push(parsed);
  }
  return events;
}

function collectFacts(stdout: string): JsonlProbeFacts {
  const facts: JsonlProbeFacts = {
    sawTurnStarted: false,
    sawAgentMessage: false,
    sawTurnCompletedUsage: false,
    sawCommandStarted: false,
    sawCommandCompleted: false,
  };
  for (const event of parseJsonl(stdout)) {
    const type = event['type'];
    if (type === 'thread.started' && typeof event['thread_id'] === 'string') {
      facts.threadId = event['thread_id'];
    } else if (type === 'turn.started') {
      facts.sawTurnStarted = true;
    } else if (type === 'turn.completed' && isRecord(event['usage'])) {
      facts.sawTurnCompletedUsage = true;
    } else if (type === 'item.started' && isRecord(event['item'])) {
      facts.sawCommandStarted =
        facts.sawCommandStarted || event['item']['type'] === 'command_execution';
    } else if (type === 'item.completed' && isRecord(event['item'])) {
      facts.sawAgentMessage =
        facts.sawAgentMessage || event['item']['type'] === 'agent_message';
      facts.sawCommandCompleted =
        facts.sawCommandCompleted || event['item']['type'] === 'command_execution';
    }
  }
  return facts;
}

function requireBaseTurnFacts(facts: JsonlProbeFacts, label: string): void {
  if (!facts.threadId) throw new Error(`missing thread.started in ${label} probe`);
  if (!facts.sawTurnStarted) throw new Error(`missing turn.started in ${label} probe`);
  if (!facts.sawAgentMessage) {
    throw new Error(`missing agent_message in ${label} probe`);
  }
  if (!facts.sawTurnCompletedUsage) {
    throw new Error(`missing turn.completed usage in ${label} probe`);
  }
}

function assertNoDangerousArgs(args: string[]): void {
  if (args.includes('--dangerously-bypass-approvals-and-sandbox')) {
    throw new Error('dangerous bypass flag must not be used by codex backend');
  }
}

function runCodex(
  bin: string,
  args: string[],
  timeoutMs: number | undefined,
): ReturnType<typeof execa> {
  if (timeoutMs === undefined) return execa(bin, args);
  return execa(bin, args, { timeout: timeoutMs });
}

async function runProbeStep<T>(
  logger: Logger,
  step: string,
  task: () => Promise<T>,
): Promise<T> {
  logger.info({ step }, 'codex_compat_probe_step_start');
  const result = await task();
  logger.info({ step }, 'codex_compat_probe_step_ok');
  return result;
}

async function verifyWorkspaceWrite(
  config: CodexConfig,
  timeoutMs: number | undefined,
): Promise<void> {
  const sentinelName = `.codex-agent-probe-${process.pid}-${Date.now()}.txt`;
  const sentinelPath = join(config.workingDir, sentinelName);
  const args = buildCodexExecArgs(
    config,
    `Use the shell to run exactly: printf CODEX_WORKSPACE_WRITE_OK > ${sentinelName}`,
  );
  assertNoDangerousArgs(args);
  try {
    const probe = await runCodex(config.bin, args, timeoutMs);
    const facts = collectFacts((probe.stdout ?? '').toString());
    if (!facts.sawCommandStarted || !facts.sawCommandCompleted) {
      throw new Error('workspace-write probe did not emit command_execution events');
    }
    const content = await readFile(sentinelPath, 'utf8');
    if (content !== 'CODEX_WORKSPACE_WRITE_OK') {
      throw new Error('workspace-write probe wrote unexpected sentinel content');
    }
  } finally {
    await rm(sentinelPath, { force: true });
  }
}

export async function runCompatibilityProbe(
  opts: CodexCompatibilityProbeOptions,
): Promise<void> {
  const { config, logger, timeoutMs } = opts;
  const probeMode = opts.mode ?? 'startup';
  try {
    logger.info({ probeMode, sandbox: config.sandbox }, 'codex_compat_probe_start');
    const version = await runProbeStep(logger, 'version', () =>
      runCodex(config.bin, ['--version'], timeoutMs),
    );
    const versionText = (version.stdout ?? '').toString().trim();
    if (!versionText) {
      throw new Error('empty stdout from --version');
    }
    logger.info({ version: versionText }, 'codex_cli_version');

    const combinedHelp = await runProbeStep(logger, 'help', async () => {
      const topHelp = await runCodex(config.bin, ['--help'], timeoutMs);
      const execHelp = await runCodex(config.bin, ['exec', '--help'], timeoutMs);
      return `${topHelp.stdout}\n${execHelp.stdout}`;
    });
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
    if (probeMode === 'startup') {
      logger.info({ probeMode }, 'codex_compat_probe_complete');
      return;
    }

    const execArgs = buildCodexExecArgs(config, 'Reply exactly: CODEX_PROBE_OK');
    assertNoDangerousArgs(execArgs);
    const execProbe = await runProbeStep(logger, 'exec-json', () =>
      runCodex(config.bin, execArgs, timeoutMs),
    );
    const execFacts = collectFacts((execProbe.stdout ?? '').toString());
    requireBaseTurnFacts(execFacts, 'exec');

    const resumeArgs = buildCodexResumeArgs(
      config,
      execFacts.threadId!,
      'Reply exactly: CODEX_PROBE_RESUME_OK',
    );
    assertNoDangerousArgs(resumeArgs);
    const resumeProbe = await runProbeStep(logger, 'resume-json', () =>
      runCodex(config.bin, resumeArgs, timeoutMs),
    );
    const resumeFacts = collectFacts((resumeProbe.stdout ?? '').toString());
    requireBaseTurnFacts(resumeFacts, 'resume');
    if (resumeFacts.threadId !== execFacts.threadId) {
      throw new Error('resume probe returned a different thread_id');
    }

    const toolArgs = buildCodexExecArgs(
      config,
      'Use the shell to run: printf CODEX_TOOL_OK',
    );
    assertNoDangerousArgs(toolArgs);
    const toolProbe = await runProbeStep(logger, 'tool-json', () =>
      runCodex(config.bin, toolArgs, timeoutMs),
    );
    const toolFacts = collectFacts((toolProbe.stdout ?? '').toString());
    if (!toolFacts.sawCommandStarted) {
      throw new Error('missing command_execution item.started in tool probe');
    }
    if (!toolFacts.sawCommandCompleted) {
      throw new Error('missing command_execution item.completed in tool probe');
    }
    if (config.sandbox === 'workspace-write') {
      await runProbeStep(logger, 'workspace-write', () =>
        verifyWorkspaceWrite(config, timeoutMs),
      );
    }
    logger.info({ probeMode }, 'codex_compat_probe_complete');
  } catch (err) {
    throw new CodexCompatibilityProbeError(
      `codex compatibility probe failed: ${(err as Error).message}`,
      err,
    );
  }
}
