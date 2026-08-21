import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ExperimentalTmuxTerminalSessionHost } from '@agent-nexus/daemon';
import { createDefaultCodexAppServerEngineFactory } from '../src/default-engine.ts';
import { CodexRemoteViewerAdapter } from '../src/remote-viewer.ts';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};

const PROCESS_FIXTURE = [
  "const nonce = process.argv[1]",
  "process.stdout.write(`READY ${nonce} ${process.pid}\\n`)",
  "setInterval(() => process.stdout.write(`TICK ${nonce}\\n`), 100)",
].join(';');

const persistenceRoot = required('AGENT_NEXUS_E2E_PERSISTENCE_ROOT');
const terminalRoot = required('AGENT_NEXUS_E2E_TERMINAL_ROOT');
const workingDir = required('AGENT_NEXUS_E2E_WORKING_DIR');
const sourceCodexHome = required('AGENT_NEXUS_E2E_SOURCE_CODEX_HOME');
const terminalHost = new ExperimentalTmuxTerminalSessionHost({ rootDir: terminalRoot });
const viewerAdapter = new CodexRemoteViewerAdapter({
  terminalHost,
  pollIntervalMs: 100,
});
const factory = createDefaultCodexAppServerEngineFactory({
  sourceCodexHome,
  persistenceRoot,
  agentName: 'real-codex-crash-worker',
  clientVersion: '0.1.0-crash-e2e',
  environment: process.env,
  viewerAdapter,
});
const engine = factory({
  key: {
    platformName: 'real-crash-e2e',
    platform: 'lark',
    channelId: 'chat-before-crash',
    initiatorUserId: 'user-crash',
  },
  sessionConfig: {
    sessionId: 'real-crash-session',
    workingDir,
    timeoutMs: 120_000,
  },
  backendConfig: {
    bin: process.env.CODEX_BIN || 'codex',
    workingDir,
    sandbox: 'read-only',
    addDirs: [],
    maxInputBytes: 262_144,
    requestTimeoutMs: 30_000,
    interruptGraceMs: 5_000,
    terminateGraceMs: 5_000,
    conversationRetentionMs: null,
    supplementalViewer: { enabled: true },
  },
});

const started = await engine.start();
const seeded = await engine.runTurn(
  'Reply with exactly REAL_CRASH_BEFORE_OK_731 and nothing else.',
  'real-crash-before-message',
);
if (seeded.status !== 'completed' || !seeded.text.includes('REAL_CRASH_BEFORE_OK_731')) {
  throw new Error('crash worker seed turn did not complete');
}
const processNonce = 'REAL_CRASH_PROCESS_OK_731';
const liveProcess = await engine.startProcess({
  argv: [process.execPath, '-e', PROCESS_FIXTURE, processNonce],
});
const processReady = await waitForProcessText(
  liveProcess.handle,
  `READY ${processNonce}`,
);
const processMatch = new RegExp(`READY ${processNonce} (\\d+)`).exec(processReady);
if (!processMatch) throw new Error('crash worker process PID is missing');
const processPid = Number(processMatch[1]);
const registry = JSON.parse(await readFile(join(persistenceRoot, 'registry.json'), 'utf8'));
const record = registry.records.find((candidate) => candidate.threadId === started.threadId);
if (!record) throw new Error('crash worker registry record is missing');
const runtimeRoot = join(
  persistenceRoot,
  'homes',
  record.homeId,
  'agent-nexus-runtime',
);
let metadata;
for (const entry of await readdir(runtimeRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    metadata = JSON.parse(await readFile(
      join(runtimeRoot, entry.name, 'codex-remote-viewer-owner.json'),
      'utf8',
    ));
    break;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
if (!metadata) throw new Error('crash worker viewer metadata is missing');
const viewerPgid = await waitForProcessGroupId(
  join(terminalRoot, `child-${metadata.terminal.sessionId}.pid`),
);
process.stdout.write(`${JSON.stringify({
  threadId: started.threadId,
  appServerPgid: started.pid,
  processHandle: liveProcess.handle,
  processPid,
  viewerPgid,
  tokenFile: metadata.tokenFile,
})}\n`);

// The parent deliberately SIGKILLs this worker. No graceful handler is allowed:
// the test must exercise registry lease recovery and anonymous-pipe supervision.
setInterval(() => {}, 60_000);

async function waitForProcessText(handle, expected) {
  const deadline = Date.now() + 10_000;
  let cursor = 0;
  let text = '';
  while (Date.now() < deadline) {
    const page = engine.readProcessOutput({ handle, cursor });
    for (const chunk of page.chunks) {
      text += Buffer.from(chunk.dataBase64, 'base64').toString('utf8');
    }
    cursor = page.nextCursor;
    if (text.includes(expected)) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`crash worker process output did not contain ${expected}`);
}

async function waitForProcessGroupId(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (
        value &&
        typeof value === 'object' &&
        Number.isSafeInteger(value.pid) &&
        value.pid > 0 &&
        typeof value.identity === 'string' &&
        value.identity.length > 0
      ) {
        return value.pid;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('crash worker viewer process identity did not become ready');
}
