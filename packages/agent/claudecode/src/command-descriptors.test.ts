import { describe, expect, it } from 'vitest';
import { claudeCodeCommandDescriptors } from './command-descriptors.js';

describe('claudeCodeCommandDescriptors', () => {
  it('exposes package-declared agent command descriptors', () => {
    expect(claudeCodeCommandDescriptors).toEqual([
      expect.objectContaining({
        canonicalId: 'agent:claudecode:new',
        owner: { type: 'agent', agentOwner: 'claudecode' },
        localName: 'new',
        handlerKey: 'new',
        dispatchMode: 'queued',
        applicability: {
          requiredCapabilities: ['slash-command-registration'],
        },
        legacyNames: [],
      }),
      expect.objectContaining({
        canonicalId: 'agent:claudecode:stop',
        owner: { type: 'agent', agentOwner: 'claudecode' },
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
