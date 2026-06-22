import { describe, expect, it } from 'vitest';
import { codexCommandDescriptors } from './command-descriptors.js';

describe('codexCommandDescriptors', () => {
  it('exposes package-declared agent command descriptors', () => {
    expect(codexCommandDescriptors).toEqual([
      expect.objectContaining({
        canonicalId: 'agent:codex:new',
        owner: { type: 'agent', agentOwner: 'codex' },
        localName: 'new',
        handlerKey: 'new',
        dispatchMode: 'queued',
        applicability: {
          requiredCapabilities: ['slash-command-registration'],
        },
        legacyNames: [],
      }),
      expect.objectContaining({
        canonicalId: 'agent:codex:stop',
        owner: { type: 'agent', agentOwner: 'codex' },
        localName: 'stop',
        handlerKey: 'stop',
        dispatchMode: 'immediate',
        applicability: {
          requiredCapabilities: ['slash-command-registration'],
        },
        legacyNames: [],
      }),
    ]);
  });
});
