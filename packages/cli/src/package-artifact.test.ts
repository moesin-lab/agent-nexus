import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const CLI_MANIFEST_URL = new URL('../package.json', import.meta.url);
const ROOT_LICENSE_URL = new URL('../../../LICENSE', import.meta.url);
const CLI_LICENSE_URL = new URL('../LICENSE', import.meta.url);
const CLI_README_URL = new URL('../README.md', import.meta.url);
const INTERNAL_MANIFEST_URLS = [
  new URL('../../protocol/package.json', import.meta.url),
  new URL('../../daemon/package.json', import.meta.url),
  new URL('../../agent/claudecode/package.json', import.meta.url),
  new URL('../../agent/codex/package.json', import.meta.url),
  new URL('../../agent/codex-app-server/package.json', import.meta.url),
  new URL('../../platform/discord/package.json', import.meta.url),
  new URL('../../platform/lark/package.json', import.meta.url),
];

async function readJson(url: URL): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(url, 'utf8')) as Record<string, unknown>;
}

describe('published CLI package artifact', () => {
  it('publishes one scoped CLI identity while internal packages remain private', async () => {
    const cliManifest = await readJson(CLI_MANIFEST_URL);
    const internalManifests = await Promise.all(
      INTERNAL_MANIFEST_URLS.map(readJson),
    );

    expect(cliManifest).toMatchObject({
      name: '@moesin-lab/agent-nexus',
      version: '0.1.0',
      private: false,
      bin: {
        'agent-nexus': './dist/index.js',
      },
      publishConfig: {
        access: 'public',
      },
    });
    expect(internalManifests).toHaveLength(7);
    expect(internalManifests.every((manifest) => manifest['private'] === true)).toBe(
      true,
    );
  });

  it('does not expose the executable entry as an importable library', async () => {
    const cliManifest = await readJson(CLI_MANIFEST_URL);

    expect(cliManifest).not.toHaveProperty('main');
  });

  it('declares discoverable npm metadata and the supported Node LTS majors', async () => {
    const cliManifest = await readJson(CLI_MANIFEST_URL);

    expect(cliManifest).toMatchObject({
      description: expect.any(String),
      keywords: expect.arrayContaining(['agent', 'discord', 'lark', 'cli']),
      repository: {
        type: 'git',
        url: 'git+https://github.com/moesin-lab/agent-nexus.git',
        directory: 'packages/cli',
      },
      homepage: 'https://github.com/moesin-lab/agent-nexus#readme',
      bugs: {
        url: 'https://github.com/moesin-lab/agent-nexus/issues',
      },
      engines: {
        node: '^22.0.0 || ^24.0.0',
      },
    });
    expect(cliManifest['description']).not.toBe('');
  });

  it('declares bundled platform externals as runtime dependencies', async () => {
    const [cliManifest, appServerManifest] = await Promise.all([
      readJson(CLI_MANIFEST_URL),
      readJson(new URL('../../agent/codex-app-server/package.json', import.meta.url)),
    ]);
    const dependencies = cliManifest['dependencies'] as
      | Record<string, string>
      | undefined;
    const scripts = cliManifest['scripts'] as Record<string, string> | undefined;

    expect(dependencies?.['better-sqlite3']).toBe('^12.11.1');
    expect(dependencies?.['@larksuiteoapi/node-sdk']).toBe('1.70.0');
    expect(dependencies?.['ws']).toBe('8.21.3');
    expect(
      (appServerManifest['dependencies'] as Record<string, string> | undefined)?.['ws'],
    ).toBe('8.21.3');
    expect(
      Object.values(dependencies ?? {}).some((version) =>
        version.startsWith('workspace:'),
      ),
    ).toBe(false);
    expect(scripts?.['bundle']).toContain('--target=node22');
    expect(scripts?.['bundle']).toContain('--external:better-sqlite3');
    expect(scripts?.['bundle']).toContain('--external:ws');
    expect(scripts?.['bundle']).toContain(
      '--external:@larksuiteoapi/node-sdk',
    );
  });

  it('packages the executable with its npm README and MIT license', async () => {
    const cliManifest = await readJson(CLI_MANIFEST_URL);
    const [rootLicense, cliLicense, cliReadme] = await Promise.all([
      readFile(ROOT_LICENSE_URL, 'utf8'),
      readFile(CLI_LICENSE_URL, 'utf8'),
      readFile(CLI_README_URL, 'utf8'),
    ]);

    expect(cliManifest['files']).toEqual([
      'dist/index.js',
      'README.md',
      'LICENSE',
    ]);
    expect(cliLicense).toBe(rootLicense);
    expect(cliReadme).toContain('npm install -g @moesin-lab/agent-nexus');
    expect(cliReadme).toContain('docs/product/platforms/lark.md');
  });
});
