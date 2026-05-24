export type { PlatformSessionKey, SessionKey } from './session-key.js';
export {
  serializePlatformSessionKey,
  serializeSessionKey,
  withPlatformName,
} from './session-key.js';

export type {
  Attachment,
  EventType,
  Initiator,
  NormalizedEvent,
} from './events.js';

export type {
  CapabilitySet,
  MessageRef,
  OutboundMessage,
} from './outbound.js';

export type {
  ActiveCommandMap,
  CommandAliasKind,
  CommandApplicability,
  CommandArgValue,
  CommandCanonicalId,
  CommandChoice,
  CommandDescriptor,
  CommandOption,
  CommandOptionType,
  CommandOwner,
  CommandPayload,
  CommandRegistrationPlan,
  CommandRegistrationScope,
  CommandRequiredCapability,
  CommandReverseMap,
  CommandRoute,
  LegacyCommandName,
  NativeCommandScope,
  PlannedCommand,
} from './command.js';

export type {
  AgentEvent,
  AgentCapabilitySet,
  AgentInput,
  AgentSession,
  AgentSessionState,
  ContentBlock,
  SessionConfig,
  ToolCallStatus,
  ToolResultContent,
  TurnEndReason,
  UsageRecord,
} from './agent.js';

export type {
  AgentEventHandler,
  AgentRuntime,
  EventHandler,
  PlatformAdapter,
} from './interfaces.js';
