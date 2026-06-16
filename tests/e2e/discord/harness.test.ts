import { describe, expect, it } from 'vitest';
import type { SessionKey } from '../../../packages/protocol/src/index.js';
import {
  createDiscordE2EHarness,
  scriptedTextReply,
} from './harness.js';

describe('Discord E2E harness', () => {
  it('should_drive_fake_discord_input_through_engine_to_outbound_when_scripted_agent_replies', async () => {
    const harness = createDiscordE2EHarness({
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
    const harness = createDiscordE2EHarness({
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
    const harness = createDiscordE2EHarness({
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
});
