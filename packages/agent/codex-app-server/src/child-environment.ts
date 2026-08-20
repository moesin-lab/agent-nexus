const ALLOWED_CHILD_ENVIRONMENT = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
] as const;

export function buildCodexChildEnvironment(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ALLOWED_CHILD_ENVIRONMENT) {
    const value = source[name];
    if (typeof value === 'string' && value.length > 0) result[name] = value;
  }
  return result;
}
