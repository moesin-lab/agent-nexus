import { describe, expect, it } from 'vitest';
import {
  DaemonConfigError,
  DEFAULT_DAEMON_RUNTIME_CONFIG,
  parseDaemonConfig,
  parseDaemonRuntimeConfig,
  parsePlatformAuthConfig,
} from './config.js';

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

describe('daemon runtime config', () => {
  it('缺省 commandRegistry 配置保持兼容默认值', () => {
    expect(parseDaemonRuntimeConfig(undefined)).toEqual(
      DEFAULT_DAEMON_RUNTIME_CONFIG,
    );
    expect(parseDaemonRuntimeConfig({})).toEqual(DEFAULT_DAEMON_RUNTIME_CONFIG);
  });

  it('缺省 trajectory 配置按安全默认值补齐', () => {
    expect(parseDaemonRuntimeConfig(undefined).trajectory).toEqual({
      enabled: true,
      externalImport: {
        enabled: false,
        sources: [],
        metadataOnlyDiscovery: true,
        importContent: false,
        maxFileBytes: 10485760,
        maxRecordsPerSession: 20000,
        maxAgeDays: null,
      },
      providerCapture: {
        enabled: false,
        mode: 'transcript-only',
        bindHost: '127.0.0.1',
        port: null,
        storeRawStreams: false,
        maxRequestBytes: 1048576,
        maxResponseBytes: 4194304,
        retentionDays: 30,
      },
      retention: {
        importedSegmentsDays: 90,
        providerObservationsDays: 30,
      },
    });
  });

  it('解析 commandRegistry 显式配置并补齐未写字段', () => {
    expect(
      parseDaemonRuntimeConfig({
        commandRegistry: {
          registration: {
            enabled: false,
            applyTimeoutMs: 5000,
            retry: { maxAttempts: 3 },
          },
          aliases: {
            singleAgent: { enabled: false },
            legacy: { replyMode: false },
          },
          textPrefixes: { newSession: false },
        },
      }),
    ).toMatchObject({
      commandRegistry: {
        registration: {
          enabled: false,
          applyTimeoutMs: 5000,
          retry: { maxAttempts: 3, backoffMs: 1000 },
        },
        aliases: {
          singleAgent: { enabled: false },
          legacy: { replyMode: false },
        },
        textPrefixes: { newSession: false },
      },
    });
  });

  it('解析 trajectory 显式配置并补齐未写字段', () => {
    expect(
      parseDaemonRuntimeConfig({
        trajectory: {
          enabled: false,
          externalImport: {
            enabled: true,
            sources: [
              {
                adapter: 'codex-cli-jsonl',
                root: '/workspace/project/.codex/sessions',
                projectPathAllowlist: ['/workspace/project'],
              },
            ],
            maxAgeDays: 30,
          },
          providerCapture: {
            enabled: true,
            mode: 'reverse-proxy',
            port: 7010,
          },
          retention: {
            importedSegmentsDays: null,
          },
        },
      }).trajectory,
    ).toEqual({
      enabled: false,
      externalImport: {
        enabled: true,
        sources: [
          {
            adapter: 'codex-cli-jsonl',
            root: '/workspace/project/.codex/sessions',
            projectPathAllowlist: ['/workspace/project'],
          },
        ],
        metadataOnlyDiscovery: true,
        importContent: false,
        maxFileBytes: 10485760,
        maxRecordsPerSession: 20000,
        maxAgeDays: 30,
      },
      providerCapture: {
        enabled: true,
        mode: 'reverse-proxy',
        bindHost: '127.0.0.1',
        port: 7010,
        storeRawStreams: false,
        maxRequestBytes: 1048576,
        maxResponseBytes: 4194304,
        retentionDays: 30,
      },
      retention: {
        importedSegmentsDays: null,
        providerObservationsDays: 30,
      },
    });
  });

  it('commandRegistry 数值和未知字段 fail-closed', () => {
    expect(() => parseDaemonRuntimeConfig(5)).toThrow(/字段 daemon 必须是对象/);

    expect(() =>
      parseDaemonRuntimeConfig({
        commandRegistry: {
          registration: { applyTimeoutMs: 0 },
        },
      }),
    ).toThrow(/daemon\.commandRegistry\.registration\.applyTimeoutMs/);

    expect(() =>
      parseDaemonRuntimeConfig({
        commandRegistry: {
          aliases: { singleAgent: { enabled: true, mode: 'auto' } },
        },
      }),
    ).toThrow(/daemon\.commandRegistry\.aliases\.singleAgent\.mode/);
  });

  it('trajectory 未知字段、未知 adapter、非 loopback capture 绑定 fail-closed', () => {
    expect(() =>
      parseDaemonRuntimeConfig({
        trajectory: { providerCapture: { stream: true } },
      }),
    ).toThrow(/daemon\.trajectory\.providerCapture\.stream/);

    expect(() =>
      parseDaemonRuntimeConfig({
        trajectory: {
          externalImport: {
            sources: [{ adapter: 'unknown-jsonl', root: '/workspace/project' }],
          },
        },
      }),
    ).toThrow(/daemon\.trajectory\.externalImport\.sources\[0\]\.adapter/);

    expect(() =>
      parseDaemonRuntimeConfig({
        trajectory: {
          externalImport: {
            sources: [{ root: '/workspace/project' }],
          },
        },
      }),
    ).toThrow(/daemon\.trajectory\.externalImport\.sources\[0\]\.adapter/);

    expect(() =>
      parseDaemonRuntimeConfig({
        trajectory: {
          providerCapture: {
            enabled: true,
            mode: 'reverse-proxy',
            bindHost: '0.0.0.0',
          },
        },
      }),
    ).toThrow(/daemon\.trajectory\.providerCapture\.bindHost/);

    expect(() =>
      parseDaemonRuntimeConfig({
        trajectory: {
          providerCapture: { mode: 'mirror' },
        },
      }),
    ).toThrow(/daemon\.trajectory\.providerCapture\.mode/);

    expect(() =>
      parseDaemonRuntimeConfig({
        trajectory: {
          providerCapture: { port: 70000 },
        },
      }),
    ).toThrow(/daemon\.trajectory\.providerCapture\.port/);

    expect(() =>
      parseDaemonRuntimeConfig({
        trajectory: {
          externalImport: { maxFileBytes: 0 },
        },
      }),
    ).toThrow(/daemon\.trajectory\.externalImport\.maxFileBytes/);
  });
});

describe('platform auth config', () => {
  const validAuth = {
    allowlist: {
      userIds: ['U1'],
      roleIds: [],
      allowedGuildIds: ['G1'],
      allowedChannelIds: ['C1'],
      allowDM: false,
      requireMentionOrSlash: true,
    },
  };

  it('解析 platforms[].auth.allowlist 并保留显式字段', () => {
    expect(
      parsePlatformAuthConfig(validAuth, { path: 'platforms[0].auth' }),
    ).toEqual(validAuth);
  });

  it('allowDM / requireMentionOrSlash 缺省为 true，role/channel 列表缺省为空', () => {
    expect(
      parsePlatformAuthConfig(
        {
          allowlist: {
            userIds: ['U1'],
            allowedGuildIds: ['G1'],
          },
        },
        { path: 'platforms[0].auth' },
      ),
    ).toEqual({
      allowlist: {
        userIds: ['U1'],
        roleIds: [],
        allowedGuildIds: ['G1'],
        allowedChannelIds: [],
        allowDM: true,
        requireMentionOrSlash: true,
      },
    });
  });

  it('ID 列表允许缺省或空数组，但至少一个 ID 列表要非空', () => {
    expect(
      parsePlatformAuthConfig(
        { allowlist: { userIds: [], roleIds: ['R1'], allowedGuildIds: ['G1'] } },
        { path: 'platforms[0].auth' },
      ).allowlist,
    ).toMatchObject({
      userIds: [],
      roleIds: ['R1'],
      allowedGuildIds: ['G1'],
    });

    expect(() =>
      parsePlatformAuthConfig(
        {
          allowlist: {
            userIds: [],
            roleIds: [],
            allowedGuildIds: [],
            allowedChannelIds: [],
          },
        },
        { path: 'platforms[0].auth' },
      ),
    ).toThrow(/platforms\[0\]\.auth\.allowlist.*至少/);
  });

  it('未知 allowlist 字段 fail-closed', () => {
    expect(() =>
      parsePlatformAuthConfig(
        {
          allowlist: {
            userIds: ['U1'],
            allowedGuildIds: ['G1'],
            shared_channel_mode: true,
          },
        },
        { path: 'platforms[0].auth' },
      ),
    ).toThrow(/shared_channel_mode/);
  });
});
