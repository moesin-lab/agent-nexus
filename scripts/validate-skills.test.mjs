import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateSkills } from './validate-skills.mjs';

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'agent-nexus-skills-'));
  await mkdir(join(root, 'skills', 'valid-skill'), { recursive: true });
  await writeFile(join(root, 'skills.manifest'), 'valid-skill\n');
  await writeFile(
    join(root, 'skills', 'valid-skill', 'SKILL.md'),
    [
      '---',
      'name: valid-skill',
      'description: 当有效场景发生时触发。',
      '---',
      '',
      '# valid-skill',
    ].join('\n'),
  );
  await mkdir(
    join(root, 'skills', 'valid-skill', 'harnesses', 'claude-code'),
    { recursive: true },
  );
  await writeFile(
    join(
      root,
      'skills',
      'valid-skill',
      'harnesses',
      'claude-code',
      'SKILL.md',
    ),
    [
      '---',
      'name: valid-skill',
      'description: 当 Claude Code 有效场景发生时触发。',
      '---',
    ].join('\n'),
  );
  return root;
}

test('合法 manifest 与 SKILL.md 通过校验', async () => {
  const root = await makeRepo();

  assert.deepEqual(await validateSkills(root), []);
});

test('重复、非法名称和缺失目录 fail closed', async () => {
  const root = await makeRepo();
  await writeFile(
    join(root, 'skills.manifest'),
    'valid-skill\nvalid-skill\n../escape\nmissing-skill\n',
  );

  const errors = await validateSkills(root);

  assert.ok(errors.some((error) => error.includes('重复')));
  assert.ok(errors.some((error) => error.includes('非法 skill 名称')));
  assert.ok(errors.some((error) => error.includes('missing-skill')));
});

test('frontmatter name 必须匹配目录且 description 非空', async () => {
  const root = await makeRepo();
  await writeFile(
    join(root, 'skills', 'valid-skill', 'SKILL.md'),
    ['---', 'name: other-skill', 'description:', '---'].join('\n'),
  );

  const errors = await validateSkills(root);

  assert.ok(errors.some((error) => error.includes('frontmatter name')));
  assert.ok(errors.some((error) => error.includes('description')));
});

test('skill 目录中的断链 symlink 会被拒绝', async () => {
  const root = await makeRepo();
  await symlink(
    join(root, 'does-not-exist'),
    join(root, 'skills', 'valid-skill', 'process'),
  );

  const errors = await validateSkills(root);

  assert.ok(errors.some((error) => error.includes('断链 symlink')));
});

test('未注册目录和错误的 harness frontmatter 会被拒绝', async () => {
  const root = await makeRepo();
  await mkdir(join(root, 'skills', 'unregistered-skill'));
  await mkdir(
    join(root, 'skills', 'valid-skill', 'harnesses', 'claude-code'),
    { recursive: true },
  );
  await writeFile(
    join(
      root,
      'skills',
      'valid-skill',
      'harnesses',
      'claude-code',
      'SKILL.md',
    ),
    ['---', 'name: wrong-name', 'description:', '---'].join('\n'),
  );

  const errors = await validateSkills(root);

  assert.ok(errors.some((error) => error.includes('未注册 skill 目录')));
  assert.ok(errors.some((error) => error.includes('harnesses/claude-code')));
  assert.ok(errors.some((error) => error.includes('description')));
});

test('SKILL.md 中不存在的本地 Markdown 链接会被拒绝', async () => {
  const root = await makeRepo();
  await writeFile(
    join(root, 'skills', 'valid-skill', 'SKILL.md'),
    [
      '---',
      'name: valid-skill',
      'description: 当有效场景发生时触发。',
      '---',
      '',
      '[missing](../../docs/dev/process/missing.md)',
    ].join('\n'),
  );

  const errors = await validateSkills(root);

  assert.ok(errors.some((error) => error.includes('无效本地链接')));
});

test('缺少 harness 执行器会被拒绝', async () => {
  const root = await makeRepo();
  await rm(join(root, 'skills', 'valid-skill', 'harnesses'), {
    recursive: true,
  });

  const errors = await validateSkills(root);

  assert.ok(errors.some((error) => error.includes('至少一个 harness')));
});

test('symlink harness 和未注册顶层 symlink 会被拒绝', async () => {
  const root = await makeRepo();
  const harnessRoot = join(
    root,
    'skills',
    'valid-skill',
    'harnesses',
    'claude-code',
  );
  await rm(harnessRoot, { recursive: true });
  await symlink(join(root, 'skills', 'valid-skill'), harnessRoot);
  await symlink(
    join(root, 'skills', 'valid-skill'),
    join(root, 'skills', 'ghost-skill'),
  );

  const errors = await validateSkills(root);

  assert.ok(
    errors.some(
      (error) =>
        error.includes('harness') && error.includes('普通目录'),
    ),
  );
  assert.ok(errors.some((error) => error.includes('ghost-skill')));
});

test('manifest 中已注册的 skill symlink 会被拒绝', async () => {
  const root = await makeRepo();
  const skillRoot = join(root, 'skills', 'valid-skill');
  const target = join(root, 'linked-skill-target');
  await mkdir(target);
  await rm(skillRoot, { recursive: true });
  await symlink(target, skillRoot);

  const errors = await validateSkills(root);

  assert.ok(
    errors.some(
      (error) =>
        error.includes('valid-skill') && error.includes('普通目录'),
    ),
  );
});
