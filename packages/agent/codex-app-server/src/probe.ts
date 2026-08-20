import { execFile } from 'node:child_process';

export class CodexAppServerCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAppServerCompatibilityError';
  }
}

export interface CodexAppServerProbeOptions {
  bin: string;
  runCommand?: (
    bin: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
}

export async function runCodexAppServerCompatibilityProbe(
  options: CodexAppServerProbeOptions,
): Promise<{ codexVersion: string }> {
  const run = options.runCommand ?? runCommand;
  let versionOutput: { stdout: string; stderr: string };
  try {
    versionOutput = await run(options.bin, ['--version']);
  } catch (error) {
    throw new CodexAppServerCompatibilityError(
      `无法执行 Codex app-server compatibility probe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const match = /(?:^|\s)codex-cli\s+(\d+\.\d+\.\d+)(?:\s|$)/.exec(versionOutput.stdout.trim());
  if (match?.[1] !== '0.146.0') {
    throw new CodexAppServerCompatibilityError(
      `codex-app-server schema pinned to 0.146.0, received ${match?.[1] ?? 'unknown version'}`,
    );
  }
  const help = await run(options.bin, ['app-server', '--help']);
  if (!help.stdout.includes('--listen')) {
    throw new CodexAppServerCompatibilityError('codex app-server --help 缺少 --listen surface');
  }
  return { codexVersion: match[1] };
}

export async function runCodexAppServerViewerCompatibilityProbe(
  options: CodexAppServerProbeOptions,
): Promise<{ viewerAvailable: true }> {
  const run = options.runCommand ?? runCommand;
  let serverHelp: string;
  let clientHelp: string;
  try {
    serverHelp = (await run(options.bin, ['app-server', '--help'])).stdout;
    clientHelp = (await run(options.bin, ['--help'])).stdout;
  } catch (error) {
    throw new CodexAppServerCompatibilityError(
      `无法执行 Codex supplemental viewer compatibility probe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  for (const flag of ['--listen', '--ws-auth', '--ws-token-file']) {
    if (!serverHelp.includes(flag)) {
      throw new CodexAppServerCompatibilityError(`codex app-server --help 缺少 ${flag} surface`);
    }
  }
  if (!serverHelp.includes('capability-token')) {
    throw new CodexAppServerCompatibilityError(
      'codex app-server --help 缺少 capability-token auth mode',
    );
  }
  for (const flag of ['--remote', '--remote-auth-token-env']) {
    if (!clientHelp.includes(flag)) {
      throw new CodexAppServerCompatibilityError(`codex --help 缺少 ${flag} surface`);
    }
  }
  return { viewerAvailable: true };
}

function runCommand(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 1_048_576 },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
  });
}
