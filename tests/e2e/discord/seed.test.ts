import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../packages/protocol/src/index.js';
import type { TrajectorySegment } from '../../../packages/daemon/src/trajectory-store.js';
import {
  createDiscordE2EHarness,
  scriptedTextReply,
  type TranscriptEvent,
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
        // Best-effort cleanup only; keep the original test failure primary.
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

function outboundSends(events: TranscriptEvent[]) {
  return events.filter((event) => event.kind === 'outbound_send');
}

function loadExpectedTrajectoryFixture() {
  const fixturePath = fileURLToPath(
    new URL(
      '../../../testdata/trajectory/e2e/discord_runtime_read_model.expected.json',
      import.meta.url,
    ),
  );
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
}

function trajectoryAgentEvents(): AgentEvent[] {
  const timestamp = new Date('2026-06-23T10:30:00.000Z');
  return [
    {
      type: 'session_started',
      traceId: 'seed-trajectory-trace',
      timestamp,
      sequence: 1,
      payload: {
        agentSessionId: 'scripted-trajectory-session',
        workingDir: '/home/node/trajectory-secret-workdir',
        capabilities: {
          supportsThinking: true,
          supportsStreaming: false,
          supportsToolCallEvents: true,
          supportsInterrupt: false,
          supportsStdinInterrupt: false,
        },
      },
    },
    {
      type: 'thinking',
      traceId: 'seed-trajectory-trace',
      timestamp,
      sequence: 2,
      payload: {
        text: 'thinking with ANTHROPIC_API_KEY=sk-ant-thinking-secret',
      },
    },
    {
      type: 'tool_call_started',
      traceId: 'seed-trajectory-trace',
      timestamp,
      sequence: 3,
      payload: {
        callId: 'tool-1',
        toolName: 'Read',
        inputSummary: '/home/node/private/input.txt',
      },
    },
    {
      type: 'tool_result',
      traceId: 'seed-trajectory-trace',
      timestamp,
      sequence: 4,
      payload: {
        callId: 'tool-1',
        resultSequence: 1,
        content: {
          kind: 'text',
          text: 'result contains DISCORD_TOKEN=MTksecret and /home/node/private/output.txt',
        },
        isError: false,
      },
    },
    {
      type: 'usage',
      traceId: 'seed-trajectory-trace',
      timestamp,
      sequence: 5,
      payload: {
        model: 'scripted-model',
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
        turnSequence: 1,
        toolCallsThisTurn: 1,
        wallClockMs: 25,
        completeness: 'partial',
      },
    },
    {
      type: 'text_final',
      traceId: 'seed-trajectory-trace',
      timestamp,
      sequence: 6,
      payload: {
        text: 'trajectory final answer',
      },
    },
    {
      type: 'turn_finished',
      traceId: 'seed-trajectory-trace',
      timestamp,
      sequence: 7,
      payload: {
        reason: 'stop',
        turnSequence: 1,
      },
    },
  ];
}

function normalizeTrajectorySegments(segments: TrajectorySegment[]) {
  const firstSessionId = segments[0]?.sessionId;
  return segments.map((segment) => {
    const metadata = JSON.parse(segment.metadataJson) as Record<string, unknown>;
    return {
      source: segment.source,
      kind: segment.kind,
      sequence: segment.sequence,
      traceId: segment.traceId,
      turnSequence: segment.turnSequence,
      summary: segment.summary,
      confidence: segment.confidence,
      redactionState: segment.redactionState,
      sameSession: segment.sessionId === firstSessionId,
      usageEventId: segment.usageEventId
        ? segment.usageEventId.replace(`${segment.sessionId}:`, '')
        : undefined,
      metadata: {
        eventId: metadata['eventId'],
        messageId: metadata['messageId'],
        eventType: metadata['eventType'],
        agentEventSequence: metadata['agentEventSequence'],
        sessionKey: metadata['sessionKey'],
        agentName: metadata['agentName'],
        toolName: metadata['toolName'],
        callId: metadata['callId'],
        resultSequence: metadata['resultSequence'],
        contentKind: metadata['contentKind'],
        usageModel:
          typeof metadata['usage'] === 'object' &&
          metadata['usage'] !== null &&
          !Array.isArray(metadata['usage'])
            ? (metadata['usage'] as Record<string, unknown>)['model']
            : undefined,
        usageCompleteness:
          typeof metadata['usage'] === 'object' &&
          metadata['usage'] !== null &&
          !Array.isArray(metadata['usage'])
            ? (metadata['usage'] as Record<string, unknown>)['completeness']
            : undefined,
        reason: metadata['reason'],
        workingDir: metadata['workingDir'],
      },
    };
  });
}

describe('Discord E2E seed cases', () => {
  it('seed_happy_path_should_route_allowed_message_to_agent_and_send_reply', async () => {
    const harness = makeHarness({
      agentEvents: scriptedTextReply('seed happy reply'),
    });

    await harness.start();
    const inbound = await harness.injectMessage('seed happy input');
    const outbound = await harness.waitForOutbound(
      (entry) => entry.message.text === 'seed happy reply',
    );

    expect(harness.agent.inputs).toHaveLength(1);
    expect(harness.agent.inputs[0]?.input.text).toBe('seed happy input');
    expect(outbound.message.traceId).toBe(inbound.traceId);
    expect(outbound.sessionKey.platformName).toBe('discord-main');
  });

  it('seed_auth_denied_should_not_call_agent_or_send_agent_outbound', async () => {
    const harness = makeHarness({
      platformAuth: allowOnlyOwner(),
      agentEvents: scriptedTextReply('must not be sent'),
    });

    await harness.start();
    await harness.injectMessage('denied input', {
      initiatorUserId: 'U-e2e-denied',
      traceId: 'seed-auth-denied',
    });

    await harness.waitForNoAgentCall(10);
    expect(outboundSends(harness.transcript.events)).toHaveLength(0);
  });

  it('seed_idempotency_replay_should_process_same_session_message_only_once', async () => {
    const harness = makeHarness({
      agentEvents: scriptedTextReply('idempotent reply'),
    });

    await harness.start();
    await harness.injectMessage('dedupe me', {
      eventId: 'seed-idem-event-1',
      messageId: 'seed-idem-message',
      traceId: 'seed-idem-trace-1',
    });
    await harness.waitForOutbound(
      (entry) => entry.message.text === 'idempotent reply',
    );

    await harness.injectMessage('dedupe me replay', {
      eventId: 'seed-idem-event-2',
      messageId: 'seed-idem-message',
      traceId: 'seed-idem-trace-2',
    });

    await harness.waitForNoAgentCall(10, 1);
    expect(harness.agent.inputs).toHaveLength(1);
    expect(outboundSends(harness.transcript.events)).toHaveLength(1);
  });

  it('seed_long_output_slicing_should_split_by_fake_platform_max_text_length', async () => {
    const text = 'abcdefghijkl';
    const harness = makeHarness({
      platformCaps: { maxTextLength: 5 },
      agentEvents: scriptedTextReply(text),
    });

    await harness.start();
    await harness.injectMessage('long output please');
    await harness.waitForTurnFinished('e2e-trace-1');

    const sends = outboundSends(harness.transcript.events);
    expect(sends.map((send) => send.message.text)).toEqual([
      'abcde',
      'fghij',
      'kl',
    ]);
    expect(sends.map((send) => send.message.text).join('')).toBe(text);
    expect(sends.every((send) => send.message.text.length <= 5)).toBe(true);
  });

  it('seed_redaction_should_filter_secrets_and_absolute_paths_before_outbound', async () => {
    const harness = makeHarness({
      agentEvents: scriptedTextReply(
        'ANTHROPIC_API_KEY=sk-ant-abc123 path=/home/node/secret/file.txt',
      ),
    });

    await harness.start();
    await harness.injectMessage('redact output please');
    const outbound = await harness.waitForOutbound(
      (entry) => entry.kind === 'outbound_send',
    );

    expect(outbound.message.text).not.toContain('sk-ant-abc123');
    expect(outbound.message.text).not.toContain('/home/node/secret');
    expect(outbound.message.text).toContain('ANTHROPIC_API_KEY=<redacted>');
    expect(outbound.message.text).toContain('~/secret/file.txt');
  });

  it('seed_trajectory_read_model_should_persist_runtime_events_to_sqlite_fixture', async () => {
    const harness = makeHarness({
      caseId: 'seed-trajectory-read-model',
      trajectory: { enabled: true },
      agentEvents: trajectoryAgentEvents,
    });

    await harness.start();
    await harness.injectMessage(
      'trajectory input ANTHROPIC_API_KEY=sk-ant-input-secret path=/home/node/private/prompt.txt',
      {
        eventId: 'seed-trajectory-event',
        messageId: 'seed-trajectory-message',
        traceId: 'seed-trajectory-trace',
        receivedAt: new Date('2026-06-23T10:29:59.000Z'),
      },
    );
    await harness.waitForTurnFinished('seed-trajectory-trace');

    const page = harness.queryTrajectory({
      source: 'nexus-agent-event',
      limit: 20,
    });
    expect(page.segments).toHaveLength(8);
    expect(page.segments.at(-1)).toMatchObject({
      kind: 'state-change',
      summary: 'turn finished: stop',
    });
    expect(new Set(page.segments.map((segment) => segment.sessionId)).size).toBe(
      1,
    );
    expect(page.segments[0]?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(JSON.stringify(page.segments)).not.toContain('sk-ant');
    expect(JSON.stringify(page.segments)).not.toContain('MTk');
    expect(JSON.stringify(page.segments)).not.toContain('/home/node/private');
    expect(JSON.stringify(page.segments)).not.toContain(
      '/home/node/trajectory-secret-workdir',
    );

    expect(normalizeTrajectorySegments(page.segments)).toEqual(
      loadExpectedTrajectoryFixture(),
    );
  });
});
