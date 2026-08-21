import { describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerCompatibilityError,
  runCodexAppServerCompatibilityProbe,
  runCodexAppServerViewerCompatibilityProbe,
} from './probe.js';

describe('runCodexAppServerCompatibilityProbe', () => {
  it('should_accept_only_the_schema_pinned_codex_version_and_app_server_surface', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.146.0\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Usage: codex app-server [OPTIONS]\n  --listen <LISTEN>\n', stderr: '' });

    await expect(
      runCodexAppServerCompatibilityProbe({ bin: 'codex', runCommand }),
    ).resolves.toEqual({ codexVersion: '0.146.0' });
    expect(runCommand).toHaveBeenNthCalledWith(1, 'codex', ['--version']);
    expect(runCommand).toHaveBeenNthCalledWith(2, 'codex', ['app-server', '--help']);
  });

  it('should_fail_closed_on_an_unpinned_version_or_missing_stdio_listener', async () => {
    await expect(
      runCodexAppServerCompatibilityProbe({
        bin: 'codex',
        runCommand: async () => ({ stdout: 'codex-cli 0.147.0\n', stderr: '' }),
      }),
    ).rejects.toBeInstanceOf(CodexAppServerCompatibilityError);

    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.146.0\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Usage: codex app-server\n', stderr: '' });
    await expect(
      runCodexAppServerCompatibilityProbe({ bin: 'codex', runCommand }),
    ).rejects.toThrow(/--listen/);
  });
});

describe('runCodexAppServerViewerCompatibilityProbe', () => {
  it('should_require_the_authenticated_websocket_and_remote_tui_surfaces', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: '--listen <LISTEN>\n--ws-auth <MODE> [capability-token]\n--ws-token-file <PATH>\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: '--remote <ADDR>\n--remote-auth-token-env <ENV_VAR>\n',
        stderr: '',
      });

    await expect(
      runCodexAppServerViewerCompatibilityProbe({ bin: 'codex', runCommand }),
    ).resolves.toEqual({ viewerAvailable: true });
    expect(runCommand).toHaveBeenNthCalledWith(1, 'codex', ['app-server', '--help']);
    expect(runCommand).toHaveBeenNthCalledWith(2, 'codex', ['--help']);
  });

  it.each([
    ['--listen <LISTEN>\n--ws-token-file <PATH>\n', '--remote <ADDR>\n--remote-auth-token-env <ENV_VAR>\n'],
    ['--listen <LISTEN>\n--ws-auth <MODE>\n--ws-token-file <PATH>\n', '--remote <ADDR>\n--remote-auth-token-env <ENV_VAR>\n'],
    ['--listen <LISTEN>\n--ws-auth <MODE> [capability-token]\n--ws-token-file <PATH>\n', '--remote <ADDR>\n'],
  ])('should_fail_closed_when_a_viewer_surface_is_missing', async (serverHelp, clientHelp) => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: serverHelp, stderr: '' })
      .mockResolvedValueOnce({ stdout: clientHelp, stderr: '' });

    await expect(
      runCodexAppServerViewerCompatibilityProbe({ bin: 'codex', runCommand }),
    ).rejects.toBeInstanceOf(CodexAppServerCompatibilityError);
  });
});
