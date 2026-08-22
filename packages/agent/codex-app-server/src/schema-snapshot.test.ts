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
const CATALOG_SNAPSHOT_ROOT = fileURLToPath(
  new URL('../testdata/schema/0.148.0-alpha.9', import.meta.url),
);
const CATALOG_GENERATED_ROOT = join(CATALOG_SNAPSHOT_ROOT, 'generated');

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

async function assertSnapshotIntegrity(
  root: string,
  expectedMetadata: Record<string, unknown>,
): Promise<void> {
  const metadata = JSON.parse(
    await readFile(join(root, 'metadata.json'), 'utf8'),
  ) as Record<string, unknown>;
  expect(metadata).toEqual(expectedMetadata);

  const generatedRoot = join(root, 'generated');
  const generated = await filesUnder(generatedRoot);
  expect(generated).toHaveLength(metadata['generatedFileCount'] as number);
  const actual = new Map(
    await Promise.all(
      generated.map(async (path) => [
        relative(generatedRoot, path),
        createHash('sha256').update(await readFile(path)).digest('hex'),
      ] as const),
    ),
  );
  const manifest = (await readFile(join(root, 'SHA256SUMS'), 'utf8'))
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
    await assertSnapshotIntegrity(SNAPSHOT_ROOT, {
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

  it('pins_the_stable_sandboxed_command_exec_process_surface', async () => {
    const clientRequest = JSON.parse(
      await readFile(join(GENERATED_ROOT, 'ClientRequest.json'), 'utf8'),
    ) as unknown;
    const methods = collectMethodConstants(clientRequest);
    expect(methods.has('command/exec')).toBe(true);
    expect(methods.has('command/exec/write')).toBe(true);
    expect(methods.has('command/exec/terminate')).toBe(true);
    expect(methods.has('process/spawn')).toBe(false);

    const execParams = JSON.parse(
      await readFile(join(GENERATED_ROOT, 'v2/CommandExecParams.json'), 'utf8'),
    ) as { required: string[]; properties: Record<string, unknown> };
    expect(execParams.required).toEqual(['command']);
    expect(Object.keys(execParams.properties)).toEqual(expect.arrayContaining([
      'command',
      'cwd',
      'disableOutputCap',
      'disableTimeout',
      'processId',
      'sandboxPolicy',
      'streamStdin',
      'streamStdoutStderr',
    ]));
  });
});

describe('Codex 0.148.0-alpha.9 read-only catalog schema snapshot', () => {
  it('is complete, reproducible, and covered by the committed hash manifest', async () => {
    await assertSnapshotIntegrity(CATALOG_SNAPSHOT_ROOT, {
      codexVersion: '0.148.0-alpha.9',
      experimental: false,
      generationCommand: [
        'codex',
        'app-server',
        'generate-json-schema',
        '--out',
        '<OUTPUT_DIR>',
      ],
      generatedFileCount: 285,
      upstream: 'https://github.com/openai/codex',
      upstreamLicense: 'Apache-2.0',
    });
  });

  it('pins every schema field consumed by the read-only profile catalog', async () => {
    const initialize = JSON.parse(
      await readFile(join(CATALOG_GENERATED_ROOT, 'v1/InitializeResponse.json'), 'utf8'),
    ) as { required: string[]; properties: Record<string, unknown> };
    expect(initialize.required).toEqual(
      expect.arrayContaining(['codexHome', 'platformFamily', 'platformOs', 'userAgent']),
    );

    const listParams = JSON.parse(
      await readFile(join(CATALOG_GENERATED_ROOT, 'v2/ThreadListParams.json'), 'utf8'),
    ) as { properties: Record<string, unknown> };
    expect(Object.keys(listParams.properties)).toEqual(
      expect.arrayContaining([
        'cursor',
        'limit',
        'sortDirection',
        'sortKey',
        'sourceKinds',
        'useStateDbOnly',
      ]),
    );

    const listResponse = JSON.parse(
      await readFile(join(CATALOG_GENERATED_ROOT, 'v2/ThreadListResponse.json'), 'utf8'),
    ) as {
      required: string[];
      properties: Record<string, unknown>;
      definitions: Record<
        string,
        { required?: string[]; properties?: Record<string, unknown>; oneOf?: unknown[] }
      >;
    };
    expect(listResponse.required).toContain('data');
    expect(Object.keys(listResponse.properties)).toEqual(
      expect.arrayContaining(['data', 'nextCursor']),
    );
    expect(listResponse.definitions['Thread']?.required).toEqual(
      expect.arrayContaining([
        'cwd',
        'ephemeral',
        'id',
        'source',
        'status',
        'turns',
        'updatedAt',
      ]),
    );
    expect(Object.keys(listResponse.definitions['Thread']?.properties ?? {})).toContain(
      'parentThreadId',
    );

    const readParams = JSON.parse(
      await readFile(join(CATALOG_GENERATED_ROOT, 'v2/ThreadReadParams.json'), 'utf8'),
    ) as { required: string[]; properties: Record<string, unknown> };
    expect(readParams.required).toEqual(['threadId']);
    expect(Object.keys(readParams.properties)).toEqual(
      expect.arrayContaining(['includeTurns', 'threadId']),
    );

    const readResponse = JSON.parse(
      await readFile(join(CATALOG_GENERATED_ROOT, 'v2/ThreadReadResponse.json'), 'utf8'),
    ) as {
      required: string[];
      definitions: Record<string, { required?: string[]; oneOf?: Array<Record<string, unknown>> }>;
    };
    expect(readResponse.required).toEqual(['thread']);
    expect(readResponse.definitions['Turn']?.required).toEqual(
      expect.arrayContaining(['id', 'items', 'status']),
    );
    const agentMessage = readResponse.definitions['ThreadItem']?.oneOf?.find((variant) => {
      const properties = variant['properties'] as
        | Record<string, { enum?: string[] }>
        | undefined;
      return properties?.['type']?.enum?.[0] === 'agentMessage';
    });
    expect(agentMessage).toMatchObject({
      required: expect.arrayContaining(['id', 'text', 'type']),
      properties: {
        phase: expect.any(Object),
        text: expect.any(Object),
      },
    });
  });

  it('keeps the real profile probe redacted and records catalog acceptance evidence', async () => {
    const evidence = JSON.parse(
      await readFile(
        new URL(
          '../testdata/profile-catalog-probe-0.148.0-alpha.9.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(evidence).toEqual({
      codexVersion: '0.148.0-alpha.9',
      platform: 'macos-arm64',
      profileIdRedacted: true,
      requestedLimit: 10,
      recovered: 10,
      allNativeSessionRefsNonEmpty: true,
      allLastCompletedRepliesNonEmpty: true,
      replyBodiesRecorded: false,
      verifiedAt: '2026-08-21',
    });
    expect(JSON.stringify(evidence)).not.toMatch(/\/Users\/|lastCompletedReply|nativeSessionRef/);
  });
});
