#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(MODULE_PATH), '..');
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

async function assertTagCommitInMain(root, tagName) {
  const ancestry = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.equal(
    ancestry.status,
    0,
    `release tag commit must belong to origin/main: ${ancestry.stderr.trim()}`,
  );

  const tagType = spawnSync(
    'git',
    ['cat-file', '-t', `refs/tags/${tagName}`],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.equal(
    tagType.status,
    0,
    `release tag ${tagName} must exist: ${tagType.stderr.trim()}`,
  );
  assert.equal(
    tagType.stdout.trim(),
    'tag',
    `release tag ${tagName} must be annotated`,
  );
}

export async function prepareNpmRelease({
  root = DEFAULT_ROOT,
  env = process.env,
  assertTagInMain = assertTagCommitInMain,
} = {}) {
  const manifest = JSON.parse(
    await readFile(join(root, 'packages', 'cli', 'package.json'), 'utf8'),
  );
  assert.match(manifest.version, SEMVER_PATTERN, 'package version must be SemVer');
  const expectedTag = `v${manifest.version}`;

  assert.equal(
    env.GITHUB_REF_TYPE,
    'tag',
    'publish workflow must be dispatched from a Git tag',
  );
  assert.equal(
    env.GITHUB_REF_NAME,
    expectedTag,
    `release tag must be ${expectedTag}`,
  );
  assert.equal(
    env.RELEASE_CONFIRM_VERSION,
    manifest.version,
    `confirmation must equal ${manifest.version}`,
  );
  assert.equal(manifest.name, '@moesin-lab/agent-nexus');
  assert.equal(manifest.private, false);
  await assertTagInMain(root, expectedTag);

  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  const escapedVersion = manifest.version.replaceAll('.', '\\.');
  assert.match(
    changelog,
    new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'),
    `CHANGELOG.md must contain a dated ${manifest.version} release`,
  );

  const filename = `moesin-lab-agent-nexus-${manifest.version}.tgz`;
  const tarball = `packages/cli/${filename}`;
  const absoluteTarball = resolve(root, tarball);
  const tarballStat = await stat(absoluteTarball);
  assert.equal(tarballStat.isFile(), true, `${tarball} must be a file`);
  const sha256 = createHash('sha256')
    .update(await readFile(absoluteTarball))
    .digest('hex');

  const outputs = [
    `tarball=${tarball}`,
    `filename=${filename}`,
    `version=${manifest.version}`,
    `sha256=${sha256}`,
  ].join('\n');
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, `${outputs}\n`);
  } else {
    process.stdout.write(`${outputs}\n`);
  }
  return { filename, sha256, tarball, version: manifest.version };
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) {
  await prepareNpmRelease();
}
