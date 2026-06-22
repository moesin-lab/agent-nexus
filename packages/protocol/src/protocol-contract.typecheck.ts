import type {
  Attachment,
  CapabilitySet,
  CreateThreadInput,
  EventHandlerResult,
  EventModalResponse,
  InteractionPayload,
  MessageComponent,
  NormalizedEvent,
  OutboundMessage,
  PlatformAdapter,
  PlatformSettingsActionInput,
  PlatformSettingsActionResult,
  PlatformSettingsSnapshot,
  PlatformSettingsSnapshotInput,
  ReactionPayload,
} from './index.js';

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
type Not<T extends boolean> = T extends true ? false : true;

type InteractionEvent = Extract<NormalizedEvent, { type: 'interaction' }>;
type CommandEvent = Extract<NormalizedEvent, { type: 'command' }>;
type MessageEventCase = Extract<NormalizedEvent, { type: 'message' }>;
type ReactionEvent = Extract<NormalizedEvent, { type: 'reaction' }>;
type ControlEvent = Extract<NormalizedEvent, { type: 'control' }>;
type TypingStartEvent = Extract<NormalizedEvent, { type: 'typing_start' }>;
type ButtonComponent = Extract<MessageComponent, { type: 'button' }>;
type SelectComponent = Extract<MessageComponent, { type: 'select' }>;
type ModalInput = EventModalResponse['inputs'][number];

type _InteractionPayloadMatchesSpec = Expect<
  Equal<
    InteractionPayload,
    {
      componentId: string;
      kind: 'button' | 'select' | 'modal_submit';
      values: string[];
    }
  >
>;
type _ReactionPayloadMatchesSpec = Expect<
  Equal<
    ReactionPayload,
    {
      emoji: string;
      action: 'add' | 'remove';
      targetMessageId: string;
    }
  >
>;
type _InteractionPayloadDoesNotExposeCustomId = Expect<
  Not<HasKey<InteractionPayload, 'customId'>>
>;
type _InteractionPayloadDoesNotExposeComponentType = Expect<
  Not<HasKey<InteractionPayload, 'componentType'>>
>;

type _InteractionEventRequiresInteractionPayload = Expect<
  Equal<InteractionEvent['interaction'], InteractionPayload>
>;
type _InteractionEventExcludesMessageContent = Expect<
  Equal<[InteractionEvent['text'], InteractionEvent['attachments']], [undefined, undefined]>
>;
type _InteractionEventExcludesCommandPayload = Expect<
  Equal<InteractionEvent['command'], undefined>
>;
type _CommandEventRequiresCommandPayload = Expect<
  Equal<CommandEvent['command'], NonNullable<CommandEvent['command']>>
>;
type _CommandEventExcludesMessageContent = Expect<
  Equal<[CommandEvent['text'], CommandEvent['attachments']], [undefined, undefined]>
>;
type _CommandEventExcludesInteractionPayload = Expect<
  Equal<CommandEvent['interaction'], undefined>
>;
type _MessageEventExcludesStructuredPayloads = Expect<
  Equal<
    [
      MessageEventCase['command'],
      MessageEventCase['interaction'],
      MessageEventCase['reaction'],
    ],
    [undefined, undefined, undefined]
  >
>;
type _MessageEventRequiresTextOrAttachments = Expect<
  MessageEventCase extends { text: string } | { attachments: Attachment[] }
    ? true
    : false
>;
type _ReactionEventRequiresReactionPayload = Expect<
  Equal<ReactionEvent['reaction'], ReactionPayload>
>;
type _ReactionEventExcludesMessageContent = Expect<
  Equal<[ReactionEvent['text'], ReactionEvent['attachments']], [undefined, undefined]>
>;
type _ControlEventExcludesStructuredPayloads = Expect<
  Equal<
    [
      ControlEvent['text'],
      ControlEvent['attachments'],
      ControlEvent['command'],
      ControlEvent['interaction'],
      ControlEvent['reaction'],
    ],
    [undefined, undefined, undefined, undefined, undefined]
  >
>;
type _TypingStartEventExcludesStructuredPayloads = Expect<
  Equal<
    [
      TypingStartEvent['text'],
      TypingStartEvent['attachments'],
      TypingStartEvent['command'],
      TypingStartEvent['interaction'],
      TypingStartEvent['reaction'],
    ],
    [undefined, undefined, undefined, undefined, undefined]
  >
>;

type _ButtonComponentUsesNeutralComponentId = Expect<
  Equal<
    Pick<ButtonComponent, 'type' | 'componentId' | 'label'>,
    { type: 'button'; componentId: string; label: string }
  >
>;
type _SelectComponentUsesNeutralTypeName = Expect<
  Equal<SelectComponent['type'], 'select'>
>;
type _NoStringSelectComponentVariant = Expect<
  Equal<Extract<MessageComponent, { type: 'string-select' }>, never>
>;
// @ts-expect-error MessageComponent uses componentId, not native customId.
type _ButtonComponentCustomId = ButtonComponent['customId'];

type _ModalResponseUsesNeutralIds = Expect<
  Equal<
    Pick<EventModalResponse, 'modalId' | 'title'>,
    { modalId: string; title: string }
  >
>;
type _ModalInputUsesNeutralComponentId = Expect<
  Equal<
    Pick<ModalInput, 'componentId' | 'label' | 'kind'>,
    {
      componentId: string;
      label: string;
      kind: 'short_text' | 'long_text';
    }
  >
>;
// @ts-expect-error Modal inputs use componentId, not native customId.
type _ModalInputCustomId = ModalInput['customId'];

type _OutboundMessageSupportsComponents = Expect<
  Equal<OutboundMessage['components'], MessageComponent[] | undefined>
>;
type _OutboundMessageSupportsReplyTarget = Expect<
  HasKey<OutboundMessage, 'replyTo'>
>;
type _OutboundMessageSupportsEmbeds = Expect<HasKey<OutboundMessage, 'embeds'>>;

type _CapabilitySetUsesNeutralSelectName = Expect<
  Equal<CapabilitySet['supportsSelects'], boolean | undefined>
>;
type _CapabilitySetSupportsModals = Expect<
  Equal<CapabilitySet['supportsModals'], boolean | undefined>
>;
type _CapabilitySetSupportsThreadCreation = Expect<
  Equal<CapabilitySet['supportsThreadCreation'], boolean | undefined>
>;
type _CapabilitySetDoesNotExposeStringSelects = Expect<
  Not<HasKey<CapabilitySet, 'supportsStringSelects'>>
>;

type _CreateThreadAutoArchiveIsGenericTtl = Expect<
  Equal<CreateThreadInput['autoArchiveDurationMinutes'], number | undefined>
>;
type _CommandResponseComponentsUseProtocolComponent = Expect<
  Equal<
    NonNullable<EventHandlerResult['commandResponse']>['components'],
    MessageComponent[] | undefined
  >
>;
type _ModalResponseUsesProtocolType = Expect<
  Equal<
    NonNullable<EventHandlerResult['modalResponse']>,
    EventModalResponse
  >
>;

type _PlatformAdapterKeepsOptionalPortsOptional = Expect<
  Equal<
    [
      undefined extends PlatformAdapter['createThread'] ? true : false,
      undefined extends PlatformAdapter['updateThread'] ? true : false,
      undefined extends PlatformAdapter['settingsSnapshot'] ? true : false,
      undefined extends PlatformAdapter['applySettingsAction'] ? true : false,
    ],
    [true, true, true, true]
  >
>;
type _SettingsSnapshotMethodInput = Expect<
  Equal<
    Parameters<NonNullable<PlatformAdapter['settingsSnapshot']>>[0],
    PlatformSettingsSnapshotInput
  >
>;
type _SettingsSnapshotMethodReturn = Expect<
  Equal<
    Awaited<ReturnType<NonNullable<PlatformAdapter['settingsSnapshot']>>>,
    PlatformSettingsSnapshot
  >
>;
type _SettingsActionMethodInput = Expect<
  Equal<
    Parameters<NonNullable<PlatformAdapter['applySettingsAction']>>[0],
    PlatformSettingsActionInput
  >
>;
type _SettingsActionMethodReturn = Expect<
  Equal<
    Awaited<ReturnType<NonNullable<PlatformAdapter['applySettingsAction']>>>,
    PlatformSettingsActionResult
  >
>;

export {};
