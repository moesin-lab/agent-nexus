import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  SERVER_REQUEST_METHODS_0_146,
  decideServerRequest,
} from './server-request-policy.js';

const active = { threadId: 'thr_1', turnId: 'turn_1', itemIds: ['item_1'] };

describe('decideServerRequest', () => {
  it('should_match_the_generated_codex_0_146_stable_server_request_snapshot', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL('../testdata/codex-0.146-server-request-methods.json', import.meta.url),
        'utf8',
      ),
    ) as { codexVersion: string; upstreamLicense: string; methods: string[] };

    expect(fixture).toMatchObject({ codexVersion: '0.146.0', upstreamLicense: 'Apache-2.0' });
    expect(SERVER_REQUEST_METHODS_0_146).toEqual(fixture.methods);
  });
  it('should_cover_every_server_request_method_in_codex_0_146_stable_schema', () => {
    expect(SERVER_REQUEST_METHODS_0_146).toEqual([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
      'item/permissions/requestApproval',
      'item/tool/call',
      'account/chatgptAuthTokens/refresh',
      'attestation/generate',
      'applyPatchApproval',
      'execCommandApproval',
    ]);
  });

  it.each([
    ['item/commandExecution/requestApproval', { decision: 'decline' }],
    ['item/fileChange/requestApproval', { decision: 'decline' }],
  ])('should_decline_%s_for_matching_turn', (method, result) => {
    expect(
      decideServerRequest(
        { id: 1, method, params: { ...active, itemId: 'item_1' } },
        active,
      ),
    ).toEqual({ response: { kind: 'result', result }, effect: 'wait-terminal' });
  });

  it.each(['execCommandApproval', 'applyPatchApproval'])(
    'should_deny_legacy_%s_without_granting_session_scope',
    (method) => {
      expect(
        decideServerRequest({
          id: 1,
          method,
          params: { conversationId: 'thr_1', callId: 'item_1' },
        }, active),
      ).toMatchObject({
        response: {
          kind: 'result',
          result: { decision: { denied: { rejection: expect.any(String) } } },
        },
        effect: 'wait-terminal',
      });
    },
  );

  it('should_cancel_mcp_elicitation_without_content', () => {
    expect(
      decideServerRequest(
        {
          id: 1,
          method: 'mcpServer/elicitation/request',
          params: {
            serverName: 'mcp-test',
            threadId: 'thr_1',
            turnId: 'turn_1',
            mode: 'form',
            message: 'input required',
            requestedSchema: { type: 'object', properties: {} },
          },
        },
        active,
      ),
    ).toEqual({
      response: {
        kind: 'result',
        result: { action: 'cancel', content: null, _meta: null },
      },
      effect: 'stop-protocol',
    });
  });

  it.each([
    [{ threadId: 'thr_1', turnId: 'turn_1', mode: 'form', message: 'x', requestedSchema: {} }, -32602],
    [{ serverName: 'mcp', threadId: 'other', turnId: 'turn_1', mode: 'form', message: 'x', requestedSchema: { type: 'object', properties: {} } }, -32003],
    [{ serverName: 'mcp', threadId: 'thr_1', turnId: 'other', mode: 'form', message: 'x', requestedSchema: { type: 'object', properties: {} } }, -32003],
  ])('should_fail_closed_on_invalid_or_foreign_mcp_elicitation_identity', (requestParams, code) => {
    expect(decideServerRequest({
      id: 1,
      method: 'mcpServer/elicitation/request',
      params: requestParams,
    }, active)).toMatchObject({ response: { kind: 'error', code }, effect: 'stop-protocol' });
  });

  it('should_cancel_an_owned_mcp_elicitation_with_nullable_turn_identity', () => {
    expect(decideServerRequest({
      id: 1,
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'mcp-test',
        threadId: 'thr_1',
        turnId: null,
        mode: 'url',
        message: 'open authentication',
        elicitationId: 'elicitation-1',
        url: 'https://example.invalid/',
      },
    }, active)).toMatchObject({ response: { kind: 'result' }, effect: 'stop-protocol' });
  });

  it('should_cancel_an_owned_mcp_elicitation_when_optional_turn_identity_is_absent', () => {
    expect(decideServerRequest({
      id: 1,
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'mcp-test',
        threadId: 'thr_1',
        mode: 'url',
        message: 'open authentication',
        elicitationId: 'elicitation-1',
        url: 'https://example.invalid/',
      },
    }, active)).toMatchObject({ response: { kind: 'result' }, effect: 'stop-protocol' });
  });

  it('should_fail_closed_when_form_mcp_elicitation_omits_the_snapshot_schema_shape', () => {
    expect(decideServerRequest({
      id: 1,
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'mcp-test',
        threadId: 'thr_1',
        turnId: null,
        mode: 'form',
        message: 'input required',
        requestedSchema: {},
      },
    }, active)).toMatchObject({
      response: { kind: 'error', code: -32602 },
      effect: 'stop-protocol',
    });
  });

  it.each([
    ['item/permissions/requestApproval', -32001],
    ['item/tool/requestUserInput', -32001],
    ['item/tool/call', -32601],
  ])('should_error_and_interrupt_%s', (method, code) => {
    expect(
      decideServerRequest(
        { id: 1, method, params: { ...active, itemId: 'item_1' } },
        active,
      ),
    ).toMatchObject({ response: { kind: 'error', code }, effect: 'interrupt' });
  });

  it.each(['execCommandApproval', 'applyPatchApproval'])(
    'should_fail_closed_when_legacy_%s_cannot_be_correlated_to_the_active_item',
    (method) => {
      expect(decideServerRequest({
        id: 1,
        method,
        params: { conversationId: 'thr_1', callId: 'item_foreign' },
      }, active)).toMatchObject({ response: { kind: 'error' }, effect: 'stop-protocol' });
    },
  );

  it('should_stop_with_auth_error_on_client_managed_token_refresh', () => {
    expect(
      decideServerRequest(
        { id: 1, method: 'account/chatgptAuthTokens/refresh', params: { reason: 'expired' } },
        active,
      ),
    ).toMatchObject({ response: { kind: 'error', code: -32002 }, effect: 'stop-auth' });
  });

  it('should_stop_with_protocol_error_when_attestation_arrives_despite_opt_out', () => {
    expect(
      decideServerRequest(
        { id: 1, method: 'attestation/generate', params: {} },
        active,
      ),
    ).toMatchObject({ response: { kind: 'error', code: -32601 }, effect: 'stop-protocol' });
  });

  it('should_fail_closed_when_thread_or_turn_ownership_does_not_match', () => {
    expect(
      decideServerRequest(
        {
          id: 1,
          method: 'item/fileChange/requestApproval',
          params: { threadId: 'other', turnId: 'turn_1', itemId: 'item_1' },
        },
        active,
      ),
    ).toMatchObject({ response: { kind: 'error' }, effect: 'stop-protocol' });
  });

  it.each([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
  ])('should_fail_closed_when_%s_references_an_unobserved_item', (method) => {
    expect(
      decideServerRequest(
        {
          id: 1,
          method,
          params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_foreign' },
        },
        active,
      ),
    ).toMatchObject({ response: { kind: 'error' }, effect: 'stop-protocol' });
  });

  it('should_error_and_stop_protocol_on_unknown_request', () => {
    expect(
      decideServerRequest({ id: 1, method: 'future/request', params: {} }, active),
    ).toMatchObject({ response: { kind: 'error', code: -32601 }, effect: 'stop-protocol' });
  });
});
