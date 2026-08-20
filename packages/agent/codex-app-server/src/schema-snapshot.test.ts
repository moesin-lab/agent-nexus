import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SERVER_NOTIFICATION_METHODS_0_146,
  SERVER_NOTIFICATION_OWNERSHIP_0_146,
} from './protocol-contract-0-146.js';

const SNAPSHOT_ROOT = fileURLToPath(
  new URL('../testdata/schema/0.146.0', import.meta.url),
);
const GENERATED_ROOT = join(SNAPSHOT_ROOT, 'generated');

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat().sort();
}

function collectMethodConstants(value: unknown, methods = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return methods;
  if (Array.isArray(value)) {
    for (const item of value) collectMethodConstants(item, methods);
    return methods;
  }
  const record = value as Record<string, unknown>;
  const properties = record['properties'];
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const method = (properties as Record<string, unknown>)['method'];
    if (method && typeof method === 'object' && !Array.isArray(method)) {
      const methodSchema = method as Record<string, unknown>;
      const constant = methodSchema['const'];
      if (typeof constant === 'string') methods.add(constant);
      const literals = methodSchema['enum'];
      if (Array.isArray(literals)) {
        for (const literal of literals) {
          if (typeof literal === 'string') methods.add(literal);
        }
      }
    }
  }
  for (const child of Object.values(record)) collectMethodConstants(child, methods);
  return methods;
}

function notificationOwnershipScopes(schema: unknown): Record<string, string> {
  const root = schema as {
    oneOf: Array<Record<string, unknown>>;
    definitions: Record<string, Record<string, unknown>>;
  };
  return Object.fromEntries(root.oneOf.map((variant) => {
    const properties = variant['properties'] as Record<string, Record<string, unknown>>;
    const method = (properties['method']!['enum'] as string[])[0]!;
    const reference = properties['params']!['$ref'] as string;
    const definition = root.definitions[reference.split('/').at(-1)!]!;
    const required = new Set((definition['required'] as string[] | undefined) ?? []);
    const params = (definition['properties'] as Record<string, unknown> | undefined) ?? {};
    let scope = 'connection';
    if (method === 'thread/started') scope = 'thread-object';
    else if (method === 'turn/started' || method === 'turn/completed') scope = 'turn-object';
    else if (method === 'item/started' || method === 'item/completed') scope = 'item-object';
    else if (required.has('itemId')) scope = 'item';
    else if (required.has('turnId')) scope = 'turn';
    else if (required.has('threadId')) scope = 'turnId' in params ? 'optional-turn' : 'thread';
    else if ('threadId' in params) scope = 'optional-thread';
    return [method, scope];
  }));
}

describe('Codex 0.146.0 stable schema snapshot', () => {
  it('is complete, reproducible, and covered by the committed hash manifest', async () => {
    const metadata = JSON.parse(
      await readFile(join(SNAPSHOT_ROOT, 'metadata.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(metadata).toEqual({
      codexVersion: '0.146.0',
      experimental: false,
      generationCommand: [
        'codex',
        'app-server',
        'generate-json-schema',
        '--out',
        '<OUTPUT_DIR>',
      ],
      generatedFileCount: 275,
      upstream: 'https://github.com/openai/codex',
      upstreamLicense: 'Apache-2.0',
    });

    const generated = await filesUnder(GENERATED_ROOT);
    expect(generated).toHaveLength(metadata['generatedFileCount'] as number);
    const actual = new Map(
      await Promise.all(
        generated.map(async (path) => [
          relative(GENERATED_ROOT, path),
          createHash('sha256').update(await readFile(path)).digest('hex'),
        ] as const),
      ),
    );
    const manifest = (await readFile(join(SNAPSHOT_ROOT, 'SHA256SUMS'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
        if (!match) throw new Error(`invalid snapshot manifest line: ${line}`);
        return [match[2]!, match[1]!] as const;
      });
    expect(manifest).toHaveLength(generated.length);
    expect(new Set(manifest.map(([path]) => path)).size).toBe(generated.length);
    expect(new Map(manifest)).toEqual(actual);
  });

  it('contains exactly the committed stable ServerRequest method allowlist', async () => {
    const schema = JSON.parse(
      await readFile(join(GENERATED_ROOT, 'ServerRequest.json'), 'utf8'),
    ) as unknown;
    const fixture = JSON.parse(
      await readFile(
        new URL('../testdata/codex-0.146-server-request-methods.json', import.meta.url),
        'utf8',
      ),
    ) as { methods: string[]; source: string };

    expect(fixture.source).toBe(
      'codex 0.146.0 app-server generate-json-schema (stable; --experimental omitted)',
    );
    expect([...collectMethodConstants(schema)].sort()).toEqual(
      [...fixture.methods].sort(),
    );
  });

  it('drives_the_runtime_notification_allowlist_from_the_committed_snapshot', async () => {
    const schema = JSON.parse(
      await readFile(join(GENERATED_ROOT, 'ServerNotification.json'), 'utf8'),
    ) as unknown;

    expect([...SERVER_NOTIFICATION_METHODS_0_146].sort()).toEqual(
      [...collectMethodConstants(schema)].sort(),
    );
    expect(SERVER_NOTIFICATION_OWNERSHIP_0_146).toEqual(
      notificationOwnershipScopes(schema),
    );
  });
});
