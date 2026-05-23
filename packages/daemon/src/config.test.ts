import { describe, expect, it } from 'vitest';
import { DaemonConfigError, parseDaemonConfig } from './config.js';

describe('daemon config', () => {
  it('缺省 toolMessages → append', () => {
    expect(parseDaemonConfig(undefined).toolMessages).toBe('append');
    expect(parseDaemonConfig({}).toolMessages).toBe('append');
  });

  it.each(['append', 'compact'] as const)('显式 toolMessages=%s → 保留', (mode) => {
    expect(parseDaemonConfig({ toolMessages: mode }).toolMessages).toBe(mode);
  });

  it('toolMessages 非允许值 → DaemonConfigError', () => {
    expect(() => parseDaemonConfig({ toolMessages: 'hidden' })).toThrow(
      DaemonConfigError,
    );
    expect(() => parseDaemonConfig({ toolMessages: 'hidden' })).toThrow(
      /ui\.toolMessages/,
    );
  });
});
