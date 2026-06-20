export type { PlatformSessionKey, SessionKey } from './session-key.js';
export {
  serializePlatformSessionKey,
  serializeSessionKey,
  withPlatformName,
} from './session-key.js';

export type {
  Attachment,
  ComponentInteractionPayload,
  EventType,
  Initiator,
  NormalizedEvent,
} from './events.js';

export type {
  CapabilitySet,
  MessageComponent,
  MessageRef,
  OutboundMessage,
} from './outbound.js';

export type {
  PlatformSettingsActionInput,
  PlatformSettingsActionResult,
  PlatformSettingsSnapshot,
  PlatformSettingsSnapshotInput,
  SettingsDurability,
  SettingsSnapshotItem,
} from './settings.js';

export type {
  ActiveCommandMap,
  AgentCommandEnvelope,
  AgentCommandResult,
  AgentCommandDispatchMode,
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
  CommandRegistrationError,
  CommandRegistrationErrorCode,
  CommandRegistrationPlan,
  CommandRegistrationPort,
  CommandRegistrationResult,
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
  CreateThreadInput,
  CreateThreadResult,
  UpdateThreadInput,
  AgentEventHandler,
  EventCommandResponse,
  EventModalResponse,
  AgentRuntime,
  EventHandler,
  EventHandlerResult,
  PlatformAdapter,
} from './interfaces.js';
