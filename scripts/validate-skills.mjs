#!/usr/bin/env node
import {
  lstat,
  opendir,
  readFile,
  stat,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

async function existsAsDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isRegularDirectory(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function parseManifest(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

function frontmatterField(text, field) {
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(text);
  if (!match) return undefined;
  const fieldMatch = new RegExp(`^${field}:\\s*(.*)$`, 'm').exec(match[1]);
  return fieldMatch?.[1]?.trim();
}

async function validateSkillFile(root, path, expectedName, errors) {
  let skillText;
  try {
    skillText = await readFile(path, 'utf8');
  } catch {
    errors.push(`skill 入口不存在：${relative(root, path)}`);
    return;
  }
  const frontmatterName = frontmatterField(skillText, 'name');
  if (frontmatterName !== expectedName) {
    errors.push(
      `${relative(root, path)} frontmatter name 必须等于 ${expectedName}`,
    );
  }
  const description = frontmatterField(skillText, 'description');
  if (!description) {
    errors.push(`${relative(root, path)} description 不能为空`);
  }
  for (const match of skillText.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    if (
      rawTarget.startsWith('#') ||
      /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)
    ) {
      continue;
    }
    const target = rawTarget.split('#', 1)[0];
    if (!target) continue;
    try {
      await stat(resolve(dirname(path), decodeURIComponent(target)));
    } catch {
      errors.push(
        `${relative(root, path)} 无效本地链接：${rawTarget}`,
      );
    }
  }
}

async function findBrokenSymlinks(root) {
  const broken = [];

  async function visit(directory) {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        try {
          await stat(path);
        } catch {
          broken.push(path);
        }
      } else if (metadata.isDirectory()) {
        await visit(path);
      }
    }
  }

  await visit(root);
  return broken;
}

export async function validateSkills(repoRoot) {
  const root = resolve(repoRoot);
  const manifestPath = join(root, 'skills.manifest');
  const skillsRoot = join(root, 'skills');
  const errors = [];
  let manifest;
  try {
    manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    return [
      `无法读取 ${relative(root, manifestPath)}：${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }

  const seen = new Set();
  for (const name of manifest) {
    if (!SKILL_NAME_PATTERN.test(name)) {
      errors.push(`非法 skill 名称：${name}`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`skills.manifest 存在重复项：${name}`);
      continue;
    }
    seen.add(name);

    const skillRoot = join(skillsRoot, name);
    if (!(await isRegularDirectory(skillRoot))) {
      errors.push(`manifest skill 必须是普通目录：skills/${name}`);
      continue;
    }

    await validateSkillFile(root, join(skillRoot, 'SKILL.md'), name, errors);

    const harnessesRoot = join(skillRoot, 'harnesses');
    let validHarnesses = 0;
    if (await isRegularDirectory(harnessesRoot)) {
      const harnesses = await opendir(harnessesRoot);
      for await (const harness of harnesses) {
        if (harness.isSymbolicLink()) {
          errors.push(
            `harness 必须是普通目录：${relative(
              root,
              join(harnessesRoot, harness.name),
            )}`,
          );
          continue;
        }
        if (!harness.isDirectory()) continue;
        validHarnesses += 1;
        await validateSkillFile(
          root,
          join(harnessesRoot, harness.name, 'SKILL.md'),
          name,
          errors,
        );
      }
    }
    if (validHarnesses === 0) {
      errors.push(`skills/${name} 必须包含至少一个 harness 执行器`);
    }
  }

  if (await existsAsDirectory(skillsRoot)) {
    const skillDirectories = await opendir(skillsRoot);
    for await (const entry of skillDirectories) {
      if (
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        !seen.has(entry.name)
      ) {
        errors.push(`未注册 skill 目录：skills/${entry.name}`);
      }
    }
    for (const path of await findBrokenSymlinks(skillsRoot)) {
      errors.push(`断链 symlink：${relative(root, path)}`);
    }
  }
  return errors;
}

async function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = await validateSkills(repoRoot);
  if (errors.length > 0) {
    console.error(
      ['skill validation failed:', ...errors.map((error) => `- ${error}`)].join(
        '\n',
      ),
    );
    process.exitCode = 1;
    return;
  }
  console.log('skill validation ok');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
