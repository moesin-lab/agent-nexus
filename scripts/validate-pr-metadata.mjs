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

Adds PR metadata validation.

本 PR：
- Adds validation.

## Why

Keep PR descriptions complete.

ADR: N/A - repository metadata check only.
Spec: N/A - no runtime contract change.

## Test plan

- [x] Tests: self-test.
- [x] \`node scripts/validate-pr-metadata.mjs --self-test\` - passed.

## Review notes

- Independent agent review: N/A - self-test fixture.
- Deep review: N/A - no architecture change.

## Out of scope

- Merge automation.
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
