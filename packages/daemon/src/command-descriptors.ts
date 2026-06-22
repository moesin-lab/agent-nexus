import type { CommandDescriptor } from '@agent-nexus/protocol';

export const daemonCommandDescriptors: readonly CommandDescriptor[] = [
  {
    canonicalId: 'daemon:kill',
    owner: { type: 'daemon' },
    localName: 'kill',
    summary: 'Terminate the current Nexus routing session',
    options: [],
    handlerKey: 'kill',
    applicability: {
      requiredCapabilities: ['slash-command-registration'],
    },
    legacyNames: [],
  },
  {
    canonicalId: 'daemon:reload-config',
    owner: { type: 'daemon' },
    localName: 'reload-config',
    summary: 'Reload config.json and apply runtime-safe fields',
    options: [],
    handlerKey: 'reload-config',
    applicability: {
      requiredCapabilities: ['slash-command-registration'],
    },
    legacyNames: [],
  },
];
