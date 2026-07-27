import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const ROOT_MANIFEST_URL = new URL('../../../package.json', import.meta.url);
const NODE_VERSION_URL = new URL('../../../.nvmrc', import.meta.url);
const CI_WORKFLOW_URL = new URL('../../../.github/workflows/ci.yml', import.meta.url);
const PACK_VERIFIER_URL = new URL(
  '../../../scripts/verify-packed-cli.mjs',
  import.meta.url,
);
const TESTING_STRATEGY_URL = new URL(
  '../../../docs/dev/testing/strategy.md',
  import.meta.url,
);

describe('release artifact validation', () => {
  it('supports only the tested Node LTS majors', async () => {
    const rootManifest = JSON.parse(
      await readFile(ROOT_MANIFEST_URL, 'utf8'),
    ) as Record<string, unknown>;
    const engines = rootManifest['engines'] as Record<string, string>;

    expect(engines['node']).toBe('^22.0.0 || ^24.0.0');
    await expect(readFile(NODE_VERSION_URL, 'utf8')).resolves.toBe('22\n');
  });

  it('validates source and packed CLI on the declared CI matrix', async () => {
    const workflow = await readFile(CI_WORKFLOW_URL, 'utf8');

    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain('node-version: [22, 24]');
    expect(workflow).toContain(
      'runner: [ubuntu-24.04, macos-15, macos-15-intel]',
    );
    expect(workflow).toContain('run: pnpm verify:pack:cli');
    expect(workflow).toContain('source-checks:');
    expect(workflow).toContain('needs: [source-checks, packed-cli]');
    expect(workflow).toContain('SOURCE_CHECKS_RESULT');
    expect(workflow).toContain('actions/setup-node@v6');
    expect(workflow).not.toContain('actions/setup-node@v4');
    expect(workflow).not.toContain('export HOME=');
  });

  it('installs and probes the exact npm artifact with native SQLite', async () => {
    const verifier = await readFile(PACK_VERIFIER_URL, 'utf8');

    expect(verifier).toMatch(/run\('npm', \[\s*'pack'/);
    expect(verifier).toMatch(/run\('npm', \[\s*'install'/);
    expect(verifier).toContain("require('better-sqlite3')");
    expect(verifier).toContain('AGENT_NEXUS_HOME');
    expect(verifier).not.toContain('process.env.HOME');
  });

  it('documents packed artifact evidence alongside the test model', async () => {
    const strategy = await readFile(TESTING_STRATEGY_URL, 'utf8');

    expect(strategy).toContain('## 发布制品验证');
    expect(strategy).toContain('better-sqlite3');
  });
});
