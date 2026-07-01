#!/usr/bin/env node

const titlePattern =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._-]+\))?!?: .+/;

const requiredSections = [
  '## Summary',
  '## Why',
  'ADR:',
  'Spec:',
  '## Test plan',
  '## Review notes',
  '## Out of scope',
];

const placeholderPatterns = [
  /<背景和当前问题[^>]*>/,
  /<改了什么[^>]*>/,
  /<为什么要做[^>]*>/,
  /<链接或 N\/A[^>]*>/,
  /<测试文件[^>]*>/,
  /<命令>/,
  /<真实平台[^>]*>/,
  /<review log[^>]*>/,
  /<触发条件[^>]*>/,
  /<本 PR 明确不做[^>]*>/,
];

const requiredReviewFields = [
  /^- Independent agent review:\s*\S.+/im,
  /^- Deep review:\s*\S.+/im,
];

const requiredChineseSections = [
  '## Summary',
  '## Why',
  '## Test plan',
  '## Review notes',
  '## Out of scope',
];
const prBodyMinCjkCount = 20;
const prBodyMinCjkRatio = 0.25;
const prBodySectionMinCjkCount = 1;
const prBodySectionMinCjkRatio = 0.15;

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

function normalizeLanguageText(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/^\s*(ADR|Spec):/gim, '')
    .replace(/^\s*-\s*\[[ xX]\]\s*(Tests|Manual):/gim, '')
    .replace(/^\s*-\s*(Independent agent review|Deep review):/gim, '')
    .replace(/\bN\/A\b/g, '')
    .split('\n')
    .filter((line) => !/^##\s+/.test(line.trim()))
    .join('\n');
}

function validateChineseText(text, label, { minCjkCount, minRatio }) {
  const languageText = normalizeLanguageText(text);
  const cjkCount = countMatches(languageText, /[\u3400-\u9fff]/g);
  const latinCount = countMatches(languageText, /[A-Za-z]/g);
  const totalLetters = cjkCount + latinCount;
  const errors = [];

  if (cjkCount < minCjkCount) {
    errors.push(`${label} must be written in Chinese; PR title is excluded from this requirement.`);
  }

  if (totalLetters > 0 && cjkCount / totalLetters < minRatio) {
    errors.push(`${label} must be primarily Chinese text; English section labels, commands, paths, and proper nouns are allowed.`);
  }

  return errors;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionBody(body, heading) {
  const headingMatch = new RegExp(`^${escapeRegExp(heading)}\\s*$`, 'm').exec(body);
  if (!headingMatch) return '';

  const start = headingMatch.index + headingMatch[0].length;
  const rest = body.slice(start);
  const nextHeadingMatch = /^##\s+/m.exec(rest);
  const end = nextHeadingMatch ? start + nextHeadingMatch.index : body.length;
  return body.slice(start, end);
}

function validatePrBodyLanguage(body) {
  const errors = validateChineseText(body, 'PR body', {
    minCjkCount: prBodyMinCjkCount,
    minRatio: prBodyMinCjkRatio,
  });

  for (const section of requiredChineseSections) {
    if (!body.includes(section)) continue;
    errors.push(...validateChineseText(sectionBody(body, section), `PR body section ${section}`, {
      minCjkCount: prBodySectionMinCjkCount,
      minRatio: prBodySectionMinCjkRatio,
    }));
  }

  return errors;
}

function validatePrTitle(title) {
  const normalizedTitle = typeof title === 'string' ? title : '';
  if (titlePattern.test(normalizedTitle)) {
    return [];
  }

  return [
    'PR title must follow Conventional Commits, for example: ci(pr): validate pull request metadata',
  ];
}

function validatePrBody(body) {
  const errors = [];
  const normalizedBody = typeof body === 'string' ? body : '';

  errors.push(...validatePrBodyLanguage(normalizedBody));

  for (const section of requiredSections) {
    if (!normalizedBody.includes(section)) {
      errors.push(`PR body is missing required template field: ${section}`);
    }
  }

  for (const pattern of placeholderPatterns) {
    if (pattern.test(normalizedBody)) {
      errors.push(`PR body still contains template placeholder matching ${pattern}`);
    }
  }

  if (!/^- \[[ xX]\] .+/m.test(normalizedBody)) {
    errors.push('PR body must include at least one checklist item in the test plan.');
  }

  for (const pattern of requiredReviewFields) {
    if (!pattern.test(normalizedBody)) {
      errors.push(`PR body is missing a filled review field matching ${pattern}`);
    }
  }

  return errors;
}

function validatePrMetadata({ title, body }) {
  return [...validatePrTitle(title), ...validatePrBody(body)];
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validatePrMetadataUpdate(toolInput) {
  const errors = [];

  if (hasOwn(toolInput, 'title')) {
    errors.push(...validatePrTitle(toolInput.title));
  }

  if (hasOwn(toolInput, 'body')) {
    errors.push(...validatePrBody(toolInput.body));
  }

  return errors;
}

function printErrors(errors) {
  console.error(['PR metadata validation failed:', ...errors.map((error) => `- ${error}`)].join('\n'));
}

function usage() {
  console.error(`Usage:
  scripts/validate-pr-metadata.mjs --event-path <github-event-json>
  scripts/validate-pr-metadata.mjs --hook
  scripts/validate-pr-metadata.mjs --title <title> --body-file <markdown>
  scripts/validate-pr-metadata.mjs --self-test`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function isCreatePullRequestTool(toolName) {
  return (
    toolName === 'mcp__codex_apps__github._create_pull_request' ||
    toolName === 'mcp__github__.create_pull_request' ||
    toolName === 'mcp__github__create_pull_request' ||
    (toolName.includes('github') && toolName.includes('create_pull_request'))
  );
}

function isUpdatePullRequestTool(toolName) {
  return (
    toolName === 'mcp__codex_apps__github._update_pull_request' ||
    toolName === 'mcp__github__.update_pull_request' ||
    toolName === 'mcp__github__update_pull_request' ||
    (toolName.includes('github') && toolName.includes('update_pull_request'))
  );
}

async function runHookMode() {
  const inputText = await readStdin();
  let input;
  try {
    input = JSON.parse(inputText || '{}');
  } catch (error) {
    console.error(
      `[validate-pr-metadata] invalid hook JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  const toolName = input.tool_name || '';

  if (!isCreatePullRequestTool(toolName) && !isUpdatePullRequestTool(toolName)) {
    return 0;
  }

  const toolInput = input.tool_input || {};
  const errors = isCreatePullRequestTool(toolName)
    ? validatePrMetadata({ title: toolInput.title, body: toolInput.body })
    : validatePrMetadataUpdate(toolInput);
  if (errors.length > 0) {
    console.error(`[validate-pr-metadata] blocked ${toolName}`);
    printErrors(errors);
    return 2;
  }

  return 0;
}

async function runEventPathMode(eventPath) {
  const { readFile } = await import('node:fs/promises');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const pr = event.pull_request;

  if (!pr) {
    console.error('This validator must run on pull_request events.');
    return 2;
  }

  const errors = validatePrMetadata({ title: pr.title, body: pr.body || '' });
  if (errors.length > 0) {
    printErrors(errors);
    return 2;
  }

  return 0;
}

async function runTitleBodyMode(title, bodyFile) {
  const { readFile } = await import('node:fs/promises');
  const body = await readFile(bodyFile, 'utf8');
  const errors = validatePrMetadata({ title, body });
  if (errors.length > 0) {
    printErrors(errors);
    return 2;
  }

  return 0;
}

function sampleBody() {
  return `## Summary

新增 PR metadata 校验，避免格式不完整的 PR 描述进入 review。

本 PR：
- 校验 PR title 和 PR body 的必填结构。
- 校验 PR 正文以中文为主。

## Why

PR 描述是 reviewer 理解范围、验证方式和剩余风险的入口。正文统一使用中文，可以减少本仓库协作语境下的信息损耗。

ADR: N/A - 仅调整仓库协作校验。
Spec: N/A - 不涉及运行时契约。

## Test plan

- [x] Tests: 覆盖 validator 自检样例。
- [x] \`node scripts/validate-pr-metadata.mjs --self-test\` - 通过。

## Review notes

- Independent agent review: N/A - 自检 fixture。
- Deep review: N/A - 无架构变更。

## Out of scope

- 合并自动化。
`;
}

async function runSelfTest() {
  const validErrors = validatePrMetadata({
    title: 'ci(pr): validate pull request metadata',
    body: sampleBody(),
  });
  if (validErrors.length > 0) {
    throw new Error(`valid fixture failed: ${validErrors.join('; ')}`);
  }

  const invalidErrors = validatePrMetadata({
    title: 'bad title',
    body: '## Summary\n\n<背景和当前问题，1-2 段>',
  });
  if (invalidErrors.length === 0) {
    throw new Error('invalid fixture unexpectedly passed');
  }

  const englishBodyErrors = validatePrMetadata({
    title: 'docs(pr): require chinese pull request body',
    body: `## Summary

Adds pull request body validation.

## Why

Keep review metadata readable.

ADR: N/A - docs only.
Spec: N/A - no runtime contract.

## Test plan

- [x] Tests: validator self-test.

## Review notes

- Independent agent review: N/A - fixture.
- Deep review: N/A - no architecture change.

## Out of scope

- Merge automation.
`,
  });
  if (!englishBodyErrors.some((error) => error.includes('Chinese'))) {
    throw new Error('english body fixture did not fail the Chinese body check');
  }

  const mixedBodyErrors = validatePrMetadata({
    title: 'docs(pr): require chinese pull request body',
    body: `## Summary

新增 PR 正文中文校验。

## Why

Keep review metadata readable.

ADR: N/A - docs only.
Spec: N/A - no runtime contract.

## Test plan

- [x] Tests: validator self-test.

## Review notes

- Independent agent review: N/A - fixture.
- Deep review: N/A - no architecture change.

## Out of scope

- Merge automation.
`,
  });
  if (!mixedBodyErrors.some((error) => error.includes('## Why'))) {
    throw new Error('mixed-language fixture did not fail the section Chinese check');
  }

  const technicalChineseBodyErrors = validatePrMetadata({
    title: 'docs(pr): require chinese pull request body',
    body: `## Summary

新增 PR metadata 校验，要求正文整体和必填段落都以中文为主。

本 PR：
- 更新 validatePrMetadata、validatePrBody 和 validatePrBodyLanguage。
- 保留 ADR、Spec、Tests、Independent agent review、Deep review 等固定字段名。
- 允许 docs/dev/process/code-review.md、scripts/validate-pr-metadata.mjs 等路径保留英文。

## Why

PR body 是 reviewer 判断范围和风险的入口。正文统一使用中文，同时允许 Conventional Commits、MCP tool name、GitHub Actions job name 等专有名词保留英文。

ADR: N/A - 仅调整协作校验。
Spec: N/A - 不涉及运行时契约。

## Test plan

- [x] Tests: validate-pr-metadata self-test 覆盖中文正文、英文正文和混合段落。
- [x] node scripts/validate-pr-metadata.mjs --self-test - 通过。

## Review notes

- Independent agent review: N/A - fixture。
- Deep review: N/A - 无架构变更。

## Out of scope

- 合并自动化。
`,
  });
  if (technicalChineseBodyErrors.length > 0) {
    throw new Error(`technical Chinese fixture failed: ${technicalChineseBodyErrors.join('; ')}`);
  }

  const nonPrTool = {
    tool_name: 'Read',
    tool_input: { file_path: 'AGENTS.md' },
  };
  const createPrTool = {
    tool_name: 'mcp__codex_apps__github._create_pull_request',
    tool_input: {
      title: 'bad title',
      body: '## Summary\n\n<背景和当前问题，1-2 段>',
    },
  };
  const updatePrTool = {
    tool_name: 'mcp__codex_apps__github._update_pull_request',
    tool_input: {
      title: 'bad title',
    },
  };

  if (!isCreatePullRequestTool(createPrTool.tool_name)) {
    throw new Error('known MCP create PR tool was not recognized');
  }

  if (!isUpdatePullRequestTool(updatePrTool.tool_name)) {
    throw new Error('known MCP update PR tool was not recognized');
  }

  if (validatePrMetadataUpdate(updatePrTool.tool_input).length === 0) {
    throw new Error('invalid update PR fixture unexpectedly passed');
  }

  if (isCreatePullRequestTool(nonPrTool.tool_name)) {
    throw new Error('non-PR tool was incorrectly recognized');
  }

  console.log('validate-pr-metadata self-test ok');
  return 0;
}

async function main() {
  if (process.argv.includes('--self-test')) {
    return runSelfTest();
  }

  if (process.argv.includes('--hook')) {
    return runHookMode();
  }

  const eventPath = getArgValue('--event-path');
  if (eventPath) {
    return runEventPathMode(eventPath);
  }

  const title = getArgValue('--title');
  const bodyFile = getArgValue('--body-file');
  if (title && bodyFile) {
    return runTitleBodyMode(title, bodyFile);
  }

  usage();
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = process.argv.includes('--hook') ? 2 : 1;
  });
