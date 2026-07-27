#!/usr/bin/env node

import assert from 'node:assert/strict';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  await readFile(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'),
);
const expectedTag = `v${manifest.version}`;

assert.equal(
  process.env.GITHUB_REF_TYPE,
  'tag',
  'publish workflow must be dispatched from a Git tag',
);
assert.equal(
  process.env.GITHUB_REF_NAME,
  expectedTag,
  `release tag must be ${expectedTag}`,
);
assert.equal(
  process.env.RELEASE_CONFIRM_VERSION,
  manifest.version,
  `confirmation must equal ${manifest.version}`,
);
assert.equal(manifest.name, '@moesin-lab/agent-nexus');
assert.equal(manifest.private, false);

const changelog = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8');
const escapedVersion = manifest.version.replaceAll('.', '\\.');
assert.match(
  changelog,
  new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'),
  `CHANGELOG.md must contain a dated ${manifest.version} release`,
);

const tarball = `packages/cli/moesin-lab-agent-nexus-${manifest.version}.tgz`;
const tarballStat = await stat(join(ROOT, tarball));
assert.equal(tarballStat.isFile(), true, `${tarball} must be a file`);

const outputs = [`tarball=${tarball}`, `version=${manifest.version}`].join('\n');
const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  await appendFile(githubOutput, `${outputs}\n`);
} else {
  process.stdout.write(`${outputs}\n`);
}
