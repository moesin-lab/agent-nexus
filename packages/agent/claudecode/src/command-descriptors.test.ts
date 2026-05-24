import { describe, expect, it } from 'vitest';
import { claudeCodeCommandDescriptors } from './command-descriptors.js';

describe('claudeCodeCommandDescriptors', () => {
  it('exposes the platform-neutral /new command descriptor', () => {
    expect(claudeCodeCommandDescriptors).toEqual([
      expect.objectContaining({
        canonicalId: 'agent:claudecode:new',
        owner: { type: 'agent', agentOwner: 'claudecode' },
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
