import { describe, expect, it } from 'vitest';
import { buildVitestArgs } from '../../../scripts/discord-e2e-runner.mjs';

describe('Discord E2E runner args', () => {
  it('maps --all to the full Discord E2E suite', () => {
    expect(buildVitestArgs(['--all'])).toEqual([
      'run',
      '--config',
      'vitest.e2e.config.ts',
      'tests/e2e/discord',
    ]);
  });

  it('maps --tag seed to seed case tests', () => {
    expect(buildVitestArgs(['--tag', 'seed'])).toEqual([
      'run',
      '--config',
      'vitest.e2e.config.ts',
      'tests/e2e/discord',
      '--testNamePattern',
      'seed_',
    ]);
  });

  it('maps --case happy-path to the canonical seed test name fragment', () => {
    expect(buildVitestArgs(['--case', 'happy-path'])).toEqual([
      'run',
      '--config',
      'vitest.e2e.config.ts',
      'tests/e2e/discord',
      '--testNamePattern',
      'seed_happy_path',
    ]);
  });

  it('ignores the pnpm argument separator before runner options', () => {
    expect(buildVitestArgs(['--', '--case', 'redaction'])).toEqual([
      'run',
      '--config',
      'vitest.e2e.config.ts',
      'tests/e2e/discord',
      '--testNamePattern',
      'seed_redaction',
    ]);
  });
});
