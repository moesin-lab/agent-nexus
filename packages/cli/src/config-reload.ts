import type {
  DaemonConfigReloader,
  DaemonConfigReloadResult,
  EngineRuntimeUpdate,
  Logger,
} from '@agent-nexus/daemon';
import { buildRoutingTable, type AgentNexusConfig } from './config.js';

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

function failed(reason: string): DaemonConfigReloadResult {
  return {
    status: 'failed',
    message: `[config reload failed] previous config kept:\n${reason}`,
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
      textPrefixes: undefined,
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
