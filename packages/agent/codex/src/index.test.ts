import { describe, expect, it } from 'vitest';
import { createCodexRuntime } from './index.js';

describe('createCodexRuntime', () => {
  it('返回 codex runtime name 与已验证 capability', () => {
    const runtime = createCodexRuntime();

    expect(runtime.name()).toBe('codex');
    expect(runtime.capabilities()).toEqual({
      supportsThinking: false,
      supportsStreaming: false,
      supportsToolCallEvents: true,
      supportsInterrupt: true,
      supportsStdinInterrupt: false,
      supportsNativeToolWhitelist: false,
    });
  });
});
