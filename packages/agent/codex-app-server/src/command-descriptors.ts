import type { CommandDescriptor } from '@agent-nexus/protocol';

export const codexAppServerCommandDescriptors: readonly CommandDescriptor[] = [
  {
    canonicalId: 'agent:codex-app-server:new',
    owner: { type: 'agent', agentOwner: 'codex-app-server' },
    localName: 'new',
    summary: 'Start a new persistent Codex conversation',
    options: [],
    handlerKey: 'new',
    dispatchMode: 'immediate',
    applicability: { requiredCapabilities: ['slash-command-registration'] },
    legacyNames: [],
  },
  {
    canonicalId: 'agent:codex-app-server:stop',
    owner: { type: 'agent', agentOwner: 'codex-app-server' },
    localName: 'stop',
    summary: 'Interrupt the active Codex turn',
    options: [],
    handlerKey: 'stop',
    dispatchMode: 'immediate',
    applicability: { requiredCapabilities: ['slash-command-registration'] },
    legacyNames: [],
  },
  {
    canonicalId: 'agent:codex-app-server:status',
    owner: { type: 'agent', agentOwner: 'codex-app-server' },
    localName: 'status',
    summary: 'Show the persistent Codex session status',
    options: [],
    handlerKey: 'status',
    dispatchMode: 'immediate',
    applicability: { requiredCapabilities: ['slash-command-registration'] },
    legacyNames: [],
  },
];
