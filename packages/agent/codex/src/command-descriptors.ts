import type { CommandDescriptor } from '@agent-nexus/protocol';

export const codexCommandDescriptors: readonly CommandDescriptor[] = [
  {
    canonicalId: 'agent:codex:new',
    owner: { type: 'agent', agentOwner: 'codex' },
    localName: 'new',
    summary: 'Start a new Codex conversation',
    options: [],
    handlerKey: 'new',
    applicability: {
      requiredCapabilities: ['slash-command-registration'],
    },
    legacyNames: [],
  },
];
