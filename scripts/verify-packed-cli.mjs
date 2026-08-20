#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_FILES = [
  'package/LICENSE',
  'package/README.md',
  'package/dist/index.js',
  'package/package.json',
];
const SOURCE_MANIFEST = JSON.parse(
  await readFile(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'),
);

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let deadlineTimer;
    let killTimer;

    const clearTimers = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    if (options.timeoutMs !== undefined) {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      }, options.timeoutMs);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimers();
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimers();
      const result = { code, signal, stdout, stderr };
      if (timedOut) {
        reject(new Error(`${command} timed out`));
        return;
      }
      if (code === 0 || options.allowFailure === true) {
        resolveRun(result);
        return;
      }
      reject(
        new Error(
          [
            `${command} ${args.join(' ')} failed with code ${String(code)}`,
            stdout,
            stderr,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
    });
  });
}

function permissionBits(fileStat) {
  return fileStat.mode & 0o777;
}

async function assertMode(path, expected) {
  const fileStat = await stat(path);
  assert.equal(
    permissionBits(fileStat),
    expected,
    `${path} mode must be ${expected.toString(8)}`,
  );
}

async function createTarball(packRoot) {
  const result = await run('npm', [
    'pack',
    '--json',
    '--silent',
    '--pack-destination',
    packRoot,
    './packages/cli',
  ]);
  const packResult = JSON.parse(result.stdout);
  assert.equal(packResult.length, 1, 'npm pack must create one tarball');
  return join(packRoot, packResult[0].filename);
}

async function verifyTarball(tarballPath, tempRoot) {
  const tarList = await run('tar', ['-tzf', tarballPath]);
  const files = tarList.stdout
    .trim()
    .split('\n')
    .map((path) => path.replace(/^\.\//, ''))
    .sort();
  assert.deepEqual(files, [...EXPECTED_FILES].sort());

  const installRoot = join(tempRoot, 'install');
  await run('npm', [
    'install',
    '--prefix',
    installRoot,
    '--no-audit',
    '--no-fund',
    tarballPath,
  ]);

  const packageRoot = join(
    installRoot,
    'node_modules',
    '@moesin-lab',
    'agent-nexus',
  );
  const manifest = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  assert.equal(manifest.name, SOURCE_MANIFEST.name);
  assert.equal(manifest.version, SOURCE_MANIFEST.version);
  assert.equal(manifest.main, undefined);
  assert.deepEqual(manifest.bin, SOURCE_MANIFEST.bin);
  assert.equal(
    manifest.dependencies['better-sqlite3'],
    SOURCE_MANIFEST.dependencies['better-sqlite3'],
  );
  assert.equal(
    manifest.dependencies['@larksuiteoapi/node-sdk'],
    SOURCE_MANIFEST.dependencies['@larksuiteoapi/node-sdk'],
  );
  assert.equal(
    manifest.dependencies.ws,
    SOURCE_MANIFEST.dependencies.ws,
  );
  assert.equal(
    Object.keys(manifest.dependencies).some((name) =>
      name.startsWith('@agent-nexus/'),
    ),
    false,
    'internal workspace packages must stay bundled',
  );
  assert.deepEqual((await readdir(packageRoot)).sort(), [
    'LICENSE',
    'README.md',
    'dist',
    'package.json',
  ]);
  assert.deepEqual(await readdir(join(packageRoot, 'dist')), ['index.js']);
  await assertMode(join(packageRoot, 'dist', 'index.js'), 0o755);

  const require = createRequire(join(packageRoot, 'dist', 'index.js'));
  const BetterSqlite3 = require('better-sqlite3');
  const database = new BetterSqlite3(':memory:');
  try {
    assert.deepEqual(database.prepare('select 1 as ok').get(), { ok: 1 });
  } finally {
    database.close();
  }

  const cliHome = join(tempRoot, 'cli-home');
  const cli = join(installRoot, 'node_modules', '.bin', 'agent-nexus');
  const result = await run(cli, [], {
    allowFailure: true,
    env: {
      ...process.env,
      AGENT_NEXUS_HOME: cliHome,
    },
  });
  assert.equal(result.code, 1, 'first run must stop after scaffolding config');
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /agent-nexus 配置模板已创建/,
  );
  await assertMode(cliHome, 0o700);
  await assertMode(join(cliHome, 'secrets'), 0o700);
  await assertMode(join(cliHome, 'config.json'), 0o600);
  await assertMode(join(cliHome, 'secrets', 'DISCORD_BOT_TOKEN'), 0o600);

  if (process.env.AGENT_NEXUS_RUN_PACKED_CODEX_E2E === '1') {
    const packedCodex = await run(cli, ['--verify-packed-codex-turn'], {
      timeoutMs: 180_000,
      env: {
        ...process.env,
        AGENT_NEXUS_HOME: cliHome,
      },
    });
    assert.match(packedCodex.stdout, /packed Codex app-server turn verified/);
    process.stdout.write('packed Codex turn verified from installed CLI\n');
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), 'agent-nexus-pack-'));
try {
  const requestedTarball = process.argv[2];
  const tarballPath =
    requestedTarball === undefined
      ? await createTarball(tempRoot)
      : resolve(ROOT, requestedTarball);
  await verifyTarball(tarballPath, tempRoot);
  process.stdout.write(`packed CLI verified: ${tarballPath}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
