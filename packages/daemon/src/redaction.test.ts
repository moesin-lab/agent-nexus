import { describe, expect, it } from 'vitest';
import { redactText } from './redaction.js';

describe('redactText', () => {
  it('redacts env secrets, known token prefixes, and user home paths', () => {
    const output = redactText(
      'ANTHROPIC_API_KEY=sk-ant-abc123 token sk-ant-def456 path=/home/node/project/file.ts',
    );

    expect(output).toContain('ANTHROPIC_API_KEY=<redacted>');
    expect(output).toContain('<redacted:secret>');
    expect(output).toContain('path=~/project/file.ts');
    expect(output).not.toContain('sk-ant-abc123');
    expect(output).not.toContain('sk-ant-def456');
    expect(output).not.toContain('/home/node/project');
  });

  it('redacts Windows user profile paths', () => {
    expect(redactText('path=C:\\Users\\alice\\repo\\file.ts')).toBe(
      'path=~\\repo\\file.ts',
    );
  });
});
