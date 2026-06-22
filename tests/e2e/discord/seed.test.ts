import { afterEach, describe, expect, it } from 'vitest';
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
});
