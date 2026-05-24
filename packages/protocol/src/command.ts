export type CommandCanonicalId = string;

export type CommandOwner =
  | { type: 'agent'; agentOwner: string }
  | { type: 'platform'; platformType: string }
  | { type: 'daemon' };

export type CommandOptionType = 'string' | 'integer' | 'number' | 'boolean';

export interface CommandChoice {
  name: string;
  value: string | number;
}

export interface CommandOption {
  name: string;
  type: CommandOptionType;
  required: boolean;
  description: string;
  choices: CommandChoice[];
}

export type CommandRequiredCapability =
  | 'slash-command-registration'
  | 'ephemeral-response';

export interface CommandApplicability {
  platformTypes?: string[];
  requiredCapabilities: CommandRequiredCapability[];
}

export interface LegacyCommandName {
  name: string;
  reason: 'historical-compatibility';
}

/** docs/dev/spec/command-registry.md §CommandDescriptor */
export interface CommandDescriptor {
  canonicalId: CommandCanonicalId;
  owner: CommandOwner;
  localName: string;
  summary: string;
  options: CommandOption[];
  handlerKey: string;
  applicability: CommandApplicability;
  legacyNames: LegacyCommandName[];
}

export type NativeCommandScope =
  | { kind: 'global' }
  | { kind: 'guild'; guildId: string };

/** docs/dev/spec/command-registry.md §Registration Scope */
export interface CommandRegistrationScope {
  platformName: string;
  platformType: string;
  nativeScope: NativeCommandScope;
}

export type CommandAliasKind = 'stable' | 'single-agent-alias' | 'legacy';

export interface CommandRoute {
  canonicalId: CommandCanonicalId;
  aliasKind: CommandAliasKind;
  owner: CommandOwner;
  handlerKey: string;
}

export interface CommandReverseMap {
  entries: Record<string, CommandRoute>;
}

export interface PlannedCommand {
  commandName: string;
  canonicalId: CommandCanonicalId;
  aliasKind: CommandAliasKind;
  descriptor: CommandDescriptor;
}

export interface CommandRegistrationPlan {
  scope: CommandRegistrationScope;
  commands: PlannedCommand[];
  reverseMap: CommandReverseMap;
  generation: string;
}

export type CommandRegistrationErrorCode =
  | 'command_registration_failed'
  | 'command_activation_generation_mismatch';

export interface CommandRegistrationError {
  code: CommandRegistrationErrorCode;
  message: string;
  cause?: unknown;
}

export type CommandRegistrationResult =
  | { status: 'applied'; generation: string }
  | { status: 'failed'; error: CommandRegistrationError };

/** docs/dev/spec/command-registry.md §Remote Registration Activation */
export interface CommandRegistrationPort {
  applyCommandPlan(
    plan: CommandRegistrationPlan,
  ): Promise<CommandRegistrationResult>;
}

export interface ActiveCommandMap {
  scope: CommandRegistrationScope;
  reverseMap: CommandReverseMap;
  generation: string;
  activatedAt: Date;
}

export type CommandArgValue = string | number | boolean | null;

/** docs/dev/spec/message-protocol.md §CommandPayload */
export interface CommandPayload {
  name: string;
  args: Record<string, CommandArgValue>;
  registrationScope: CommandRegistrationScope;
}
