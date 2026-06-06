#!/usr/bin/env node

const defaultRequiredChecks = ['check', 'pr-metadata'];
const defaultDelayMs = [5_000, 10_000, 15_000, 20_000, 30_000, 45_000];
const terminalFailureConclusions = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
]);
const successConclusions = new Set(['success', 'neutral', 'skipped']);

function usage() {
  console.error(`Usage:
  scripts/posttool-pr-check-guard.mjs
  scripts/posttool-pr-check-guard.mjs --self-test

Hook mode reads PostToolUse JSON from stdin. For local testing, set:
  POSTTOOL_PR_CHECK_REQUIRED=check,pr-metadata
  POSTTOOL_PR_CHECK_TIMEOUT_MS=600000
  POSTTOOL_PR_CHECK_REPO=owner/name
  GITHUB_TOKEN=<token>`);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsv(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPrWriteTool(toolName) {
  return (
    toolName === 'mcp__codex_apps__github._create_pull_request' ||
    toolName === 'mcp__codex_apps__github._update_pull_request' ||
    toolName === 'mcp__github__create_pull_request' ||
    toolName === 'mcp__github__update_pull_request' ||
    toolName === 'mcp__github__.create_pull_request' ||
    toolName === 'mcp__github__.update_pull_request' ||
    (toolName.includes('github') &&
      (toolName.includes('create_pull_request') || toolName.includes('update_pull_request')))
  );
}

function findValueDeep(value, predicate, seen = new Set()) {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  if (predicate(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValueDeep(item, predicate, seen);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  for (const item of Object.values(value)) {
    const found = findValueDeep(item, predicate, seen);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function findStringDeep(value, keys) {
  const keySet = new Set(keys);
  const found = findValueDeep(value, (candidate) => {
    for (const [key, item] of Object.entries(candidate)) {
      if (keySet.has(key) && typeof item === 'string' && item.length > 0) {
        return true;
      }
    }
    return false;
  });

  if (!found) {
    return undefined;
  }

  for (const key of keys) {
    if (typeof found[key] === 'string' && found[key].length > 0) {
      return found[key];
    }
  }

  return undefined;
}

function findNumberDeep(value, keys) {
  const keySet = new Set(keys);
  const found = findValueDeep(value, (candidate) => {
    for (const [key, item] of Object.entries(candidate)) {
      if (keySet.has(key) && Number.isInteger(item)) {
        return true;
      }
    }
    return false;
  });

  if (!found) {
    return undefined;
  }

  for (const key of keys) {
    if (Number.isInteger(found[key])) {
      return found[key];
    }
  }

  return undefined;
}

function findRepo(input) {
  const fromEnv = process.env.POSTTOOL_PR_CHECK_REPO || process.env.GITHUB_REPOSITORY;
  if (fromEnv) {
    return fromEnv;
  }

  const exact =
    input.tool_input?.repository_full_name ||
    input.tool_input?.repo_full_name ||
    input.tool_result?.repository_full_name ||
    input.tool_response?.repository_full_name ||
    input.result?.repository_full_name;
  if (typeof exact === 'string' && exact.includes('/')) {
    return exact;
  }

  const found = findStringDeep(input, ['repository_full_name', 'repo_full_name', 'full_name']);
  if (found?.includes('/')) {
    return found;
  }

  return undefined;
}

function findPrNumber(input) {
  const fromEnv = parsePositiveInt(process.env.POSTTOOL_PR_CHECK_PR_NUMBER, 0);
  if (fromEnv) {
    return fromEnv;
  }

  const exact =
    input.tool_result?.number ||
    input.tool_response?.number ||
    input.result?.number ||
    input.tool_result?.pr_number ||
    input.tool_response?.pr_number ||
    input.result?.pr_number;
  if (Number.isInteger(exact)) {
    return exact;
  }

  return findNumberDeep(input, ['number', 'pr_number', 'pull_number', 'pullRequestNumber']);
}

function findHeadSha(input) {
  return (
    process.env.POSTTOOL_PR_CHECK_HEAD_SHA ||
    input.tool_result?.head_sha ||
    input.tool_response?.head_sha ||
    input.result?.head_sha ||
    findStringDeep(input, ['head_sha', 'headSha', 'sha'])
  );
}

async function githubGet(path, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agent-nexus-posttool-pr-check-guard',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(`https://api.github.com${path}`, { headers });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
    throw new Error(`GitHub API request failed for ${path}${cause}`);
  }
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text };
  }

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${path}: ${json.message || text}`);
  }

  return json;
}

async function fetchPullRequest(repo, prNumber, token) {
  return githubGet(`/repos/${repo}/pulls/${prNumber}`, token);
}

async function fetchCheckRuns(repo, ref, token) {
  const encodedRef = encodeURIComponent(ref);
  const result = await githubGet(`/repos/${repo}/commits/${encodedRef}/check-runs?per_page=100`, token);
  return result.check_runs || [];
}

function summarizeRequiredChecks(checkRuns, requiredChecks) {
  const byName = new Map(checkRuns.map((run) => [run.name, run]));
  const success = [];
  const pending = [];
  const failed = [];

  for (const name of requiredChecks) {
    const run = byName.get(name);
    if (!run) {
      pending.push({ name, status: 'expected', conclusion: 'not_reported' });
      continue;
    }

    if (run.status === 'completed') {
      if (successConclusions.has(run.conclusion)) {
        success.push({ name, status: run.status, conclusion: run.conclusion });
      } else if (terminalFailureConclusions.has(run.conclusion)) {
        failed.push({ name, status: run.status, conclusion: run.conclusion });
      } else {
        pending.push({ name, status: run.status, conclusion: run.conclusion || 'unknown' });
      }
    } else {
      pending.push({ name, status: run.status, conclusion: run.conclusion || 'pending' });
    }
  }

  return { success, pending, failed };
}

function formatCheckList(title, checks) {
  if (checks.length === 0) {
    return '';
  }

  return `${title}\n${checks
    .map((check) => `- ${check.name}: ${check.status}${check.conclusion ? ` / ${check.conclusion}` : ''}`)
    .join('\n')}`;
}

function printNotReady({ prNumber, elapsedMs, failed, pending, timedOut }) {
  const headline = timedOut
    ? `[posttool-pr-check-guard] PR #${prNumber} checks still pending after ${Math.round(elapsedMs / 1000)}s.`
    : `[posttool-pr-check-guard] PR #${prNumber} checks are not ready.`;

  const sections = [
    headline,
    formatCheckList('\nFailed checks:', failed),
    formatCheckList('\nPending checks:', pending),
    '\nDo not report this PR as ready. Tell the user the PR exists but checks are failed/pending.',
  ].filter(Boolean);

  console.error(sections.join('\n'));
}

function nextDelayMs(attempt, schedule, maxDelayMs) {
  return schedule[Math.min(attempt, schedule.length - 1)] ?? maxDelayMs;
}

async function pollRequiredChecks({ repo, prNumber, headSha, requiredChecks, timeoutMs, delayMs, maxDelayMs, token }) {
  const start = Date.now();
  let attempt = 0;
  let ref = headSha;
  let lastSummary = { success: [], pending: [], failed: [] };

  while (Date.now() - start <= timeoutMs) {
    if (!ref) {
      const pr = await fetchPullRequest(repo, prNumber, token);
      ref = pr.head?.sha;
    }

    if (!ref) {
      throw new Error(`Could not determine head SHA for PR #${prNumber}.`);
    }

    const checkRuns = await fetchCheckRuns(repo, ref, token);
    lastSummary = summarizeRequiredChecks(checkRuns, requiredChecks);

    if (lastSummary.failed.length > 0) {
      printNotReady({ prNumber, elapsedMs: Date.now() - start, ...lastSummary, timedOut: false });
      return 2;
    }

    if (lastSummary.pending.length === 0) {
      console.error(`[posttool-pr-check-guard] PR #${prNumber} required checks passed: ${requiredChecks.join(', ')}`);
      return 0;
    }

    const waitMs = Math.min(nextDelayMs(attempt, delayMs, maxDelayMs), Math.max(timeoutMs - (Date.now() - start), 0));
    if (waitMs <= 0) {
      break;
    }

    await sleep(waitMs);
    attempt += 1;
  }

  printNotReady({ prNumber, elapsedMs: Date.now() - start, ...lastSummary, timedOut: true });
  return 2;
}

async function runHookMode() {
  const inputText = await readStdin();
  let input;
  try {
    input = JSON.parse(inputText || '{}');
  } catch (error) {
    console.error(
      `[posttool-pr-check-guard] invalid hook JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  const toolName = input.tool_name || '';
  if (!isPrWriteTool(toolName)) {
    return 0;
  }

  const repo = findRepo(input);
  const prNumber = findPrNumber(input);
  const headSha = findHeadSha(input);

  if (!repo) {
    console.error('[posttool-pr-check-guard] could not determine repository_full_name from hook input.');
    return 2;
  }

  if (!prNumber) {
    console.error('[posttool-pr-check-guard] could not determine PR number from hook input.');
    return 2;
  }

  const requiredChecks = parseCsv(process.env.POSTTOOL_PR_CHECK_REQUIRED, defaultRequiredChecks);
  const timeoutMs = parsePositiveInt(process.env.POSTTOOL_PR_CHECK_TIMEOUT_MS, 10 * 60_000);
  const maxDelayMs = parsePositiveInt(process.env.POSTTOOL_PR_CHECK_MAX_DELAY_MS, 60_000);
  const delayMs = parseCsv(process.env.POSTTOOL_PR_CHECK_DELAYS_MS, defaultDelayMs.map(String)).map((value) =>
    parsePositiveInt(value, 5_000),
  );
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  return pollRequiredChecks({
    repo,
    prNumber,
    headSha,
    requiredChecks,
    timeoutMs,
    delayMs,
    maxDelayMs,
    token,
  });
}

async function runSelfTest() {
  if (!isPrWriteTool('mcp__codex_apps__github._create_pull_request')) {
    throw new Error('create pull request tool was not recognized');
  }

  if (!isPrWriteTool('mcp__codex_apps__github._update_pull_request')) {
    throw new Error('update pull request tool was not recognized');
  }

  if (isPrWriteTool('Read')) {
    throw new Error('non-PR tool was incorrectly recognized');
  }

  const summary = summarizeRequiredChecks(
    [
      { name: 'check', status: 'completed', conclusion: 'success' },
      { name: 'pr-metadata', status: 'queued', conclusion: null },
      { name: 'lint', status: 'completed', conclusion: 'failure' },
    ],
    ['check', 'pr-metadata', 'lint', 'missing'],
  );

  if (summary.success.length !== 1 || summary.pending.length !== 2 || summary.failed.length !== 1) {
    throw new Error(`unexpected check summary: ${JSON.stringify(summary)}`);
  }

  const input = {
    tool_name: 'mcp__codex_apps__github._create_pull_request',
    tool_input: { repository_full_name: 'moesin-lab/agent-nexus' },
    tool_response: { number: 136, head_sha: 'abc123' },
  };

  if (findRepo(input) !== 'moesin-lab/agent-nexus') {
    throw new Error('repo extraction failed');
  }

  if (findPrNumber(input) !== 136) {
    throw new Error('PR number extraction failed');
  }

  if (findHeadSha(input) !== 'abc123') {
    throw new Error('head SHA extraction failed');
  }

  console.log('posttool-pr-check-guard self-test ok');
  return 0;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return 0;
  }

  if (process.argv.includes('--self-test')) {
    return runSelfTest();
  }

  return runHookMode();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
