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
      expect.objectContaining({
        canonicalId: 'daemon:sessions',
        owner: { type: 'daemon' },
        localName: 'sessions',
        handlerKey: 'sessions',
        applicability: {
          requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
        },
        legacyNames: [],
      }),
      expect.objectContaining({
        canonicalId: 'daemon:external-sessions',
        owner: { type: 'daemon' },
        localName: 'external-sessions',
        handlerKey: 'external-sessions',
        applicability: {
          requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
        },
        legacyNames: [],
      }),
      expect.objectContaining({
        canonicalId: 'daemon:new-thread',
        owner: { type: 'daemon' },
        localName: 'new-thread',
        handlerKey: 'new-thread',
        applicability: {
          requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
        },
        legacyNames: [],
      }),
      expect.objectContaining({
        canonicalId: 'daemon:working-dir',
        owner: { type: 'daemon' },
        localName: 'working-dir',
        handlerKey: 'working-dir',
        options: expect.arrayContaining([
          expect.objectContaining({
            name: 'scope',
            choices: [
              { name: 'channel', value: 'channel' },
              { name: 'session', value: 'session' },
            ],
          }),
        ]),
        applicability: {
          requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
        },
        legacyNames: [],
      }),
      expect.objectContaining({
        canonicalId: 'daemon:settings',
        owner: { type: 'daemon' },
        localName: 'settings',
        handlerKey: 'settings',
        applicability: {
          requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
        },
        legacyNames: [],
      }),
      expect.objectContaining({
        canonicalId: 'daemon:queue',
        owner: { type: 'daemon' },
        localName: 'queue',
        handlerKey: 'queue',
        options: expect.arrayContaining([
          expect.objectContaining({
            name: 'action',
            choices: [
              { name: 'status', value: 'status' },
              { name: 'clear', value: 'clear' },
              { name: 'next', value: 'next' },
            ],
          }),
        ]),
        applicability: {
          requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
        },
        legacyNames: [],
      }),
    ]);
  });
});
