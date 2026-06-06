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
];
