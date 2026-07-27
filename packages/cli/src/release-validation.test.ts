import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT_MANIFEST_URL = new URL('../../../package.json', import.meta.url);
const NODE_VERSION_URL = new URL('../../../.nvmrc', import.meta.url);
const CI_WORKFLOW_URL = new URL('../../../.github/workflows/ci.yml', import.meta.url);
const PUBLISH_WORKFLOW_URL = new URL(
  '../../../.github/workflows/publish-npm.yml',
  import.meta.url,
);
const PACK_VERIFIER_URL = new URL(
  '../../../scripts/verify-packed-cli.mjs',
  import.meta.url,
);
const RELEASE_PREPARER_URL = new URL(
  '../../../scripts/prepare-npm-release.mjs',
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

  it('publishes only a confirmed tagged artifact through the protected environment', async () => {
    const [workflow, preparer] = await Promise.all([
      readFile(PUBLISH_WORKFLOW_URL, 'utf8'),
      readFile(RELEASE_PREPARER_URL, 'utf8'),
    ]);

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('environment: npm-production');
    expect(workflow).toContain('needs: build');
    expect(workflow).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(workflow).toContain(
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    );
    expect(workflow).toContain(
      'actions/download-artifact@018cc2cf5baa6db3ef3c5f8a56943fffe632ef53',
    );
    expect(workflow).toContain('sha256sum --check SHA256SUMS');
    expect(workflow).toContain('npm publish "$TARBALL"');
    expect(workflow).toContain('--tag latest');
    expect(workflow).toContain(
      'node scripts/verify-packed-cli.mjs "${{ steps.artifact.outputs.tarball }}"',
    );
    expect(workflow).not.toContain('id-token: write');
    expect(workflow).not.toContain('RELEASE_MAIN_REF');
    expect(workflow).not.toContain('RELEASE_TARBALL_PATH');
    expect(workflow).not.toMatch(
      /uses: (?:actions\/checkout|actions\/setup-node|pnpm\/action-setup)@v\d/,
    );
    expect(preparer).toContain('env.GITHUB_REF_TYPE');
    expect(preparer).toContain('`v${manifest.version}`');
    expect(preparer).toContain('CHANGELOG.md');
    expect(preparer).toContain('GITHUB_OUTPUT');
    expect(preparer).toContain("'merge-base', '--is-ancestor'");
    expect(preparer).toContain("'cat-file', '-t'");
  });

  it('executes the release gate success and wrong-ref failure paths', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'agent-nexus-release-gate-'));
    const cliRoot = join(tempRoot, 'packages', 'cli');
    const tarball = join(
      cliRoot,
      'moesin-lab-agent-nexus-0.1.0.tgz',
    );
    const output = join(tempRoot, 'github-output');
    // @ts-expect-error JavaScript release helper has no declaration file.
    const { prepareNpmRelease } = await import(
      '../../../scripts/prepare-npm-release.mjs'
    );

    try {
      await mkdir(cliRoot, { recursive: true });
      await writeFile(
        join(cliRoot, 'package.json'),
        JSON.stringify({
          name: '@moesin-lab/agent-nexus',
          version: '0.1.0',
          private: false,
        }),
      );
      await writeFile(
        join(tempRoot, 'CHANGELOG.md'),
        '## [0.1.0] - 2026-07-26\n',
      );
      await writeFile(tarball, 'release-candidate');
      await prepareNpmRelease({
        root: tempRoot,
        env: {
          GITHUB_REF_TYPE: 'tag',
          GITHUB_REF_NAME: 'v0.1.0',
          RELEASE_CONFIRM_VERSION: '0.1.0',
          GITHUB_OUTPUT: output,
        },
        assertTagInMain: async () => {},
      });
      await expect(readFile(output, 'utf8')).resolves.toContain(
        'tarball=packages/cli/moesin-lab-agent-nexus-0.1.0.tgz',
      );

      await expect(
        prepareNpmRelease({
          root: tempRoot,
          env: {
            GITHUB_REF_TYPE: 'branch',
            GITHUB_REF_NAME: 'main',
            RELEASE_CONFIRM_VERSION: '0.1.0',
          },
          assertTagInMain: async () => {},
        }),
      ).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
