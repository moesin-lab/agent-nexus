export const TOOL_MESSAGE_MODES = ['append', 'compact'] as const;
export type ToolMessageMode = (typeof TOOL_MESSAGE_MODES)[number];

export interface DaemonConfig {
  toolMessages: ToolMessageMode;
}

export class DaemonConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonConfigError';
  }
}

export function parseDaemonConfig(raw: unknown): DaemonConfig {
  const ui = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const toolMessagesRaw = ui['toolMessages'];
  if (
    toolMessagesRaw !== undefined &&
    !TOOL_MESSAGE_MODES.includes(toolMessagesRaw as ToolMessageMode)
  ) {
    throw new DaemonConfigError(
      `字段 ui.toolMessages 必须是 ${TOOL_MESSAGE_MODES.map((v) => `"${v}"`).join(' / ')}`,
    );
  }
  return {
    toolMessages: (toolMessagesRaw as ToolMessageMode | undefined) ?? 'append',
  };
}
