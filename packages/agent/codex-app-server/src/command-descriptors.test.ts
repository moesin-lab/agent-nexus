import { describe, expect, it } from 'vitest';
import { codexAppServerCommandDescriptors } from './command-descriptors.js';

describe('codexAppServerCommandDescriptors', () => {
  it('should_own_new_and_stop_under_the_distinct_persistent_backend_id', () => {
    expect(codexAppServerCommandDescriptors).toEqual([
      expect.objectContaining({
        canonicalId: 'agent:codex-app-server:new',
        owner: { type: 'agent', agentOwner: 'codex-app-server' },
        handlerKey: 'new',
      }),
      expect.objectContaining({
        canonicalId: 'agent:codex-app-server:stop',
        owner: { type: 'agent', agentOwner: 'codex-app-server' },
        handlerKey: 'stop',
      }),
      expect.objectContaining({
        canonicalId: 'agent:codex-app-server:status',
        owner: { type: 'agent', agentOwner: 'codex-app-server' },
        handlerKey: 'status',
      }),
    ]);
  });
});
