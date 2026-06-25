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
  {
    canonicalId: 'daemon:sessions',
    owner: { type: 'daemon' },
    localName: 'sessions',
    summary: 'List resumable Nexus routing sessions',
    options: [],
    handlerKey: 'sessions',
    applicability: {
      requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
    },
    legacyNames: [],
  },
  {
    canonicalId: 'daemon:external-sessions',
    owner: { type: 'daemon' },
    localName: 'external-sessions',
    summary: 'Discover external agent sessions',
    options: [],
    handlerKey: 'external-sessions',
    applicability: {
      requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
    },
    legacyNames: [],
  },
  {
    canonicalId: 'daemon:new-thread',
    owner: { type: 'daemon' },
    localName: 'new-thread',
    summary: 'Create a Discord thread for a new Nexus routing session',
    options: [
      {
        name: 'title',
        type: 'string',
        required: false,
        description: 'Optional thread title',
        choices: [],
      },
    ],
    handlerKey: 'new-thread',
    applicability: {
      requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
    },
    legacyNames: [],
  },
  {
    canonicalId: 'daemon:working-dir',
    owner: { type: 'daemon' },
    localName: 'working-dir',
    summary: 'Set the working directory for the next Nexus routing session',
    options: [
      {
        name: 'path',
        type: 'string',
        required: true,
        description: 'Absolute working directory path',
        choices: [],
      },
      {
        name: 'scope',
        type: 'string',
        required: false,
        description: 'Apply to channel default or next session override',
        choices: [
          { name: 'channel', value: 'channel' },
          { name: 'session', value: 'session' },
        ],
      },
    ],
    handlerKey: 'working-dir',
    applicability: {
      requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
    },
    legacyNames: [],
  },
  {
    canonicalId: 'daemon:settings',
    owner: { type: 'daemon' },
    localName: 'settings',
    summary: 'Show Nexus settings for this Discord channel',
    options: [],
    handlerKey: 'settings',
    applicability: {
      requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
    },
    legacyNames: [],
  },
  {
    canonicalId: 'daemon:queue',
    owner: { type: 'daemon' },
    localName: 'queue',
    summary: 'Manage the current Nexus queue',
    options: [
      {
        name: 'action',
        type: 'string',
        required: false,
        description: 'Queue action',
        choices: [
          { name: 'status', value: 'status' },
          { name: 'clear', value: 'clear' },
          { name: 'next', value: 'next' },
        ],
      },
    ],
    handlerKey: 'queue',
    applicability: {
      requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
    },
    legacyNames: [],
  },
];
