import { describe, expect, it } from 'vitest';
import { codexCommandDescriptors } from './command-descriptors.js';

describe('codexCommandDescriptors', () => {
  it('exposes the platform-neutral /new command descriptor', () => {
    expect(codexCommandDescriptors).toEqual([
      expect.objectContaining({
        canonicalId: 'agent:codex:new',
        owner: { type: 'agent', agentOwner: 'codex' },
        localName: 'new',
        handlerKey: 'new',
        applicability: {
          requiredCapabilities: ['slash-command-registration'],
        },
        legacyNames: [],
      }),
    ]);
  });
});
