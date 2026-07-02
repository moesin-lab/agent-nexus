#!/usr/bin/env node

const defaultRequiredChecks = ['check', 'pr-metadata'];
const defaultDelayMs = [5_000, 10_000, 15_000, 20_000, 30_000, 45_000];
const defaultRequestTimeoutMs = 30_000;
const mcpProtocolVersion = '2025-06-18';
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
  POSTTOOL_PR_CHECK_REQUEST_TIMEOUT_MS=30000
  POSTTOOL_PR_CHECK_SOURCE=auto|mcp|github-api
  MCP_GITHUB_URL=http://mcp-gateway:8080/servers/github/mcp
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

function resolveCheckSource(env = process.env) {
  const requested = (env.POSTTOOL_PR_CHECK_SOURCE || 'auto').trim().toLowerCase();
  if (requested === 'mcp' || requested === 'github-api') {
    return requested;
  }
  if (requested !== 'auto') {
    throw new Error(
      `Invalid POSTTOOL_PR_CHECK_SOURCE=${env.POSTTOOL_PR_CHECK_SOURCE}; expected auto, mcp, or github-api.`,
    );
  }
  return env.MCP_GITHUB_URL ? 'mcp' : 'github-api';
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

function requestSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function shortText(text, maxLength = 500) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function requestErrorCause(error) {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return ': request timed out';
  }
  if (error instanceof Error && error.cause instanceof Error) {
    return `: ${error.cause.message}`;
  }
  return '';
}

async function githubGet(path, token, requestTimeoutMs = defaultRequestTimeoutMs) {
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
    response = await fetch(`https://api.github.com${path}`, { headers, signal: requestSignal(requestTimeoutMs) });
  } catch (error) {
    throw new Error(`GitHub API request failed for ${path}${requestErrorCause(error)}`);
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

async function fetchPullRequest(repo, prNumber, token, requestTimeoutMs) {
  return githubGet(`/repos/${repo}/pulls/${prNumber}`, token, requestTimeoutMs);
}

async function fetchCheckRuns(repo, ref, token, requestTimeoutMs) {
  const encodedRef = encodeURIComponent(ref);
  const result = await githubGet(
    `/repos/${repo}/commits/${encodedRef}/check-runs?per_page=100`,
    token,
    requestTimeoutMs,
  );
  return result.check_runs || [];
}

function repoParts(repo) {
  const [owner, name, ...rest] = repo.split('/');
  if (!owner || !name || rest.length > 0) {
    throw new Error(`Expected repository in owner/name form, got: ${repo}`);
  }
  return { owner, name };
}

function parseSseMessages(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const messages = [];
  for (const eventBlock of trimmed.split(/\r?\n\r?\n/)) {
    const dataLines = [];
    for (const line of eventBlock.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    messages.push(JSON.parse(dataLines.join('\n')));
  }
  return messages;
}

function parseMcpHttpBody(text, expectedId) {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed);
    if (expectedId !== undefined && json.id !== expectedId) {
      throw new Error(`MCP response id mismatch: expected ${expectedId}, got ${json.id ?? 'none'}.`);
    }
    return json;
  }

  const messages = parseSseMessages(trimmed);
  if (expectedId === undefined) {
    return messages.find((message) => !message.method) ?? messages[0];
  }

  const matching = messages.find((message) => message.id === expectedId);
  if (matching) {
    return matching;
  }

  const summary = messages.map((message) => message.method || `id:${message.id ?? 'none'}`).join(', ');
  throw new Error(`MCP response did not contain JSON-RPC id ${expectedId}; received: ${summary || 'none'}.`);
}

function mcpHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function mcpPost(url, payload, { sessionId, protocolVersion, requestTimeoutMs, expectedId } = {}) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }
  if (protocolVersion) {
    headers['MCP-Protocol-Version'] = protocolVersion;
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: requestSignal(requestTimeoutMs ?? defaultRequestTimeoutMs),
    });
  } catch (error) {
    throw new Error(`MCP request failed for ${payload.method || 'notification'}${requestErrorCause(error)}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw mcpHttpError(
      `MCP HTTP ${response.status} for ${payload.method || 'notification'} at ${new URL(url).host}: ${
        shortText(text) || response.statusText
      }`,
      response.status,
    );
  }

  const json = parseMcpHttpBody(text, expectedId);
  if (json?.error) {
    throw new Error(`MCP ${payload.method || 'notification'} error: ${json.error.message || JSON.stringify(json.error)}`);
  }

  return { json, sessionId: response.headers.get('mcp-session-id') || sessionId };
}

async function createMcpSession(url, requestTimeoutMs) {
  if (!url) {
    throw new Error('POSTTOOL_PR_CHECK_SOURCE=mcp requires MCP_GITHUB_URL.');
  }

  const initialized = await mcpPost(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: mcpProtocolVersion,
      capabilities: {},
      clientInfo: {
        name: 'agent-nexus-posttool-pr-check-guard',
        version: '0.0.0',
      },
    },
  }, { requestTimeoutMs, expectedId: 1 });

  const sessionId = initialized.sessionId;
  const protocolVersion = initialized.json?.result?.protocolVersion || mcpProtocolVersion;

  await mcpPost(
    url,
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    },
    { sessionId, protocolVersion, requestTimeoutMs },
  );

  return { url, sessionId, protocolVersion, requestTimeoutMs, nextId: 2 };
}

async function mcpCallTool(session, name, args) {
  const id = session.nextId;
  session.nextId += 1;
  const { json } = await mcpPost(
    session.url,
    {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    },
    {
      sessionId: session.sessionId,
      protocolVersion: session.protocolVersion,
      requestTimeoutMs: session.requestTimeoutMs,
      expectedId: id,
    },
  );
  return json;
}

function parseMcpToolJsonContent(response, label) {
  const result = response?.result;
  if (!result) {
    throw new Error(`MCP ${label} response did not contain a result.`);
  }
  if (result.isError) {
    const message = result.content?.map((item) => item.text).filter(Boolean).join('\n') || 'unknown tool error';
    throw new Error(`MCP ${label} returned tool error: ${message}`);
  }

  const text = result.content?.find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
  if (!text) {
    throw new Error(`MCP ${label} response did not contain JSON text content.`);
  }

  return JSON.parse(text);
}

async function mcpFetchPullRequest(repo, prNumber, session) {
  const { owner, name } = repoParts(repo);
  return parseMcpToolJsonContent(
    await mcpCallTool(session, 'pull_request_read', {
      method: 'get',
      owner,
      repo: name,
      pullNumber: prNumber,
    }),
    'pull_request_read.get',
  );
}

async function mcpFetchCheckRuns(repo, prNumber, session, expectedHeadSha) {
  const { owner, name } = repoParts(repo);
  const result = parseMcpToolJsonContent(
    await mcpCallTool(session, 'pull_request_read', {
      method: 'get_check_runs',
      owner,
      repo: name,
      pullNumber: prNumber,
      perPage: 100,
    }),
    'pull_request_read.get_check_runs',
  );
  const checkRuns = result.check_runs || [];
  if (expectedHeadSha) {
    const mismatchedHeadSha = mismatchedCheckRunHeadSha(checkRuns, expectedHeadSha);
    if (mismatchedHeadSha) {
      throw new Error(
        `MCP check run head SHA mismatch for #${prNumber}: expected ${expectedHeadSha}, got ${mismatchedHeadSha}.`,
      );
    }
    if (!checkRuns.some((run) => typeof run.head_sha === 'string' && run.head_sha.length > 0)) {
      const pr = await mcpFetchPullRequest(repo, prNumber, session);
      if (pr.head?.sha !== expectedHeadSha) {
        throw new Error(
          `MCP PR head SHA mismatch for #${prNumber}: expected ${expectedHeadSha}, got ${pr.head?.sha || 'unknown'}.`,
        );
      }
    }
  }
  return checkRuns;
}

function mismatchedCheckRunHeadSha(checkRuns, expectedHeadSha) {
  for (const run of checkRuns) {
    if (typeof run.head_sha === 'string' && run.head_sha.length > 0 && run.head_sha !== expectedHeadSha) {
      return run.head_sha;
    }
  }
  return undefined;
}

function isRetryableMcpError(error) {
  return error?.status === 404 || (error instanceof Error && error.message.startsWith('MCP request failed for '));
}

async function createMcpCheckSourceClient(mcpUrl, requestTimeoutMs) {
  let session = await createMcpSession(mcpUrl, requestTimeoutMs);
  const withRetry = async (operation) => {
    try {
      return await operation(session);
    } catch (error) {
      if (!isRetryableMcpError(error)) {
        throw error;
      }
      session = await createMcpSession(mcpUrl, requestTimeoutMs);
      return operation(session);
    }
  };

  return {
    source: 'mcp',
    fetchPullRequest: (repo, prNumber) => withRetry((activeSession) => mcpFetchPullRequest(repo, prNumber, activeSession)),
    fetchCheckRuns: (repo, ref, prNumber) =>
      withRetry((activeSession) => mcpFetchCheckRuns(repo, prNumber, activeSession, ref)),
  };
}

async function createCheckSourceClient(source, { mcpUrl, token, requestTimeoutMs, allowMcpFallback }) {
  if (source === 'mcp') {
    try {
      return await createMcpCheckSourceClient(mcpUrl, requestTimeoutMs);
    } catch (error) {
      if (!allowMcpFallback) {
        throw error;
      }
      console.error(
        `[posttool-pr-check-guard] MCP check source unavailable, falling back to github-api: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    source: 'github-api',
    fetchPullRequest: (repo, prNumber) => fetchPullRequest(repo, prNumber, token, requestTimeoutMs),
    fetchCheckRuns: (repo, ref) => fetchCheckRuns(repo, ref, token, requestTimeoutMs),
  };
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

async function pollRequiredChecks({
  repo,
  prNumber,
  headSha,
  requiredChecks,
  timeoutMs,
  delayMs,
  maxDelayMs,
  checkSource,
  mcpUrl,
  requestTimeoutMs,
  allowMcpFallback,
  token,
}) {
  const start = Date.now();
  let attempt = 0;
  let ref = headSha;
  let lastSummary = { success: [], pending: [], failed: [] };
  const client = await createCheckSourceClient(checkSource, {
    mcpUrl,
    token,
    requestTimeoutMs,
    allowMcpFallback,
  });

  while (Date.now() - start <= timeoutMs) {
    if (!ref && client.source === 'github-api') {
      const pr = await client.fetchPullRequest(repo, prNumber);
      ref = pr.head?.sha;
    }

    if (!ref && client.source === 'github-api') {
      throw new Error(`Could not determine head SHA for PR #${prNumber}.`);
    }

    const checkRuns = await client.fetchCheckRuns(repo, ref, prNumber);
    lastSummary = summarizeRequiredChecks(checkRuns, requiredChecks);

    if (lastSummary.failed.length > 0) {
      printNotReady({ prNumber, elapsedMs: Date.now() - start, ...lastSummary, timedOut: false });
      return 2;
    }

    if (lastSummary.pending.length === 0) {
      console.error(
        `[posttool-pr-check-guard] PR #${prNumber} required checks passed via ${client.source}: ${requiredChecks.join(', ')}`,
      );
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
  const requestTimeoutMs = parsePositiveInt(process.env.POSTTOOL_PR_CHECK_REQUEST_TIMEOUT_MS, defaultRequestTimeoutMs);
  const maxDelayMs = parsePositiveInt(process.env.POSTTOOL_PR_CHECK_MAX_DELAY_MS, 60_000);
  const delayMs = parseCsv(process.env.POSTTOOL_PR_CHECK_DELAYS_MS, defaultDelayMs.map(String)).map((value) =>
    parsePositiveInt(value, 5_000),
  );
  const checkSource = resolveCheckSource(process.env);
  const requestedCheckSource = (process.env.POSTTOOL_PR_CHECK_SOURCE || 'auto').trim().toLowerCase();
  const mcpUrl = process.env.MCP_GITHUB_URL;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  return pollRequiredChecks({
    repo,
    prNumber,
    headSha,
    requiredChecks,
    timeoutMs,
    delayMs,
    maxDelayMs,
    checkSource,
    mcpUrl,
    requestTimeoutMs,
    allowMcpFallback: requestedCheckSource === 'auto' && checkSource === 'mcp',
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

  const mcpSource = resolveCheckSource({
    POSTTOOL_PR_CHECK_SOURCE: 'mcp',
    MCP_GITHUB_URL: 'http://mcp-gateway:8080/servers/github/mcp',
  });
  if (mcpSource !== 'mcp') {
    throw new Error(`forced MCP check source was not selected: ${mcpSource}`);
  }

  const autoMcpSource = resolveCheckSource({
    MCP_GITHUB_URL: 'http://mcp-gateway:8080/servers/github/mcp',
  });
  if (autoMcpSource !== 'mcp') {
    throw new Error(`auto mode did not prefer MCP when MCP_GITHUB_URL is set: ${autoMcpSource}`);
  }

  const autoRestSource = resolveCheckSource({});
  if (autoRestSource !== 'github-api') {
    throw new Error(`auto mode without MCP_GITHUB_URL did not choose github-api: ${autoRestSource}`);
  }

  try {
    resolveCheckSource({ POSTTOOL_PR_CHECK_SOURCE: 'bad-source' });
    throw new Error('invalid check source did not throw');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Invalid POSTTOOL_PR_CHECK_SOURCE')) {
      throw error;
    }
  }

  const sseResponse = parseMcpHttpBody(
    [
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}',
      '',
    ].join('\n'),
    7,
  );
  if (!sseResponse?.result?.ok) {
    throw new Error(`SSE response did not select the matching JSON-RPC id: ${JSON.stringify(sseResponse)}`);
  }

  const multilineSseResponse = parseMcpHttpBody(
    ['event: message', 'data: {"jsonrpc":"2.0",', 'data: "id":8,"result":{"ok":true}}', ''].join('\n'),
    8,
  );
  if (!multilineSseResponse?.result?.ok) {
    throw new Error(`multiline SSE data was not joined correctly: ${JSON.stringify(multilineSseResponse)}`);
  }

  try {
    parseMcpToolJsonContent(
      {
        result: {
          content: [{ type: 'text', text: 'permission denied' }],
          isError: true,
        },
      },
      'pull_request_read.get_check_runs',
    );
    throw new Error('MCP tool error did not throw');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('returned tool error')) {
      throw error;
    }
  }

  const mcpRuns = parseMcpToolJsonContent(
    {
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              check_runs: [
                { name: 'check', status: 'completed', conclusion: 'success' },
                { name: 'pr-metadata', status: 'queued', conclusion: null },
              ],
            }),
          },
        ],
        isError: false,
      },
    },
    'pull_request_read.get_check_runs',
  ).check_runs;
  const mcpSummary = summarizeRequiredChecks(mcpRuns, ['check', 'pr-metadata']);
  if (mcpSummary.success.length !== 1 || mcpSummary.pending.length !== 1 || mcpSummary.failed.length !== 0) {
    throw new Error(`unexpected MCP check summary: ${JSON.stringify(mcpSummary)}`);
  }

  const mismatchedHeadSha = mismatchedCheckRunHeadSha([{ head_sha: 'def456' }], 'abc123');
  if (mismatchedHeadSha !== 'def456') {
    throw new Error(`expected mismatched check run head sha, got ${mismatchedHeadSha}`);
  }

  const missingHeadSha = mismatchedCheckRunHeadSha([{ name: 'check' }], 'abc123');
  if (missingHeadSha !== undefined) {
    throw new Error(`missing check run head sha should not be treated as mismatch, got ${missingHeadSha}`);
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
