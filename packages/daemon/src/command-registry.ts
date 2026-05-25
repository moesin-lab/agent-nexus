import type {
  ActiveCommandMap,
  CapabilitySet,
  CommandAliasKind,
  CommandDescriptor,
  CommandOwner,
  CommandRegistrationPort,
  CommandRegistrationPlan,
  CommandRegistrationResult,
  CommandRegistrationScope,
  CommandRequiredCapability,
  CommandRoute,
  PlannedCommand,
} from '@agent-nexus/protocol';

export interface CommandNamePolicy {
  productReservedPrefixes: string[];
  platformReservedPrefixes: string[];
  historicalReservedBareNames: string[];
}

export const DEFAULT_COMMAND_NAME_POLICY: CommandNamePolicy = {
  productReservedPrefixes: ['nexus-'],
  platformReservedPrefixes: ['discord-'],
  historicalReservedBareNames: ['reply-mode'],
};

export type CommandRegistryErrorCode =
  | 'command_descriptor_invalid'
  | 'command_name_collision'
  | 'command_name_reserved'
  | 'command_active_map_missing'
  | 'command_reverse_map_miss'
  | 'command_scope_mismatch'
  | 'command_agent_binding_miss'
  | 'command_agent_owner_mismatch'
  | 'command_handler_missing';

export class CommandRegistryError extends Error {
  constructor(
    public readonly code: CommandRegistryErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CommandRegistryError';
  }
}

export interface BuildCommandRegistrationPlanInput {
  descriptors: readonly CommandDescriptor[];
  scope: CommandRegistrationScope;
  capabilities: CapabilitySet;
  policy: CommandNamePolicy;
  agentOwnersInScope: readonly string[];
  generation: string;
}

export interface CommandRegistryLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ApplyRegistrationPlanOptions {
  port: CommandRegistrationPort;
  activatedAt: Date;
  logger?: CommandRegistryLogger;
}

interface ParsedCanonicalId {
  owner: CommandOwner;
  localName: string;
}

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertKebab(value: string, field: string): void {
  if (!KEBAB_RE.test(value)) {
    throw new CommandRegistryError(
      'command_descriptor_invalid',
      `${field} must be non-empty lowercase kebab-case`,
      { field, value },
    );
  }
}

function parseCanonicalId(canonicalId: string): ParsedCanonicalId {
  const parts = canonicalId.split(':');
  if (parts[0] === 'agent' && parts.length === 3) {
    const agentOwner = parts[1]!;
    const localName = parts[2]!;
    assertKebab(agentOwner, 'canonicalId.agentOwner');
    assertKebab(localName, 'canonicalId.localName');
    return { owner: { type: 'agent', agentOwner }, localName };
  }
  if (parts[0] === 'platform' && parts.length === 3) {
    const platformType = parts[1]!;
    const localName = parts[2]!;
    assertKebab(platformType, 'canonicalId.platformType');
    assertKebab(localName, 'canonicalId.localName');
    return { owner: { type: 'platform', platformType }, localName };
  }
  if (parts[0] === 'daemon' && parts.length === 2) {
    const localName = parts[1]!;
    assertKebab(localName, 'canonicalId.localName');
    return { owner: { type: 'daemon' }, localName };
  }
  throw new CommandRegistryError(
    'command_descriptor_invalid',
    'canonicalId has invalid command owner shape',
    { canonicalId },
  );
}

function sameOwner(a: CommandOwner, b: CommandOwner): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'agent' && b.type === 'agent') {
    return a.agentOwner === b.agentOwner;
  }
  if (a.type === 'platform' && b.type === 'platform') {
    return a.platformType === b.platformType;
  }
  return true;
}

function ownerKey(owner: CommandOwner): string {
  if (owner.type === 'agent') return `agent:${owner.agentOwner}`;
  if (owner.type === 'platform') return `platform:${owner.platformType}`;
  return 'daemon';
}

function validateDescriptor(descriptor: CommandDescriptor): void {
  const parsed = parseCanonicalId(descriptor.canonicalId);
  assertKebab(descriptor.localName, 'localName');
  if (descriptor.owner.type === 'agent') {
    assertKebab(descriptor.owner.agentOwner, 'owner.agentOwner');
  } else if (descriptor.owner.type === 'platform') {
    assertKebab(descriptor.owner.platformType, 'owner.platformType');
  }
  if (
    !sameOwner(parsed.owner, descriptor.owner) ||
    parsed.localName !== descriptor.localName
  ) {
    throw new CommandRegistryError(
      'command_descriptor_invalid',
      'canonicalId must match owner and localName',
      {
        canonicalId: descriptor.canonicalId,
        owner: descriptor.owner,
        localName: descriptor.localName,
      },
    );
  }
  if (descriptor.summary.trim().length === 0) {
    throw new CommandRegistryError(
      'command_descriptor_invalid',
      'summary must be non-empty',
      { canonicalId: descriptor.canonicalId },
    );
  }
  if (descriptor.handlerKey.trim().length === 0) {
    throw new CommandRegistryError(
      'command_descriptor_invalid',
      'handlerKey must be non-empty',
      { canonicalId: descriptor.canonicalId },
    );
  }
  if (descriptor.owner.type === 'daemon') {
    const hasExplicitScope =
      (descriptor.applicability.platformTypes?.length ?? 0) > 0 ||
      descriptor.applicability.requiredCapabilities.length > 0;
    if (!hasExplicitScope) {
      throw new CommandRegistryError(
        'command_descriptor_invalid',
        'daemon command must declare platformTypes or requiredCapabilities',
        { canonicalId: descriptor.canonicalId },
      );
    }
  }
  if (
    descriptor.owner.type === 'platform' &&
    descriptor.applicability.platformTypes &&
    !descriptor.applicability.platformTypes.includes(descriptor.owner.platformType)
  ) {
    throw new CommandRegistryError(
      'command_descriptor_invalid',
      'platform command applicability must include owner platformType',
      {
        canonicalId: descriptor.canonicalId,
        platformType: descriptor.owner.platformType,
      },
    );
  }
  for (const option of descriptor.options) {
    assertKebab(option.name, 'option.name');
  }
  for (const legacy of descriptor.legacyNames) {
    assertKebab(legacy.name, 'legacy.name');
  }
}

function hasCapability(
  capability: CommandRequiredCapability,
  capabilities: CapabilitySet,
): boolean {
  if (capability === 'slash-command-registration') {
    return capabilities.supportsSlashCommands;
  }
  return capabilities.supportsEphemeral;
}

function appliesToScope(
  descriptor: CommandDescriptor,
  scope: CommandRegistrationScope,
  capabilities: CapabilitySet,
  agentOwnersInScope: ReadonlySet<string>,
): boolean {
  const { applicability } = descriptor;
  if (
    applicability.platformTypes &&
    !applicability.platformTypes.includes(scope.platformType)
  ) {
    return false;
  }
  if (
    descriptor.owner.type === 'platform' &&
    descriptor.owner.platformType !== scope.platformType
  ) {
    return false;
  }
  if (
    descriptor.owner.type === 'agent' &&
    !agentOwnersInScope.has(descriptor.owner.agentOwner)
  ) {
    return false;
  }
  return applicability.requiredCapabilities.every((capability) =>
    hasCapability(capability, capabilities),
  );
}

function stableName(descriptor: CommandDescriptor): string {
  if (descriptor.owner.type === 'agent') {
    return `${descriptor.owner.agentOwner}-${descriptor.localName}`;
  }
  if (descriptor.owner.type === 'platform') {
    return `${descriptor.owner.platformType}-${descriptor.localName}`;
  }
  return `nexus-${descriptor.localName}`;
}

function activeAgentPrefixes(agentOwnersInScope: readonly string[]): string[] {
  return [...new Set(agentOwnersInScope)].map((owner) => `${owner}-`);
}

function ensureAgentPrefixesAllowed(
  agentOwnersInScope: readonly string[],
  policy: CommandNamePolicy,
): void {
  const reserved = [
    ...policy.productReservedPrefixes,
    ...policy.platformReservedPrefixes,
  ];
  for (const prefix of activeAgentPrefixes(agentOwnersInScope)) {
    if (reserved.some((reservedPrefix) => prefix.startsWith(reservedPrefix))) {
      throw new CommandRegistryError(
        'command_name_reserved',
        'agent owner prefix collides with a reserved command prefix',
        { prefix },
      );
    }
  }
}

function matchesReservedBareName(
  name: string,
  policy: CommandNamePolicy,
  agentPrefixes: readonly string[],
): boolean {
  return (
    policy.historicalReservedBareNames.includes(name) ||
    policy.productReservedPrefixes.some((prefix) => name.startsWith(prefix)) ||
    policy.platformReservedPrefixes.some((prefix) => name.startsWith(prefix)) ||
    agentPrefixes.some((prefix) => name.startsWith(prefix))
  );
}

function makeRoute(
  descriptor: CommandDescriptor,
  aliasKind: CommandAliasKind,
): CommandRoute {
  return {
    canonicalId: descriptor.canonicalId,
    aliasKind,
    owner: descriptor.owner,
    handlerKey: descriptor.handlerKey,
  };
}

function addCommand(
  commandsByName: Map<string, PlannedCommand>,
  descriptor: CommandDescriptor,
  commandName: string,
  aliasKind: CommandAliasKind,
): void {
  assertKebab(commandName, 'commandName');
  if (commandsByName.has(commandName)) {
    throw new CommandRegistryError(
      'command_name_collision',
      'command name must be unique within a registration scope',
      { commandName },
    );
  }
  commandsByName.set(commandName, {
    commandName,
    canonicalId: descriptor.canonicalId,
    aliasKind,
    descriptor,
  });
}

export function buildCommandRegistrationPlan(
  input: BuildCommandRegistrationPlanInput,
): CommandRegistrationPlan {
  ensureAgentPrefixesAllowed(input.agentOwnersInScope, input.policy);

  const seenCanonicalIds = new Set<string>();
  const handlerKeysByOwner = new Map<string, Set<string>>();
  const agentOwnersInScope = new Set(input.agentOwnersInScope);
  const applicable: CommandDescriptor[] = [];
  for (const descriptor of input.descriptors) {
    validateDescriptor(descriptor);
    if (seenCanonicalIds.has(descriptor.canonicalId)) {
      throw new CommandRegistryError(
        'command_descriptor_invalid',
        'canonicalId must be globally unique',
        { canonicalId: descriptor.canonicalId },
      );
    }
    seenCanonicalIds.add(descriptor.canonicalId);
    const ownerHandlerKeys =
      handlerKeysByOwner.get(ownerKey(descriptor.owner)) ?? new Set<string>();
    if (ownerHandlerKeys.has(descriptor.handlerKey)) {
      throw new CommandRegistryError(
        'command_descriptor_invalid',
        'handlerKey must be unique within one command owner',
        {
          canonicalId: descriptor.canonicalId,
          owner: descriptor.owner,
          handlerKey: descriptor.handlerKey,
        },
      );
    }
    ownerHandlerKeys.add(descriptor.handlerKey);
    handlerKeysByOwner.set(ownerKey(descriptor.owner), ownerHandlerKeys);
    if (
      appliesToScope(
        descriptor,
        input.scope,
        input.capabilities,
        agentOwnersInScope,
      )
    ) {
      applicable.push(descriptor);
    }
  }

  const commandsByName = new Map<string, PlannedCommand>();
  for (const descriptor of applicable) {
    addCommand(commandsByName, descriptor, stableName(descriptor), 'stable');
  }

  for (const descriptor of applicable) {
    for (const legacy of descriptor.legacyNames) {
      if (!input.policy.historicalReservedBareNames.includes(legacy.name)) {
        throw new CommandRegistryError(
          'command_name_reserved',
          'legacy command name must remain historically reserved',
          { canonicalId: descriptor.canonicalId, legacyName: legacy.name },
        );
      }
      addCommand(commandsByName, descriptor, legacy.name, 'legacy');
    }
  }

  const agentPrefixes = activeAgentPrefixes(input.agentOwnersInScope);
  const agentOwnersByLocalName = new Map<string, Set<string>>();
  for (const descriptor of applicable) {
    if (descriptor.owner.type !== 'agent') continue;
    const owners =
      agentOwnersByLocalName.get(descriptor.localName) ?? new Set<string>();
    owners.add(descriptor.owner.agentOwner);
    agentOwnersByLocalName.set(descriptor.localName, owners);
  }

  for (const descriptor of applicable) {
    if (descriptor.owner.type !== 'agent') continue;
    const owners = agentOwnersByLocalName.get(descriptor.localName);
    if (!owners || owners.size !== 1) continue;

    const aliasName = descriptor.localName;
    if (matchesReservedBareName(aliasName, input.policy, agentPrefixes)) {
      throw new CommandRegistryError(
        'command_name_reserved',
        'single-agent alias collides with a reserved command name',
        { canonicalId: descriptor.canonicalId, aliasName },
      );
    }
    addCommand(commandsByName, descriptor, aliasName, 'single-agent-alias');
  }

  const commands = [...commandsByName.values()];
  const entries: Record<string, CommandRoute> = {};
  for (const command of commands) {
    entries[command.commandName] = makeRoute(command.descriptor, command.aliasKind);
  }

  return {
    scope: input.scope,
    commands,
    reverseMap: { entries },
    generation: input.generation,
  };
}

function scopeKey(scope: CommandRegistrationScope): string {
  const native =
    scope.nativeScope.kind === 'global'
      ? 'global'
      : `guild:${scope.nativeScope.guildId}`;
  return `${scope.platformName}:${scope.platformType}:${native}`;
}

function safeRegistrationError(
  error: CommandRegistrationResult & { status: 'failed' },
): { code: string; message: string } {
  return {
    code: error.error.code,
    message: error.error.message,
  };
}

export class ActiveCommandRegistry {
  private readonly activeMaps = new Map<string, ActiveCommandMap>();

  activate(plan: CommandRegistrationPlan, activatedAt: Date): void {
    this.activeMaps.set(scopeKey(plan.scope), {
      scope: plan.scope,
      reverseMap: plan.reverseMap,
      generation: plan.generation,
      activatedAt,
    });
  }

  async applyRegistrationPlan(
    plan: CommandRegistrationPlan,
    options: ApplyRegistrationPlanOptions,
  ): Promise<CommandRegistrationResult> {
    // Caller owns the per-scope single-in-flight guarantee from the spec.
    // This method validates the returned generation for the one plan it applied.
    let result: CommandRegistrationResult;
    try {
      result = await options.port.applyCommandPlan(plan);
    } catch (err) {
      result = {
        status: 'failed',
        error: {
          code: 'command_registration_failed',
          message: 'command registration port threw',
          cause: err,
        },
      };
    }

    if (result.status === 'failed') {
      options.logger?.error(
        {
          platformName: plan.scope.platformName,
          scope: plan.scope.nativeScope,
          generation: plan.generation,
          error: safeRegistrationError(result),
        },
        'command_registration_failed',
      );
      return result;
    }

    if (result.generation !== plan.generation) {
      const failed: CommandRegistrationResult = {
        status: 'failed',
        error: {
          code: 'command_activation_generation_mismatch',
          message: 'registration result generation does not match plan',
        },
      };
      options.logger?.error(
        {
          platformName: plan.scope.platformName,
          scope: plan.scope.nativeScope,
          expectedGeneration: plan.generation,
          resultGeneration: result.generation,
        },
        'command_activation_generation_mismatch',
      );
      return failed;
    }

    this.activate(plan, options.activatedAt);
    return { status: 'applied', generation: result.generation };
  }

  resolve(scope: CommandRegistrationScope, commandName: string): CommandRoute {
    const active = this.activeMaps.get(scopeKey(scope));
    if (!active) {
      throw new CommandRegistryError(
        'command_active_map_missing',
        'command dispatch requires an active command map',
        { scope },
      );
    }
    const route = active.reverseMap.entries[commandName];
    if (!route) {
      throw new CommandRegistryError(
        'command_reverse_map_miss',
        'command name is not present in the active reverse map',
        {
          scope,
          commandName,
          generation: active.generation,
        },
      );
    }
    return route;
  }
}
