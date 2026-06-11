import { describe, expect, it } from 'vitest';
import { daemonCommandDescriptors } from './command-descriptors.js';

describe('daemonCommandDescriptors', () => {
  it('exposes daemon-owned operational command descriptors', () => {
    expect(daemonCommandDescriptors).toEqual([
      expect.objectContaining({
        canonicalId: 'daemon:kill',
        owner: { type: 'daemon' },
        localName: 'kill',
        handlerKey: 'kill',
        applicability: {
          requiredCapabilities: ['slash-command-registration'],
        },
        legacyNames: [],
      }),
      expect.objectContaining({
        canonicalId: 'daemon:reload-config',
        owner: { type: 'daemon' },
        localName: 'reload-config',
        handlerKey: 'reload-config',
        applicability: {
          requiredCapabilities: ['slash-command-registration'],
        },
        legacyNames: [],
      }),
    ]);
  });
});
