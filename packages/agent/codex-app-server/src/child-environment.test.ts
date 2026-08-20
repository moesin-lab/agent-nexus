import { describe, expect, it } from 'vitest';
import { buildCodexChildEnvironment } from './child-environment.js';

describe('buildCodexChildEnvironment', () => {
  it('should_keep_only_operating_environment_and_drop_service_or_openai_secrets', () => {
    expect(
      buildCodexChildEnvironment({
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        TMPDIR: '/private/tmp',
        SSL_CERT_FILE: '/etc/certs.pem',
        OPENAI_API_KEY: 'openai-secret',
        FEISHU_APP_SECRET: 'lark-secret',
        LARK_APP_SECRET: 'lark-secret-2',
        DISCORD_TOKEN: 'discord-secret',
        DATABASE_URL: 'postgres://secret',
        HTTP_PROXY: 'http://user:password@proxy',
        NODE_OPTIONS: '--require malicious.js',
        CODEX_HOME: '/attacker/home',
        HOME: '/operator/home',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/private/tmp',
      SSL_CERT_FILE: '/etc/certs.pem',
    });
  });

  it('should_ignore_empty_or_non_string_values', () => {
    expect(buildCodexChildEnvironment({ PATH: '', LANG: undefined })).toEqual({});
  });
});
