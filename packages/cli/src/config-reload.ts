import type {
  DaemonConfigEditableField,
  DaemonConfigFieldsProvider,
  DaemonConfigPreviewer,
  DaemonConfigEditor,
  DaemonConfigReloader,
  DaemonConfigReloadResult,
  DaemonConfigEditEffect,
  DaemonConfigEditRisk,
  DaemonConfigValueKind,
  EngineRuntimeUpdate,
  Logger,
} from '@agent-nexus/daemon';
import { agentOwnersForPlatform } from './command-registry.js';
import {
  buildRoutingTable,
  type AgentNexusConfig,
  type AgentConfig,
  type ConfigFileEditInput,
  type ConfigFileEditPreviewInput,
  type ConfigFileEditPreviewResult,
  type ConfigFileEditResult,
  type BindingConfig,
  type PlatformConfig,
} from './config.js';

/** reload 时被热替换的 engine 目标；语义见 docs/dev/spec/config-routing.md §配置热重载 */
export interface ConfigReloadTarget {
  platformName: string;
  applyRuntimeUpdate(update: EngineRuntimeUpdate): void;
}

export interface CreateConfigReloaderOptions {
  initialConfig: AgentNexusConfig;
  load: () => Promise<AgentNexusConfig>;
  /** call 时读取，允许调用方在 engine 逐个创建期间填充 */
  targets: readonly ConfigReloadTarget[];
  runningAgentNames: readonly string[];
  logger: Logger;
}

export interface CreateConfigEditorOptions {
  edit(input: ConfigFileEditInput): Promise<ConfigFileEditResult>;
  reload: DaemonConfigReloader;
  logger: Logger;
}

export interface CreateConfigFieldsProviderOptions {
  load: () => Promise<AgentNexusConfig>;
}

export interface CreateConfigPreviewerOptions {
  preview(input: ConfigFileEditPreviewInput): Promise<ConfigFileEditPreviewResult>;
}

function failed(reason: string): DaemonConfigReloadResult {
  return {
    status: 'failed',
    message: `[config reload failed] previous config kept:\n${reason}`,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function configValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '[missing]';
  return JSON.stringify(value);
}

function effectForPath(path: string): DaemonConfigEditEffect {
  if (
    path === 'ui.toolMessages' ||
    path === 'daemon.commandRegistry.textPrefixes.newSession' ||
    /^platforms\[\d+\]\.auth(?:\.|$)/.test(path)
  ) {
    return 'hot';
  }
  if (/^bindings\[\d+\]\./.test(path)) {
    return 'conditional-hot';
  }
  return 'restart';
}

function riskForPath(path: string): DaemonConfigEditRisk {
  if (
    /^platforms\[\d+\]\.auth(?:\.|$)/.test(path) ||
    path.includes('.auth.') ||
    path.endsWith('.sandbox') ||
    path.endsWith('.addDirs') ||
    path.endsWith('.loadUserConfig') ||
    path.endsWith('.loadRules') ||
    path.endsWith('.allowedTools') ||
    path.endsWith('.permissionLevel') ||
    path.endsWith('.bin') ||
    path.endsWith('.tokenRef') ||
    path.endsWith('.statePath') ||
    path.includes('.externalImport') ||
    path.includes('.providerCapture')
  ) {
    return 'high';
  }
  return 'normal';
}

function field(
  input: Omit<DaemonConfigEditableField, 'effect' | 'risk' | 'value'> & {
    value: unknown;
  },
): DaemonConfigEditableField {
  return {
    ...input,
    description: splitBilingualInline(input.description),
    value: configValue(input.value),
    effect: effectForPath(input.path),
    risk: riskForPath(input.path),
  };
}

function bilingualLabel(cn: string, en: string): string {
  return `${cn}\n${en}`;
}

function splitBilingualInline(text: string): string {
  return text.replace(' / ', '\n');
}

const COMMAND_REGISTRY_FIELD_DESCRIPTIONS: Record<string, string> = {
  'daemon.commandRegistry.registration.enabled':
    '控制启动或重载时是否向 Discord 等平台提交 slash command registration plan。关闭后不会注册或更新远端命令；由于没有持久化 active map，command dispatch 会 fail-closed。通常只在排查注册问题时临时关闭。 / Controls whether the daemon applies the slash-command registration plan to remote platforms during startup or reload. When false, commands are not registered or updated; without a persisted active map, command dispatch stays fail-closed. Use mainly for registration troubleshooting.',
  'daemon.commandRegistry.registration.applyTimeoutMs':
    'daemon 调用平台 applyCommandPlan 的最长等待时间，单位毫秒。超时等价于 registration failure，daemon 会保留旧 active map，避免进入半注册状态；网络慢或 Discord API 响应慢时可适当增大。 / Maximum time in milliseconds for the daemon to wait for platform applyCommandPlan. Timeout is treated as a registration failure, and the previous active map is kept to avoid a partially registered state. Increase it when the network or Discord API is slow.',
  'daemon.commandRegistry.registration.retry.maxAttempts':
    'daemon 启动时 apply registration plan 失败后的最大重试次数。只有 generation 匹配的成功结果能激活 active map；增大该值可容忍临时 API 或网络抖动，但会延长启动失败前的等待时间。 / Maximum retry attempts after applying the registration plan fails during daemon startup. Only a successful result with the matching generation activates the active map. Higher values tolerate temporary API or network failures but extend startup wait time.',
  'daemon.commandRegistry.registration.retry.backoffMs':
    '每次 registration retry 之间的等待时间，单位毫秒。0 表示立即重试；建议与 maxAttempts 一起调整，避免 Discord/API 短暂故障时连续打满请求。 / Delay in milliseconds between registration retries. 0 retries immediately. Tune it with maxAttempts to avoid hammering Discord/API during transient failures.',
  'daemon.commandRegistry.aliases.singleAgent.enabled':
    '控制 single-agent 场景是否注册裸别名 slash commands，例如 /new 和 /stop。关闭后仍保留稳定命名 commands，例如 /codex-new、/codex-stop、/claudecode-new、/claudecode-stop；适合多 agent 环境或需要避免短命令冲突时关闭。 / Controls whether bare alias slash commands such as /new and /stop are registered for single-agent setups. Stable commands such as /codex-new, /codex-stop, /claudecode-new, and /claudecode-stop remain available. Disable it in multi-agent environments or when short command names may conflict.',
  'daemon.commandRegistry.aliases.legacy.replyMode':
    '控制历史兼容的 /reply-mode 裸别名是否进入 registration plan。关闭后只影响 legacy alias；reply-mode 仍保留为 historical reserved bare name，避免被其他命令误用。 / Controls whether the legacy bare /reply-mode alias is included in the registration plan. Disabling it only removes the legacy alias; reply-mode remains a historical reserved bare name so other commands cannot accidentally reuse it.',
  'daemon.commandRegistry.textPrefixes.newSession':
    '控制文本消息中的 @bot /new 和 @bot /new <prompt> 是否触发新会话。不影响 slash command 的稳定命名；适合想禁用聊天文本快捷入口、只保留 slash commands 的场景。 / Controls whether text messages like @bot /new and @bot /new <prompt> start a new session. It does not affect stable slash command names. Disable it when chat-text shortcuts should be off and only slash commands should remain.',
};

const TRAJECTORY_FIELD_DESCRIPTIONS: Record<string, string> = {
  'daemon.trajectory.enabled':
    '控制 daemon 是否写入会话 trajectory read model，用于后续查看会话历史、外部导入和 provider-call observation。关闭后新事件不会进入 trajectory 存储，但不影响正常消息路由。 / Controls whether the daemon writes the session trajectory read model for later history lookup, external import, and provider-call observation. When disabled, new events are not stored in trajectory, but normal message routing is unaffected.',
  'daemon.trajectory.externalImport.enabled':
    '控制是否启用外部会话导入能力，用于从配置的外部来源发现或导入历史 session。关闭后不会扫描 externalImport.sources。 / Enables external session import, which discovers or imports historical sessions from configured external sources. When disabled, externalImport.sources are not scanned.',
  'daemon.trajectory.externalImport.sources':
    '外部会话导入来源列表，通常包含 source 类型、路径和匹配规则。该字段是 JSON；错误来源配置可能导致导入失败或读取不期望的路径，修改前需核对来源边界。 / List of external session import sources, usually including source type, path, and matching rules. This is JSON. Incorrect sources can fail import or read unexpected paths, so verify source boundaries before editing.',
  'daemon.trajectory.externalImport.metadataOnlyDiscovery':
    '控制发现外部 session 时是否只读取 metadata。开启后可降低 I/O 和隐私风险，但列表中可能没有完整正文；关闭后可能读取更多内容。 / Controls whether external session discovery reads metadata only. Enabling it reduces I/O and privacy risk but may omit full content from listings; disabling it can read more content.',
  'daemon.trajectory.externalImport.importContent':
    '控制导入外部 session 时是否把正文内容写入 trajectory。关闭后只保留 metadata，适合只需要索引或避免导入敏感正文的场景。 / Controls whether imported external sessions write message content into trajectory. When disabled, only metadata is kept, useful for indexing-only workflows or avoiding sensitive content import.',
  'daemon.trajectory.externalImport.maxFileBytes':
    '单个外部会话文件允许读取的最大字节数。用于限制导入成本和避免异常大文件拖慢 daemon；超过上限的文件会被跳过或失败。 / Maximum bytes read from one external session file. It limits import cost and prevents unusually large files from slowing the daemon; files above the limit are skipped or rejected.',
  'daemon.trajectory.externalImport.maxRecordsPerSession':
    '单个外部 session 最多导入的记录数。用于限制导入后的存储大小和 UI 展示成本；过小会截断历史，过大可能增加存储压力。 / Maximum records imported per external session. It limits storage size and UI cost; too small truncates history, too large can increase storage pressure.',
  'daemon.trajectory.externalImport.maxAgeDays':
    '外部导入允许的最大历史天数；null 或空值通常表示不按年龄过滤。用于避免导入过旧会话。 / Maximum age in days allowed for external import; null or empty usually means no age filter. Use it to avoid importing stale sessions.',
  'daemon.trajectory.providerCapture.enabled':
    '控制是否启用 provider-call capture，用于观察 agent 与模型 provider 之间的请求/响应。开启后会增加观测数据和潜在敏感信息处理责任。 / Enables provider-call capture for observing requests and responses between agents and model providers. Enabling it increases observability data and the responsibility to handle potentially sensitive content.',
  'daemon.trajectory.providerCapture.mode':
    'provider capture 的工作模式：reverse-proxy、forward-proxy 或 transcript-only。不同模式决定是否代理网络请求或只从 transcript 提取信息，配置错误可能影响 agent provider 通信。 / Provider capture mode: reverse-proxy, forward-proxy, or transcript-only. The mode decides whether network requests are proxied or only transcript data is used; wrong settings can affect agent-provider communication.',
  'daemon.trajectory.providerCapture.bindHost':
    'provider capture 监听地址。建议默认绑定本地地址；绑定 0.0.0.0 会扩大网络暴露面，需要确认访问控制。 / Host address for provider capture listener. Prefer localhost defaults; binding 0.0.0.0 broadens network exposure and requires access-control review.',
  'daemon.trajectory.providerCapture.port':
    'provider capture 监听端口。可设为固定端口或 null/自动端口，需避免与其他服务冲突；变更通常需要重启。 / Port for provider capture listener. It can be fixed or null/auto depending on config semantics, must avoid conflicts with other services, and usually requires restart.',
  'daemon.trajectory.providerCapture.storeRawStreams':
    '控制是否保存 provider 原始请求/响应流。开启后排查能力更强，但可能保存敏感 prompt、输出或 token-adjacent 数据，默认应谨慎。 / Controls whether raw provider request/response streams are stored. Enabling improves debugging but may persist sensitive prompts, outputs, or token-adjacent data; use cautiously.',
  'daemon.trajectory.providerCapture.maxRequestBytes':
    '单个 provider request 可捕获的最大字节数。用于限制存储成本和敏感数据规模；超过上限的内容会被截断或跳过。 / Maximum bytes captured from one provider request. It limits storage cost and sensitive data volume; content above the limit is truncated or skipped.',
  'daemon.trajectory.providerCapture.maxResponseBytes':
    '单个 provider response 可捕获的最大字节数。用于限制长输出带来的存储压力；过小会影响排查完整性，过大增加存储和隐私风险。 / Maximum bytes captured from one provider response. It limits storage pressure from long outputs; too small reduces debugging completeness, too large increases storage and privacy risk.',
  'daemon.trajectory.providerCapture.retentionDays':
    'provider capture 数据保留天数。较短保留期降低隐私和磁盘风险，较长保留期便于追踪长期问题。 / Retention days for provider capture data. Shorter retention reduces privacy and disk risk; longer retention helps diagnose long-running issues.',
};

const CONFIG_FIELD_DESCRIPTIONS: Record<string, string> = {
  'ui.toolMessages':
    '控制工具调用消息在聊天中的展示方式。append 会把工具进展追加到对话里，compact 会更紧凑地呈现，适合减少噪音。 / Controls how tool-call messages are shown in chat. append keeps tool progress visible in the conversation, while compact presents it more tersely to reduce noise.',
  'log.level':
    '控制进程日志级别。trace/debug 会输出更多排查信息但更吵且可能增加日志量；info/warn/error/fatal 更适合稳定运行。修改后需重启进程。 / Controls process log verbosity. trace/debug emit more diagnostics but are noisier and can increase log volume; info/warn/error/fatal are better for stable operation. Requires restart.',
  ...COMMAND_REGISTRY_FIELD_DESCRIPTIONS,
  ...TRAJECTORY_FIELD_DESCRIPTIONS,
};

function descriptionForPath(path: string): string {
  const description = CONFIG_FIELD_DESCRIPTIONS[path];
  if (!description) {
    throw new Error(`missing config field description for ${path}`);
  }
  return description;
}

function platformFields(platform: PlatformConfig, index: number): DaemonConfigEditableField[] {
  const base = `platforms[${index}]`;
  const category = `Platform ${platform.name}`;
  const allowlist = platform.auth.allowlist;
  return [
    field({
      key: `${base}.botUserId`,
      label: bilingualLabel(`${platform.name} bot 用户 ID`, `${platform.name} bot user ID`),
      description:
        `平台 ${platform.name} 的 Discord bot user ID。用于识别 bot 自己的用户身份，避免把 bot 自己的消息当成用户输入，也用于 mention/slash 相关判断。填错会导致消息过滤、mention 判断或自消息保护异常。 / Discord bot user ID for platform ${platform.name}. It identifies the bot itself so self messages are ignored and mention/slash checks work correctly. Wrong values can break message filtering or self-message protection.`,
      category,
      path: `${base}.botUserId`,
      value: platform.botUserId,
      valueKind: 'string',
    }),
    field({
      key: `${base}.tokenRef`,
      label: bilingualLabel(`${platform.name} token 引用`, `${platform.name} token ref`),
      description:
        `平台 ${platform.name} 的 secret reference 名称，不是 token 明文。用于从 secret provider 或 secret 文件加载 Discord bot token；不要在这里填写明文 token。修改会影响平台登录，通常需要重启。 / Secret reference name for platform ${platform.name}, not the token value itself. It is used to load the Discord bot token from the secret provider or secret file. Do not put the raw token here. Changing it affects platform login and usually requires restart.`,
      category,
      path: `${base}.tokenRef`,
      value: platform.tokenRef,
      valueKind: 'string',
    }),
    field({
      key: `${base}.statePath`,
      label: bilingualLabel(`${platform.name} 状态文件路径`, `${platform.name} state path`),
      description:
        `平台 ${platform.name} 的 state file 路径。保存 Discord reply mode 等平台本地状态；多 bot 不应共用同一个 statePath，否则状态会串扰。修改后通常需要重启并确认旧状态是否迁移。 / State file path for platform ${platform.name}. It stores local platform state such as Discord reply mode. Multiple bots should not share the same statePath, or state can leak across instances. Changing it usually requires restart and state migration review.`,
      category,
      path: `${base}.statePath`,
      value: platform.statePath,
      valueKind: 'string',
    }),
    field({
      key: `${base}.testGuildId`,
      label: bilingualLabel(`${platform.name} 测试服务器`, `${platform.name} test guild`),
      description:
        `平台 ${platform.name} 的 Discord test guild ID。设置后 slash command registration 通常走 guild scope，便于快速测试；留空时可走全局注册，生效更慢且影响范围更大。 / Discord test guild ID for platform ${platform.name}. When set, slash command registration usually targets that guild for faster testing. When empty, global registration may be used, which propagates slower and has broader impact.`,
      category,
      path: `${base}.testGuildId`,
      value: platform.testGuildId ?? '',
      valueKind: 'string',
    }),
    field({
      key: `${base}.publicChannelMode`,
      label: bilingualLabel(
        `${platform.name} 公开频道模式`,
        `${platform.name} public channel mode`,
      ),
      description:
        `Discord 平台 ${platform.name} 的 public-channel handling mode。disabled 禁止公开频道直接对话；thread 会把公开频道入口导向 thread；public 允许公开频道直接交互。该设置影响用户可见范围和权限边界。 / Public-channel handling mode for Discord platform ${platform.name}. disabled blocks direct public-channel conversations, thread routes public-channel entry into threads, and public allows direct interaction. This affects visibility and auth boundaries.`,
      category,
      path: `${base}.publicChannelMode`,
      value: platform.publicChannelMode,
      valueKind: 'enum',
      options: ['disabled', 'thread', 'public'],
    }),
    field({
      key: `${base}.auth.allowlist.userIds`,
      label: bilingualLabel(`${platform.name} 允许用户`, `${platform.name} allowed users`),
      description:
        `平台 ${platform.name} 允许通过鉴权的 Discord user IDs。只有列表中的用户可通过鉴权；空列表通常表示不按用户维度放行，需要结合 role/guild/channel/DM 规则理解。热重载后应与重启效果一致。 / Allowed Discord user IDs for platform ${platform.name}. Only listed users pass this auth dimension. An empty list usually means this dimension is not granting access by itself; interpret it with role/guild/channel/DM rules. Hot reload should match restart behavior.`,
      category,
      path: `${base}.auth.allowlist.userIds`,
      value: allowlist.userIds,
      valueKind: 'string-list',
    }),
    field({
      key: `${base}.auth.allowlist.roleIds`,
      label: bilingualLabel(`${platform.name} 允许角色`, `${platform.name} allowed roles`),
      description:
        `平台 ${platform.name} 允许通过鉴权的 Discord role IDs。用于按 guild role 放行用户；只对带 guild/role 上下文的事件有效，DM 场景不依赖 role。 / Allowed Discord role IDs for platform ${platform.name}. It grants access by guild role and only applies to events with guild/role context; DM flows do not rely on roles.`,
      category,
      path: `${base}.auth.allowlist.roleIds`,
      value: allowlist.roleIds,
      valueKind: 'string-list',
    }),
    field({
      key: `${base}.auth.allowlist.allowedGuildIds`,
      label: bilingualLabel(`${platform.name} 允许服务器`, `${platform.name} allowed guilds`),
      description:
        `平台 ${platform.name} 允许响应的 Discord guild IDs。限制 bot 只响应指定服务器中的事件；填错会导致整个服务器无法使用或意外放开其他服务器。 / Allowed Discord guild IDs for platform ${platform.name}. It restricts responses to events from selected servers. Wrong values can block a whole server or unintentionally allow another server.`,
      category,
      path: `${base}.auth.allowlist.allowedGuildIds`,
      value: allowlist.allowedGuildIds,
      valueKind: 'string-list',
    }),
    field({
      key: `${base}.auth.allowlist.allowedChannelIds`,
      label: bilingualLabel(
        `${platform.name} 允许频道`,
        `${platform.name} allowed channels`,
      ),
      description:
        `平台 ${platform.name} 允许响应的 Discord channel IDs。限制 bot 只响应指定 channel/thread；公开频道和 thread 策略仍需结合 publicChannelMode 理解。 / Allowed Discord channel IDs for platform ${platform.name}. It restricts responses to selected channels or threads; interpret public channels and threads together with publicChannelMode.`,
      category,
      path: `${base}.auth.allowlist.allowedChannelIds`,
      value: allowlist.allowedChannelIds,
      valueKind: 'string-list',
    }),
    field({
      key: `${base}.auth.allowlist.allowDM`,
      label: bilingualLabel(`${platform.name} 允许私信`, `${platform.name} allow DM`),
      description:
        `控制平台 ${platform.name} 是否允许 direct messages。开启后允许符合用户维度规则的 DM 进入 daemon；关闭后 DM 会被拒绝，即使 userId 在 allowlist 中。 / Controls whether direct messages are allowed for platform ${platform.name}. When enabled, DMs that satisfy user rules can reach the daemon. When disabled, DMs are rejected even if the userId is allowed.`,
      category,
      path: `${base}.auth.allowlist.allowDM`,
      value: allowlist.allowDM,
      valueKind: 'boolean',
    }),
    field({
      key: `${base}.auth.allowlist.requireMentionOrSlash`,
      label: bilingualLabel(
        `${platform.name} 要求 mention 或 slash`,
        `${platform.name} require mention or slash`,
      ),
      description:
        `控制平台 ${platform.name} 是否要求 mention 或 slash command 后才处理消息。开启后可减少公开频道误触发；关闭后符合 allowlist 的普通文本也可能进入 agent。 / Controls whether platform ${platform.name} requires a mention or slash command before handling messages. Enabling it reduces accidental public-channel triggers; disabling it lets allowed plain text reach the agent.`,
      category,
      path: `${base}.auth.allowlist.requireMentionOrSlash`,
      value: allowlist.requireMentionOrSlash,
      valueKind: 'boolean',
    }),
  ];
}

function agentFields(agent: AgentConfig, index: number): DaemonConfigEditableField[] {
  const base = `agents[${index}]`;
  const common = [
    field({
      key: `${base}.timeoutMs`,
      label: bilingualLabel(`${agent.name} 超时时间`, `${agent.name} timeout`),
      description:
        `agent ${agent.name} 单次调用的最长运行时间，单位毫秒。这个值限制单次 agent 调用最长执行时间；过短会打断正常长任务，过长会让卡住的任务占用队列更久。 / Maximum runtime in milliseconds for agent ${agent.name} before the daemon treats a turn as timed out. Too low interrupts legitimate long tasks; too high keeps stuck tasks occupying the queue longer.`,
      category: `Agent ${agent.name}`,
      path: `${base}.timeoutMs`,
      value: agent.timeoutMs,
      valueKind: 'number',
    }),
  ];
  if (agent.backend === 'codex') {
    return [
      ...common,
      field({
        key: `${base}.codex.workingDir`,
        label: bilingualLabel(`${agent.name} 工作目录`, `${agent.name} workingDir`),
        description:
          `Codex agent ${agent.name} 的默认 working directory。作为会话未显式设置 workingDir 时的项目根目录；路径错误会导致命令在错误目录运行或无法启动。 / Default working directory for Codex agent ${agent.name}. It is the project root when a session does not override workingDir. Wrong paths can run commands in the wrong directory or prevent startup.`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.workingDir`,
        value: agent.codex.workingDir,
        valueKind: 'string',
      }),
      field({
        key: `${base}.codex.bin`,
        label: bilingualLabel(`${agent.name} Codex 可执行文件`, `${agent.name} codex bin`),
        description:
          `Codex agent ${agent.name} 使用的 executable path 或 command name。修改会影响 daemon 如何启动 Codex CLI；错误值会导致 agent spawn 失败，属于高风险运行边界。 / Executable path or command name for Codex agent ${agent.name}. It controls how the daemon starts Codex CLI. Wrong values cause agent spawn failures and are a high-risk runtime boundary.`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.bin`,
        value: agent.codex.bin,
        valueKind: 'string',
      }),
      field({
        key: `${base}.codex.model`,
        label: bilingualLabel(`${agent.name} 模型`, `${agent.name} model`),
        description:
          `Codex agent ${agent.name} 的可选 model override。留空时使用 Codex CLI 默认模型；填写后会影响质量、速度和成本，需确认当前 Codex CLI 支持该模型名。 / Optional model override for Codex agent ${agent.name}. Empty uses the Codex CLI default. Setting it affects quality, latency, and cost, and the model name must be supported by the current Codex CLI.`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.model`,
        value: agent.codex.model ?? '',
        valueKind: 'string',
      }),
      field({
        key: `${base}.codex.sandbox`,
        label: bilingualLabel(`${agent.name} 沙箱`, `${agent.name} sandbox`),
        description:
          `Codex agent ${agent.name} 的 filesystem sandbox mode。read-only 最安全但不能写文件；workspace-write 允许写工作区；danger-full-access 解除文件系统限制，风险最高。 / Filesystem sandbox mode for Codex agent ${agent.name}. read-only is safest but cannot write files; workspace-write allows workspace edits; danger-full-access removes filesystem restrictions and is highest risk.`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.sandbox`,
        value: agent.codex.sandbox,
        valueKind: 'enum',
        options: ['read-only', 'workspace-write', 'danger-full-access'],
      }),
      field({
        key: `${base}.codex.addDirs`,
        label: bilingualLabel(`${agent.name} 额外目录`, `${agent.name} addDirs`),
        description:
          `额外暴露给 Codex agent ${agent.name} 的 directories。用于让 agent 读取或操作工作区外的路径；每增加一个目录都会扩大文件访问边界，需避免包含 secrets 或无关数据。 / Additional directories exposed to Codex agent ${agent.name}. It lets the agent read or operate outside the main workspace. Each directory broadens file access and should avoid secrets or unrelated data.`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.addDirs`,
        value: agent.codex.addDirs,
        valueKind: 'string-list',
      }),
      field({
        key: `${base}.codex.loadUserConfig`,
        label: bilingualLabel(
          `${agent.name} 加载用户配置`,
          `${agent.name} load user config`,
        ),
        description:
          `控制 Codex agent ${agent.name} 是否加载用户级 Codex config。开启后会继承用户级模型、工具或行为偏好；关闭后运行更可预测。 / Controls whether Codex agent ${agent.name} loads the user's Codex config. Enabling it inherits user-level model, tool, or behavior preferences; disabling it makes runtime behavior more predictable.`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.loadUserConfig`,
        value: agent.codex.loadUserConfig,
        valueKind: 'boolean',
      }),
      field({
        key: `${base}.codex.loadRules`,
        label: bilingualLabel(`${agent.name} 加载规则`, `${agent.name} load rules`),
        description:
          `控制 Codex agent ${agent.name} 是否加载 project/user rules。开启后 agent 会遵循额外规则文件；关闭后可减少隐式行为差异，但可能丢失项目约定。 / Controls whether Codex agent ${agent.name} loads project or user rules. Enabling it applies additional rule files; disabling it reduces implicit behavior differences but can drop project conventions.`,
        category: `Agent ${agent.name}`,
        path: `${base}.codex.loadRules`,
        value: agent.codex.loadRules,
        valueKind: 'boolean',
      }),
    ];
  }
  return [
    ...common,
    field({
      key: `${base}.claudeCode.workingDir`,
      label: bilingualLabel(`${agent.name} 工作目录`, `${agent.name} workingDir`),
      description:
        `Claude Code agent ${agent.name} 的默认 working directory。作为会话未显式设置 workingDir 时的项目根目录；路径错误会导致命令在错误目录运行或无法启动。 / Default working directory for Claude Code agent ${agent.name}. It is the project root when a session does not override workingDir. Wrong paths can run commands in the wrong directory or prevent startup.`,
      category: `Agent ${agent.name}`,
      path: `${base}.claudeCode.workingDir`,
      value: agent.claudeCode.workingDir,
      valueKind: 'string',
    }),
    field({
      key: `${base}.claudeCode.bin`,
      label: bilingualLabel(`${agent.name} Claude 可执行文件`, `${agent.name} Claude bin`),
      description:
        `Claude Code agent ${agent.name} 使用的 executable path 或 command name。修改会影响 daemon 如何启动 Claude Code CLI；错误值会导致 agent spawn 失败，属于高风险运行边界。 / Executable path or command name for Claude Code agent ${agent.name}. It controls how the daemon starts Claude Code CLI. Wrong values cause agent spawn failures and are a high-risk runtime boundary.`,
      category: `Agent ${agent.name}`,
      path: `${base}.claudeCode.bin`,
      value: agent.claudeCode.bin,
      valueKind: 'string',
    }),
    field({
      key: `${base}.claudeCode.allowedTools`,
      label: bilingualLabel(`${agent.name} 允许工具`, `${agent.name} allowed tools`),
      description:
        `Claude Code agent ${agent.name} 的 allowed tool list。该列表限制或放开 Claude Code 可调用的工具；配置过宽会扩大操作能力，配置过窄会导致任务无法完成。 / Allowed tool list for Claude Code agent ${agent.name}. It constrains or enables tools Claude Code may call. Too broad expands operational capability; too narrow can prevent tasks from completing.`,
      category: `Agent ${agent.name}`,
      path: `${base}.claudeCode.allowedTools`,
      value: agent.claudeCode.allowedTools,
      valueKind: 'string-list',
    }),
    field({
      key: `${base}.claudeCode.permissionLevel`,
      label: bilingualLabel(
        `${agent.name} 权限级别`,
        `${agent.name} permission level`,
      ),
      description:
        `传给 Claude Code agent ${agent.name} 的 permission level。非 default 值可能减少确认提示或放宽工具执行边界；bypassPermissions 风险最高，修改前需确认运行环境隔离。 / Permission level passed to Claude Code agent ${agent.name}. Non-default values can reduce prompts or loosen tool execution boundaries; bypassPermissions is highest risk and requires runtime isolation review.`,
      category: `Agent ${agent.name}`,
      path: `${base}.claudeCode.permissionLevel`,
      value: agent.claudeCode.permissionLevel,
      valueKind: 'enum',
      options: ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
    }),
  ];
}

function bindingFields(
  binding: BindingConfig,
  index: number,
  config: AgentNexusConfig,
): DaemonConfigEditableField[] {
  const base = `bindings[${index}]`;
  const category = `Binding ${binding.name}`;
  return [
    field({
      key: `${base}.name`,
      label: bilingualLabel(`${binding.name} 名称`, `${binding.name} name`),
      description:
        `路由 ${binding.name} 的 stable binding name。用于日志、诊断和用户可见路由标识；重命名会影响排查和配置引用，但不直接改变匹配规则。 / Stable binding name for route ${binding.name}. It is used in logs, diagnostics, and user-visible route labels. Renaming affects troubleshooting and references but does not directly change match rules.`,
      category,
      path: `${base}.name`,
      value: binding.name,
      valueKind: 'string',
    }),
    field({
      key: `${base}.platformName`,
      label: bilingualLabel(`${binding.name} 平台`, `${binding.name} platform`),
      description:
        `binding ${binding.name} 选择的 platform instance。修改会把该路由指向另一个 platform bot；如果运行中 platform 或 agent owner 集合变化，保存可能成功但需要重启才能安全生效。 / Platform instance selected by binding ${binding.name}. Changing it routes this binding to another platform bot. If running platform or agent-owner sets change, saving may succeed but safe activation can require restart.`,
      category,
      path: `${base}.platformName`,
      value: binding.platformName,
      valueKind: 'enum',
      options: config.platforms.map((platform) => platform.name),
    }),
    field({
      key: `${base}.agentName`,
      label: bilingualLabel(`${binding.name} agent`, `${binding.name} agent`),
      description:
        `binding ${binding.name} 选择的 agent。修改会让匹配到该 binding 的消息进入另一个 agent；如果 agent owner 集合变化，slash command registration 与路由可能需要重启保持一致。 / Agent selected by binding ${binding.name}. Changing it sends matching messages to another agent. If the agent-owner set changes, slash command registration and routing may require restart to stay consistent.`,
      category,
      path: `${base}.agentName`,
      value: binding.agentName,
      valueKind: 'enum',
      options: config.agents.map((agent) => agent.name),
    }),
    field({
      key: `${base}.match.discord.channelIds`,
      label: bilingualLabel(`${binding.name} 频道 ID`, `${binding.name} channel IDs`),
      description:
        `binding ${binding.name} 匹配的 Discord channel/thread IDs。只有这些 channel 或 thread 的事件会走该路由；修改后可热重载，但必须避免多个 binding 同时匹配同一事件。 / Discord channel or thread IDs matched by binding ${binding.name}. Only events from these channels or threads use this route. This can hot-reload, but avoid multiple bindings matching the same event.`,
      category,
      path: `${base}.match.discord.channelIds`,
      value: binding.match.discord.channelIds,
      valueKind: 'string-list',
    }),
  ];
}

function daemonCommandFields(config: AgentNexusConfig): DaemonConfigEditableField[] {
  const commandRegistry = config.daemon.commandRegistry;
  const category = 'Daemon command registry';
  return [
    field({
      key: 'daemon.commandRegistry.registration.enabled',
      label: bilingualLabel('命令注册已启用', 'Command registration enabled'),
      description: descriptionForPath('daemon.commandRegistry.registration.enabled'),
      category,
      path: 'daemon.commandRegistry.registration.enabled',
      value: commandRegistry.registration.enabled,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.commandRegistry.registration.applyTimeoutMs',
      label: bilingualLabel('命令注册超时', 'Command registration timeout'),
      description: descriptionForPath(
        'daemon.commandRegistry.registration.applyTimeoutMs',
      ),
      category,
      path: 'daemon.commandRegistry.registration.applyTimeoutMs',
      value: commandRegistry.registration.applyTimeoutMs,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.commandRegistry.registration.retry.maxAttempts',
      label: bilingualLabel(
        '命令注册重试次数',
        'Command registration retry attempts',
      ),
      description: descriptionForPath(
        'daemon.commandRegistry.registration.retry.maxAttempts',
      ),
      category,
      path: 'daemon.commandRegistry.registration.retry.maxAttempts',
      value: commandRegistry.registration.retry.maxAttempts,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.commandRegistry.registration.retry.backoffMs',
      label: bilingualLabel(
        '命令注册重试间隔',
        'Command registration retry backoff',
      ),
      description: descriptionForPath(
        'daemon.commandRegistry.registration.retry.backoffMs',
      ),
      category,
      path: 'daemon.commandRegistry.registration.retry.backoffMs',
      value: commandRegistry.registration.retry.backoffMs,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.commandRegistry.aliases.singleAgent.enabled',
      label: bilingualLabel('单 agent 裸别名', 'Single-agent bare aliases'),
      description: descriptionForPath(
        'daemon.commandRegistry.aliases.singleAgent.enabled',
      ),
      category,
      path: 'daemon.commandRegistry.aliases.singleAgent.enabled',
      value: commandRegistry.aliases.singleAgent.enabled,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.commandRegistry.aliases.legacy.replyMode',
      label: bilingualLabel('旧 reply-mode 别名', 'Legacy reply-mode alias'),
      description: descriptionForPath('daemon.commandRegistry.aliases.legacy.replyMode'),
      category,
      path: 'daemon.commandRegistry.aliases.legacy.replyMode',
      value: commandRegistry.aliases.legacy.replyMode,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.commandRegistry.textPrefixes.newSession',
      label: bilingualLabel('文本前缀 /new', 'Text prefix /new'),
      description: descriptionForPath('daemon.commandRegistry.textPrefixes.newSession'),
      category,
      path: 'daemon.commandRegistry.textPrefixes.newSession',
      value: commandRegistry.textPrefixes.newSession,
      valueKind: 'boolean',
    }),
  ];
}

function trajectoryFields(config: AgentNexusConfig): DaemonConfigEditableField[] {
  const trajectory = config.daemon.trajectory;
  const externalImport = trajectory.externalImport;
  const providerCapture = trajectory.providerCapture;
  const category = 'Daemon trajectory';
  return [
    field({
      key: 'daemon.trajectory.enabled',
      label: bilingualLabel('Trajectory 已启用', 'Trajectory enabled'),
      description: descriptionForPath('daemon.trajectory.enabled'),
      category,
      path: 'daemon.trajectory.enabled',
      value: trajectory.enabled,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.trajectory.externalImport.enabled',
      label: bilingualLabel('外部导入已启用', 'External import enabled'),
      description: descriptionForPath('daemon.trajectory.externalImport.enabled'),
      category,
      path: 'daemon.trajectory.externalImport.enabled',
      value: externalImport.enabled,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.trajectory.externalImport.sources',
      label: bilingualLabel('外部导入来源', 'External import sources'),
      description: descriptionForPath('daemon.trajectory.externalImport.sources'),
      category,
      path: 'daemon.trajectory.externalImport.sources',
      value: externalImport.sources,
      valueKind: 'json',
    }),
    field({
      key: 'daemon.trajectory.externalImport.metadataOnlyDiscovery',
      label: bilingualLabel('仅发现 metadata', 'Metadata-only discovery'),
      description: descriptionForPath(
        'daemon.trajectory.externalImport.metadataOnlyDiscovery',
      ),
      category,
      path: 'daemon.trajectory.externalImport.metadataOnlyDiscovery',
      value: externalImport.metadataOnlyDiscovery,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.trajectory.externalImport.importContent',
      label: bilingualLabel('外部导入正文', 'External import content'),
      description: descriptionForPath('daemon.trajectory.externalImport.importContent'),
      category,
      path: 'daemon.trajectory.externalImport.importContent',
      value: externalImport.importContent,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.trajectory.externalImport.maxFileBytes',
      label: bilingualLabel(
        '外部导入单文件字节上限',
        'External import max file bytes',
      ),
      description: descriptionForPath('daemon.trajectory.externalImport.maxFileBytes'),
      category,
      path: 'daemon.trajectory.externalImport.maxFileBytes',
      value: externalImport.maxFileBytes,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.trajectory.externalImport.maxRecordsPerSession',
      label: bilingualLabel(
        '外部导入记录上限',
        'External import max records',
      ),
      description: descriptionForPath(
        'daemon.trajectory.externalImport.maxRecordsPerSession',
      ),
      category,
      path: 'daemon.trajectory.externalImport.maxRecordsPerSession',
      value: externalImport.maxRecordsPerSession,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.trajectory.externalImport.maxAgeDays',
      label: bilingualLabel(
        '外部导入最大历史天数',
        'External import max age days',
      ),
      description: descriptionForPath('daemon.trajectory.externalImport.maxAgeDays'),
      category,
      path: 'daemon.trajectory.externalImport.maxAgeDays',
      value: externalImport.maxAgeDays,
      valueKind: 'json',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.enabled',
      label: bilingualLabel('Provider capture 已启用', 'Provider capture enabled'),
      description: descriptionForPath('daemon.trajectory.providerCapture.enabled'),
      category,
      path: 'daemon.trajectory.providerCapture.enabled',
      value: providerCapture.enabled,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.mode',
      label: bilingualLabel('Provider capture 模式', 'Provider capture mode'),
      description: descriptionForPath('daemon.trajectory.providerCapture.mode'),
      category,
      path: 'daemon.trajectory.providerCapture.mode',
      value: providerCapture.mode,
      valueKind: 'enum',
      options: ['reverse-proxy', 'forward-proxy', 'transcript-only'],
    }),
    field({
      key: 'daemon.trajectory.providerCapture.bindHost',
      label: bilingualLabel(
        'Provider capture 绑定地址',
        'Provider capture bind host',
      ),
      description: descriptionForPath('daemon.trajectory.providerCapture.bindHost'),
      category,
      path: 'daemon.trajectory.providerCapture.bindHost',
      value: providerCapture.bindHost,
      valueKind: 'string',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.port',
      label: bilingualLabel('Provider capture 端口', 'Provider capture port'),
      description: descriptionForPath('daemon.trajectory.providerCapture.port'),
      category,
      path: 'daemon.trajectory.providerCapture.port',
      value: providerCapture.port,
      valueKind: 'json',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.storeRawStreams',
      label: bilingualLabel(
        'Provider capture 原始流',
        'Provider capture raw streams',
      ),
      description: descriptionForPath(
        'daemon.trajectory.providerCapture.storeRawStreams',
      ),
      category,
      path: 'daemon.trajectory.providerCapture.storeRawStreams',
      value: providerCapture.storeRawStreams,
      valueKind: 'boolean',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.maxRequestBytes',
      label: bilingualLabel(
        'Provider capture 请求字节上限',
        'Provider capture max request bytes',
      ),
      description: descriptionForPath(
        'daemon.trajectory.providerCapture.maxRequestBytes',
      ),
      category,
      path: 'daemon.trajectory.providerCapture.maxRequestBytes',
      value: providerCapture.maxRequestBytes,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.maxResponseBytes',
      label: bilingualLabel(
        'Provider capture 响应字节上限',
        'Provider capture max response bytes',
      ),
      description: descriptionForPath(
        'daemon.trajectory.providerCapture.maxResponseBytes',
      ),
      category,
      path: 'daemon.trajectory.providerCapture.maxResponseBytes',
      value: providerCapture.maxResponseBytes,
      valueKind: 'number',
    }),
    field({
      key: 'daemon.trajectory.providerCapture.retentionDays',
      label: bilingualLabel(
        'Provider capture 保留天数',
        'Provider capture retention days',
      ),
      description: descriptionForPath('daemon.trajectory.providerCapture.retentionDays'),
      category,
      path: 'daemon.trajectory.providerCapture.retentionDays',
      value: providerCapture.retentionDays,
      valueKind: 'number',
    }),
  ];
}

function configEditableFields(config: AgentNexusConfig): DaemonConfigEditableField[] {
  return [
    field({
      key: 'ui.toolMessages',
      label: bilingualLabel('工具消息显示', 'UI tool messages'),
      description: descriptionForPath('ui.toolMessages'),
      category: 'Hot behavior',
      path: 'ui.toolMessages',
      value: config.ui.toolMessages,
      valueKind: 'enum',
      options: ['append', 'compact'],
    }),
    ...daemonCommandFields(config),
    ...trajectoryFields(config),
    ...config.bindings.flatMap((binding, index) =>
      bindingFields(binding, index, config),
    ),
    ...config.platforms.flatMap((platform, index) => platformFields(platform, index)),
    ...config.agents.flatMap((agent, index) => agentFields(agent, index)),
    field({
      key: 'log.level',
      label: bilingualLabel('日志级别', 'Log level'),
      description: descriptionForPath('log.level'),
      category: 'Process',
      path: 'log.level',
      value: config.log.level,
      valueKind: 'enum',
      options: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
    }),
  ];
}

function previewWarnings(path: string, newValue: unknown): string[] {
  const warnings: string[] = [];
  if (riskForPath(path) === 'high') {
    warnings.push('high-risk config boundary; review before applying');
  }
  if (path.endsWith('.sandbox') && newValue === 'danger-full-access') {
    warnings.push('danger-full-access removes filesystem sandbox protection');
  }
  if (path.endsWith('.permissionLevel') && newValue !== 'default') {
    warnings.push('non-default Claude Code permission level weakens tool isolation');
  }
  if (/^bindings\[\d+\]\.(agentName|platformName)$/.test(path)) {
    warnings.push('binding target changes may save but require restart if the agent owner set changes');
  }
  return warnings;
}

function reloadFailedAfterEditMessage(
  editResult: ConfigFileEditResult,
  reloadResult: DaemonConfigReloadResult,
): string {
  const previousConfigKeptPrefix = '[config reload failed] previous config kept:\n';
  const reason = reloadResult.message.startsWith(previousConfigKeptPrefix)
    ? reloadResult.message.slice(previousConfigKeptPrefix.length)
    : reloadResult.message;
  return (
    `${editResult.message}\n` +
    `[config reload failed] config saved; running config kept:\n${reason}`
  );
}

export function createConfigEditor(
  opts: CreateConfigEditorOptions,
): DaemonConfigEditor {
  return async (input) => {
    let editResult: ConfigFileEditResult;
    try {
      editResult = await opts.edit({
        path: input.path,
        value: input.value,
      });
    } catch (err) {
      const reason = errorMessage(err);
      opts.logger.warn(
        { err, path: input.path, userId: input.userId, channelId: input.channelId },
        'config_edit_rejected',
      );
      return {
        status: 'rejected',
        message: `[config edit rejected]\n${reason}`,
      };
    }

    try {
      const reloadResult = await opts.reload();
      if (reloadResult.status === 'failed') {
        return {
          status: 'edited',
          message: reloadFailedAfterEditMessage(editResult, reloadResult),
        };
      }
      return {
        status: 'edited',
        message: `${editResult.message}\n${reloadResult.message}`,
      };
    } catch (err) {
      const reason = errorMessage(err);
      opts.logger.error({ err, path: input.path }, 'config_edit_reload_failed');
      return {
        status: 'edited',
        message:
          `${editResult.message}\n` +
          `[config reload failed] config saved; running config kept:\n${reason}`,
      };
    }
  };
}

export function createConfigFieldsProvider(
  opts: CreateConfigFieldsProviderOptions,
): DaemonConfigFieldsProvider {
  return async () => ({
    fields: configEditableFields(await opts.load()),
  });
}

export function createConfigPreviewer(
  opts: CreateConfigPreviewerOptions,
): DaemonConfigPreviewer {
  return async (input) => {
    const preview = await opts.preview({
      path: input.path,
      value: input.value,
      platformName: input.platformName,
      platform: input.platform,
      userId: input.userId,
      channelId: input.channelId,
      ...(input.guildId ? { guildId: input.guildId } : {}),
      ...(input.initiatorRoleIds ? { initiatorRoleIds: input.initiatorRoleIds } : {}),
      ...(input.threadParentChannelId
        ? { threadParentChannelId: input.threadParentChannelId }
        : {}),
    });
    return {
      ...preview,
      effect: effectForPath(preview.path),
      warnings: previewWarnings(preview.path, preview.newValue),
    };
  };
}

/** 仅重启生效 section 的变更检测；热生效字段（auth / textPrefixes）剔除后再比较 */
function restartOnlyChanges(
  prev: AgentNexusConfig,
  next: AgentNexusConfig,
): string[] {
  const platformsSansAuth = (config: AgentNexusConfig) =>
    config.platforms.map(({ auth: _auth, ...rest }) => rest);
  const daemonSansTextPrefixes = (config: AgentNexusConfig) => ({
    ...config.daemon,
    commandRegistry: {
      ...config.daemon.commandRegistry,
      textPrefixes: {
        ...config.daemon.commandRegistry.textPrefixes,
        newSession: undefined,
      },
    },
  });
  const sections: string[] = [];
  if (
    JSON.stringify(platformsSansAuth(prev)) !==
    JSON.stringify(platformsSansAuth(next))
  ) {
    sections.push('platforms');
  }
  if (JSON.stringify(prev.agents) !== JSON.stringify(next.agents)) {
    sections.push('agents');
  }
  if (
    JSON.stringify(daemonSansTextPrefixes(prev)) !==
    JSON.stringify(daemonSansTextPrefixes(next))
  ) {
    sections.push('daemon');
  }
  if (JSON.stringify(prev.log) !== JSON.stringify(next.log)) {
    sections.push('log');
  }
  return sections;
}

export function createConfigReloader(
  opts: CreateConfigReloaderOptions,
): DaemonConfigReloader {
  let current = opts.initialConfig;
  return async (): Promise<DaemonConfigReloadResult> => {
    let next: AgentNexusConfig;
    try {
      next = await opts.load();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      opts.logger.error({ err }, 'config_reload_failed');
      return failed(reason);
    }

    const running = new Set(opts.runningAgentNames);
    const missingAgents = [
      ...new Set(
        next.bindings
          .filter((binding) => !running.has(binding.agentName))
          .map((binding) => binding.agentName),
      ),
    ];
    if (missingAgents.length > 0) {
      return failed(
        `bindings 引用了未运行的 agent：${missingAgents.join(', ')}（agents[] 变更需重启生效）`,
      );
    }

    const platformNames = new Set(next.platforms.map((platform) => platform.name));
    const missingPlatforms = opts.targets
      .filter((target) => !platformNames.has(target.platformName))
      .map((target) => target.platformName);
    if (missingPlatforms.length > 0) {
      return failed(
        `新配置缺少运行中的 platform：${missingPlatforms.join(', ')}（platforms[] 变更需重启生效）`,
      );
    }

    // slash command 注册集按启动时各 platform 的 agent owner 集合生成，
    // 不在 reload 事务内；owner 集合变化会让已注册命令与路由失配，按失败处理
    const ownerSet = (config: AgentNexusConfig, platformName: string) =>
      [...agentOwnersForPlatform(config, platformName)].sort().join(',');
    const ownerChangedPlatforms = opts.targets
      .map((target) => target.platformName)
      .filter((name) => ownerSet(current, name) !== ownerSet(next, name));
    if (ownerChangedPlatforms.length > 0) {
      return failed(
        `bindings 变更改变了 platform 的 agent owner 集合：${ownerChangedPlatforms.join(', ')}；` +
          'slash command 注册集不在 reload 事务内，需重启生效',
      );
    }

    const routingTable = buildRoutingTable(next);
    const authByPlatform = new Map(
      next.platforms.map((platform) => [platform.name, platform.auth]),
    );
    for (const target of opts.targets) {
      const platformAuth = authByPlatform.get(target.platformName);
      if (!platformAuth) continue; // missingPlatforms 已兜住；保留给类型收窄
      target.applyRuntimeUpdate({
        routingTable,
        platformAuth,
        toolMessageMode: next.ui.toolMessages,
        newSessionTextPrefix: next.daemon.commandRegistry.textPrefixes.newSession,
      });
    }

    const restartSections = restartOnlyChanges(current, next);
    current = next;
    opts.logger.info(
      { targets: opts.targets.length, restartSections },
      'config_reloaded',
    );
    const restartNote =
      restartSections.length > 0
        ? `\nrestart required for: ${restartSections.join(', ')}`
        : '';
    return {
      status: 'reloaded',
      message: `[config reloaded] applied: bindings, auth, ui, text prefixes${restartNote}`,
    };
  };
}
