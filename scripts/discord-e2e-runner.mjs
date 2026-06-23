#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const BASE_ARGS = [
  'run',
  '--config',
  'vitest.e2e.config.ts',
  'tests/e2e/discord',
];

const CASE_PATTERNS = new Map([
  ['happy-path', 'seed_happy_path'],
  ['auth-denied', 'seed_auth_denied'],
  ['idempotency-replay', 'seed_idempotency_replay'],
  ['long-output-slicing', 'seed_long_output_slicing'],
  ['redaction', 'seed_redaction'],
  ['trajectory-read-model', 'seed_trajectory_read_model'],
]);

function usage() {
  return `Usage:
  corepack pnpm test:e2e:discord -- --all
  corepack pnpm test:e2e:discord -- --tag seed
  corepack pnpm test:e2e:discord -- --case happy-path
  corepack pnpm test:e2e:discord -- --case trajectory-read-model

Options:
  --all                 Run all Discord E2E tests.
  --tag seed            Run seed case tests.
  --tag harness         Run harness qualification tests.
  --case <case-id>      Run one seed case.
  --help                Show this help.
`;
}

export function buildVitestArgs(argv) {
  const args = argv.filter((arg) => arg !== '--');
  const vitestArgs = [...BASE_ARGS];
  if (args.length === 0 || args.includes('--all')) return vitestArgs;

  const tagIndex = args.indexOf('--tag');
  if (tagIndex >= 0) {
    const tag = args[tagIndex + 1];
    if (tag === 'seed') {
      return [...vitestArgs, '--testNamePattern', 'seed_'];
    }
    if (tag === 'harness') {
      return [...vitestArgs, '--testNamePattern', 'Discord E2E harness'];
    }
    throw new Error(`unsupported Discord E2E tag: ${tag ?? '<missing>'}`);
  }

  const caseIndex = args.indexOf('--case');
  if (caseIndex >= 0) {
    const caseId = args[caseIndex + 1];
    const pattern = caseId ? CASE_PATTERNS.get(caseId) : undefined;
    if (!pattern) {
      throw new Error(`unsupported Discord E2E case: ${caseId ?? '<missing>'}`);
    }
    return [...vitestArgs, '--testNamePattern', pattern];
  }

  throw new Error(`unsupported Discord E2E arguments: ${args.join(' ')}`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    process.stdout.write(usage());
    return 0;
  }

  let vitestArgs;
  try {
    vitestArgs = buildVitestArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    process.stderr.write(usage());
    return 2;
  }

  const result = spawnSync(
    'corepack',
    ['pnpm', 'exec', 'vitest', ...vitestArgs],
    { stdio: 'inherit' },
  );
  if (result.error) {
    process.stderr.write(`failed to run vitest: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
