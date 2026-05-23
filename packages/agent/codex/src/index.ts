export {
  CodexConfigError,
  DEFAULT_BIN,
  DEFAULT_SANDBOX,
  parseCodexConfig,
  SANDBOX_MODES,
  type CodexConfig,
  type CodexSandbox,
} from './config.js';
export {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  CodexCompatibilityProbeError,
  runCompatibilityProbe,
  type CodexCompatibilityProbeOptions,
} from './probe.js';

import type {
  AgentCapabilitySet,
  AgentEventHandler,
  AgentInput,
  AgentRuntime,
  AgentSession,
  SessionConfig,
  SessionKey,
} from '@agent-nexus/protocol';

const capabilities: AgentCapabilitySet = {
  supportsThinking: false,
  supportsStreaming: false,
  supportsToolCallEvents: true,
  supportsInterrupt: true,
  supportsStdinInterrupt: false,
  supportsNativeToolWhitelist: false,
};

function notImplemented(method: string): Error {
  return new Error(`Codex runtime ${method} is not implemented until P4`);
}

export function createCodexRuntime(): AgentRuntime {
  return {
    name(): string {
      return 'codex';
    },

    capabilities(): AgentCapabilitySet {
      return capabilities;
    },

    startSession(_key: SessionKey, _config: SessionConfig): AgentSession {
      throw notImplemented('startSession');
    },

    stopSession(_session: AgentSession): void {
      throw notImplemented('stopSession');
    },

    isAlive(_session: AgentSession): boolean {
      return false;
    },

    async sendInput(_session: AgentSession, _input: AgentInput): Promise<void> {
      throw notImplemented('sendInput');
    },

    onEvent(_session: AgentSession, _handler: AgentEventHandler): void {
      throw notImplemented('onEvent');
    },

    interrupt(_session: AgentSession): void {
      throw notImplemented('interrupt');
    },
  };
}
