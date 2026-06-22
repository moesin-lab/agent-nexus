import { existsSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionKey } from '../../../packages/protocol/src/index.js';
import {
  createDiscordE2EHarness,
  scriptedTextReply,
} from './harness.js';

type DiscordE2EHarness = ReturnType<typeof createDiscordE2EHarness>;

const harnesses: DiscordE2EHarness[] = [];

function makeHarness(
  options: Parameters<typeof createDiscordE2EHarness>[0],
): DiscordE2EHarness {
  const harness = createDiscordE2EHarness(options);
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  const pending = harnesses.splice(0);
  await Promise.all(
    pending.map(async (harness) => {
      try {
        await harness.stop();
      } catch {
        // Best-effort cleanup only; the test's own assertion failure should remain primary.
      }
    }),
  );
});

function allowOnlyOwner() {
  return {
    allowlist: {
      userIds: ['U-e2e-owner'],
      roleIds: [],
      allowedGuildIds: [],
      allowedChannelIds: [],
      allowDM: true,
      requireMentionOrSlash: true,
    },
  };
}

describe('Discord E2E harness', () => {
  it('should_drive_fake_discord_input_through_engine_to_outbound_when_scripted_agent_replies', async () => {
    const harness = makeHarness({
      agentEvents: scriptedTextReply('pong from agent'),
    });

    await harness.start();
    const inbound = await harness.injectMessage('hello from discord');

    const outbound = await harness.waitForOutbound(
      (entry) => entry.message.text === 'pong from agent',
    );

    expect(harness.agent.inputs).toHaveLength(1);
    expect(harness.agent.inputs[0]?.input.text).toBe('hello from discord');
    expect(harness.agent.inputs[0]?.session.key).toEqual<SessionKey>({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'C-e2e-main',
      initiatorUserId: 'U-e2e-owner',
    });
    expect(outbound.sessionKey).toEqual(harness.agent.inputs[0]?.session.key);
    expect(outbound.message.traceId).toBe(inbound.traceId);

    expect(harness.transcript.events.map((event) => event.kind)).toContain(
      'inbound',
    );
    expect(harness.transcript.events.map((event) => event.kind)).toContain(
      'outbound_send',
    );
    expect(harness.transcript.events.at(-1)).toMatchObject({
      kind: 'assertion',
      passed: true,
    });

    await harness.stop();
  });

  it('should_resolve_waitForOutbound_when_wait_starts_before_message_is_injected', async () => {
    const harness = makeHarness({
      agentEvents: scriptedTextReply('async pong'),
    });

    await harness.start();
    const outboundPromise = harness.waitForOutbound(
      (entry) => entry.message.text === 'async pong',
    );

    await harness.injectMessage('hello after waiter');

    await expect(outboundPromise).resolves.toMatchObject({
      kind: 'outbound_send',
      message: { text: 'async pong' },
    });
    expect(
      harness.transcript.events.some(
        (event) => event.kind === 'assertion' && event.passed,
      ),
    ).toBe(true);

    await harness.stop();
  });

  it('should_reject_waitForOutbound_when_no_new_outbound_matches_before_timeout', async () => {
    const harness = makeHarness({
      agentEvents: scriptedTextReply('single pong'),
    });

    await harness.start();
    await harness.injectMessage('hello once');

    await expect(
      harness.waitForOutbound((entry) => entry.message.text === 'single pong'),
    ).resolves.toMatchObject({
      kind: 'outbound_send',
      message: { text: 'single pong' },
    });

    await expect(
      harness.waitForOutbound((entry) => entry.message.text === 'single pong', 1),
    ).rejects.toThrow('no outbound matched within 1ms');
    expect(harness.transcript.events.at(-1)).toMatchObject({
      kind: 'assertion',
      passed: false,
    });

    await harness.stop();
  });

  it('should_write_failed_transcript_artifact_when_wait_for_outbound_times_out', async () => {
    const harness = makeHarness({
      caseId: 'artifact-timeout-case',
      agentEvents: scriptedTextReply('artifact pong'),
    });

    await harness.start();
    await harness.injectMessage('artifact input', {
      traceId: 'artifact-trace',
    });

    let thrown: Error | undefined;
    try {
      await harness.waitForOutbound(
        (entry) => entry.message.text === 'missing text',
        1,
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain('caseId=artifact-timeout-case');
    expect(thrown?.message).toContain('traceIds=artifact-trace');
    expect(thrown?.message).toContain('transcript=');
    const artifactPath = thrown?.message.match(/transcript=([^;\s]+)/)?.[1];
    expect(artifactPath).toBeTruthy();
    expect(existsSync(artifactPath!)).toBe(true);

    const artifact = JSON.parse(readFileSync(artifactPath!, 'utf8')) as {
      caseId: string;
      status: string;
      failure: { message: string };
      events: Array<{ kind: string; traceId?: string; passed?: boolean }>;
      assertions: Array<{ kind: string; passed: boolean }>;
    };
    expect(artifact.caseId).toBe('artifact-timeout-case');
    expect(artifact.status).toBe('failed');
    expect(artifact.failure.message).toContain(
      'no outbound matched within 1ms',
    );
    expect(artifact.events.some((event) => event.kind === 'inbound')).toBe(true);
    expect(
      artifact.events.some((event) => event.kind === 'agent_event'),
    ).toBe(true);
    expect(
      artifact.events.some((event) => event.kind === 'outbound_send'),
    ).toBe(true);
    expect(
      artifact.assertions.some((event) => event.passed === false),
    ).toBe(true);

    const rootDir = harness.paths.rootDir;
    await harness.stop();
    expect(existsSync(rootDir)).toBe(true);
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('should_expose_tmpdir_paths_and_remove_them_on_stop_by_default', async () => {
    const harness = makeHarness({
      agentEvents: scriptedTextReply('pong'),
    });

    expect(existsSync(harness.paths.rootDir)).toBe(true);
    expect(existsSync(harness.paths.workingDir)).toBe(true);
    expect(existsSync(harness.paths.stateDir)).toBe(true);
    expect(existsSync(harness.paths.transcriptDir)).toBe(true);

    const rootDir = harness.paths.rootDir;
    await harness.start();
    await harness.stop();

    expect(existsSync(rootDir)).toBe(false);
  });

  it('should_write_passed_transcript_artifact_when_keep_artifacts_is_enabled', async () => {
    const harness = makeHarness({
      caseId: 'artifact-passed-case',
      keepArtifacts: true,
      agentEvents: scriptedTextReply('kept pong'),
    });

    await harness.start();
    await harness.injectMessage('keep transcript', {
      traceId: 'artifact-pass-trace',
    });
    await harness.waitForOutbound(
      (entry) => entry.message.text === 'kept pong',
    );

    const rootDir = harness.paths.rootDir;
    const artifactPath = harness.transcript.artifactPath;
    await harness.stop();

    expect(artifactPath).toBeTruthy();
    expect(existsSync(rootDir)).toBe(true);
    expect(existsSync(artifactPath!)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath!, 'utf8')) as {
      caseId: string;
      status: string;
      events: Array<{ kind: string; traceId?: string }>;
    };
    expect(artifact.caseId).toBe('artifact-passed-case');
    expect(artifact.status).toBe('passed');
    expect(
      artifact.events.some((event) => event.traceId === 'artifact-pass-trace'),
    ).toBe(true);
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('should_respect_keep_artifacts_environment_variable', async () => {
    const previous = process.env.AGENT_NEXUS_E2E_KEEP_ARTIFACTS;
    process.env.AGENT_NEXUS_E2E_KEEP_ARTIFACTS = '1';
    const harness = makeHarness({
      caseId: 'artifact-env-case',
      agentEvents: scriptedTextReply('env pong'),
    });
    try {
      await harness.start();
      await harness.injectMessage('env keep transcript');
      await harness.waitForOutbound((entry) => entry.message.text === 'env pong');

      const rootDir = harness.paths.rootDir;
      const artifactPath = harness.transcript.artifactPath;
      await harness.stop();

      expect(existsSync(rootDir)).toBe(true);
      expect(existsSync(artifactPath!)).toBe(true);
      rmSync(rootDir, { recursive: true, force: true });
    } finally {
      if (previous === undefined) {
        delete process.env.AGENT_NEXUS_E2E_KEEP_ARTIFACTS;
      } else {
        process.env.AGENT_NEXUS_E2E_KEEP_ARTIFACTS = previous;
      }
    }
  });

  it('should_wait_for_agent_event_and_turn_finished_when_waiters_start_before_injection', async () => {
    const harness = makeHarness({
      agentEvents: scriptedTextReply('event pong'),
    });

    await harness.start();
    const textFinalPromise = harness.waitForAgentEvent(
      (event) => event.eventType === 'text_final',
    );
    const turnFinishedPromise = harness.waitForTurnFinished('e2e-trace-1');

    await harness.injectMessage('hello event waiters');

    await expect(textFinalPromise).resolves.toMatchObject({
      kind: 'agent_event',
      eventType: 'text_final',
      traceId: 'e2e-trace-1',
    });
    await expect(turnFinishedPromise).resolves.toMatchObject({
      kind: 'agent_event',
      eventType: 'turn_finished',
      traceId: 'e2e-trace-1',
    });

    await harness.stop();
  });

  it('should_support_event_overrides_and_waitForNoAgentCall_for_auth_denied_paths', async () => {
    const harness = makeHarness({
      platformAuth: allowOnlyOwner(),
      agentEvents: scriptedTextReply('should not run'),
    });

    await harness.start();
    const inbound = await harness.injectMessage('blocked user', {
      initiatorUserId: 'U-e2e-denied',
      traceId: 'blocked-trace',
    });

    await harness.waitForNoAgentCall(10);

    expect(inbound.traceId).toBe('blocked-trace');
    expect(harness.agent.inputs).toHaveLength(0);
    expect(
      harness.transcript.events.some(
        (event) => event.kind === 'assertion' && event.passed,
      ),
    ).toBe(true);

    await harness.stop();
  });

  it('should_reject_waitForNoAgentCall_when_agent_was_already_called', async () => {
    const harness = makeHarness({
      agentEvents: scriptedTextReply('already called'),
    });

    await harness.start();
    await harness.injectMessage('hello before no-call assertion');

    await expect(harness.waitForNoAgentCall(1)).rejects.toThrow(
      'expected 0 agent inputs, got 1',
    );
    expect(harness.transcript.events.at(-1)).toMatchObject({
      kind: 'assertion',
      passed: false,
    });

    await harness.stop();
  });
});
