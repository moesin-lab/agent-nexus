import type { CommandDescriptor } from '@agent-nexus/protocol';

export const claudeCodeCommandDescriptors: readonly CommandDescriptor[] = [
  {
    canonicalId: 'agent:claudecode:new',
    owner: { type: 'agent', agentOwner: 'claudecode' },
    localName: 'new',
    summary: 'Start a new Claude Code conversation',
    options: [],
    handlerKey: 'new',
    applicability: {
      requiredCapabilities: ['slash-command-registration'],
    },
    legacyNames: [],
  },
];
