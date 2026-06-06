import type { CommandDescriptor } from '@agent-nexus/protocol';
import commandsConfig from './commands.config.json' with { type: 'json' };

interface AgentCommandDeclaration {
  localName: string;
  summary: string;
  dispatchMode?: 'queued' | 'immediate';
}

const declaredCommandDescriptors = (
  commandsConfig as AgentCommandDeclaration[]
).map((command): CommandDescriptor => ({
  canonicalId: `agent:claudecode:${command.localName}`,
  owner: { type: 'agent', agentOwner: 'claudecode' },
  localName: command.localName,
  summary: command.summary,
  options: [],
  handlerKey: command.localName,
  dispatchMode: command.dispatchMode,
  applicability: {
    requiredCapabilities: ['slash-command-registration'],
  },
  legacyNames: [],
}));

export const claudeCodeCommandDescriptors: readonly CommandDescriptor[] = [
  ...declaredCommandDescriptors,
];
