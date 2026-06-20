export interface Redactor {
  redact(text: string): string;
}

const ENV_SECRET_RE = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET))=([^\s]+)/g;
const SECRET_PREFIX_RE = /\b(?:sk-ant-[A-Za-z0-9._-]+|MTk[A-Za-z0-9._-]+)\b/g;
const HOME_PATH_RE = /(?:\/home\/[^/\s]+|\/Users\/[^/\s]+)(\/[^\s]*)?/g;
const WINDOWS_USER_PATH_RE = /C:\\Users\\[^\\\s]+((?:\\[^\s\\]+)*)/g;

export function redactText(text: string): string {
  return text
    .replace(ENV_SECRET_RE, '$1=<redacted>')
    .replace(SECRET_PREFIX_RE, '<redacted:secret>')
    .replace(HOME_PATH_RE, (_match, rest: string | undefined) => {
      return `~${rest ?? ''}`;
    })
    .replace(WINDOWS_USER_PATH_RE, (_match, rest: string | undefined) => {
      return `~${rest ?? ''}`;
    });
}

export class BasicRedactor implements Redactor {
  redact(text: string): string {
    return redactText(text);
  }
}
