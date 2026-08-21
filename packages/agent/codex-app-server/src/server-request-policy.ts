export const SERVER_REQUEST_METHODS_0_146 = [
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
] as const;

export interface ActiveTurnIdentity {
  threadId: string;
  turnId: string;
  itemIds: readonly string[];
}

export type ServerRequestEffect =
  | 'wait-terminal'
  | 'interrupt'
  | 'stop-auth'
  | 'stop-protocol';

export type ServerRequestDecision = {
  response:
    | { kind: 'result'; result: unknown }
    | { kind: 'error'; code: number; message: string };
  effect: ServerRequestEffect;
};

interface RequestFrame {
  id: number | string;
  method: string;
  params: unknown;
}

const error = (
  code: number,
  message: string,
  effect: ServerRequestEffect,
): ServerRequestDecision => ({ response: { kind: 'error', code, message }, effect });

function params(frame: RequestFrame): Record<string, unknown> | null {
  return frame.params && typeof frame.params === 'object' && !Array.isArray(frame.params)
    ? (frame.params as Record<string, unknown>)
    : null;
}

function ownsTurn(frame: RequestFrame, active: ActiveTurnIdentity): boolean {
  const value = params(frame);
  return value?.['threadId'] === active.threadId && value['turnId'] === active.turnId;
}

function ownsItem(frame: RequestFrame, active: ActiveTurnIdentity): boolean {
  if (!ownsTurn(frame, active)) return false;
  const itemId = params(frame)?.['itemId'];
  return typeof itemId === 'string' && active.itemIds.includes(itemId);
}

function ownsLegacyCall(frame: RequestFrame, active: ActiveTurnIdentity): boolean {
  const value = params(frame);
  return (
    value?.['conversationId'] === active.threadId &&
    typeof value['callId'] === 'string' &&
    active.itemIds.includes(value['callId'])
  );
}

function ownershipFailure(): ServerRequestDecision {
  return error(-32003, 'server request ownership mismatch', 'stop-protocol');
}

export function decideServerRequest(
  frame: RequestFrame,
  active: ActiveTurnIdentity | null,
): ServerRequestDecision {
  switch (frame.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      if (!active || !ownsItem(frame, active)) return ownershipFailure();
      return {
        response: { kind: 'result', result: { decision: 'decline' } },
        effect: 'wait-terminal',
      };

    case 'execCommandApproval':
    case 'applyPatchApproval':
      if (!active || !ownsLegacyCall(frame, active)) return ownershipFailure();
      return {
        response: {
          kind: 'result',
          result: {
            decision: {
              denied: { rejection: 'agent-nexus approval broker disabled' },
            },
          },
        },
        effect: 'wait-terminal',
      };

    case 'mcpServer/elicitation/request': {
      if (!active) return ownershipFailure();
      const value = params(frame);
      if (
        !value ||
        typeof value['serverName'] !== 'string' ||
        value['serverName'].length === 0 ||
        typeof value['threadId'] !== 'string' ||
        (value['turnId'] !== undefined &&
          value['turnId'] !== null &&
          typeof value['turnId'] !== 'string') ||
        typeof value['message'] !== 'string' ||
        !validMcpElicitationShape(value)
      ) {
        return error(-32602, 'invalid mcp elicitation params', 'stop-protocol');
      }
      if (
        value['threadId'] !== active.threadId ||
        (typeof value['turnId'] === 'string' && value['turnId'] !== active.turnId)
      ) {
        return ownershipFailure();
      }
      return {
        response: {
          kind: 'result',
          result: { action: 'cancel', content: null, _meta: null },
        },
        effect: 'stop-protocol',
      };
    }

    case 'item/permissions/requestApproval':
    case 'item/tool/requestUserInput':
      if (!active || !ownsItem(frame, active)) return ownershipFailure();
      return error(-32001, 'interactive request broker disabled', 'interrupt');

    case 'item/tool/call':
      if (!active || !ownsTurn(frame, active)) return ownershipFailure();
      return error(-32601, 'dynamic tool call disabled', 'interrupt');

    case 'account/chatgptAuthTokens/refresh':
      return error(-32002, 'client-managed auth token refresh disabled', 'stop-auth');

    case 'attestation/generate':
      return error(-32601, 'attestation disabled', 'stop-protocol');

    default:
      return error(-32601, 'unsupported server request', 'stop-protocol');
  }
}

function validMcpElicitationShape(value: Record<string, unknown>): boolean {
  if (value['mode'] === 'form') {
    const requestedSchema = value['requestedSchema'];
    if (!requestedSchema || typeof requestedSchema !== 'object' || Array.isArray(requestedSchema)) {
      return false;
    }
    const schema = requestedSchema as Record<string, unknown>;
    const properties = schema['properties'];
    return (
      schema['type'] === 'object' &&
      properties !== null &&
      typeof properties === 'object' &&
      !Array.isArray(properties)
    );
  }
  if (value['mode'] === 'openai/form') {
    return Object.prototype.hasOwnProperty.call(value, 'requestedSchema');
  }
  return (
    value['mode'] === 'url' &&
    typeof value['elicitationId'] === 'string' &&
    value['elicitationId'].length > 0 &&
    typeof value['url'] === 'string' &&
    value['url'].length > 0
  );
}
