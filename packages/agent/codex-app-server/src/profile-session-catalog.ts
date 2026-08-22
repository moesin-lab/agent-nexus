import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  AgentSessionCatalog,
  RecoverableAgentSession,
} from '@agent-nexus/protocol';
import { buildCodexChildEnvironment } from './child-environment.js';
import {
  AppServerProcessHost,
  type ProcessHostCallbacks,
  type ProcessHostOptions,
} from './process-host.js';
import type { RpcRequestOptions } from './rpc-transport.js';

const MAX_SCAN_PAGES = 20;
const MAX_PAGE_SIZE = 200;
const MAX_CATALOG_FRAME_BYTES = 64 * 1024 * 1024;
const INTERACTIVE_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer'] as const;
const INTERACTIVE_SOURCE_KIND_SET = new Set<string>(INTERACTIVE_SOURCE_KINDS);
const SUPPORTED_SERVER_VERSIONS = new Set(['0.146.0', '0.148.0-alpha.9']);

export interface CodexProfileSessionCatalogOptions {
  bin: string;
  codexHome: string;
  allowedWorkingDirs: string[];
  clientVersion: string;
  requestTimeoutMs: number;
  terminateGraceMs: number;
}

export interface CodexProfileSessionCatalogHostPort {
  start(): void | Promise<void>;
  request(
    method: string,
    params: unknown,
    options?: RpcRequestOptions,
  ): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  stop(): Promise<void>;
}

export interface CodexProfileSessionCatalogDependencies {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  canonicalizePath?(path: string): string;
  createHost?: (
    options: ProcessHostOptions,
    callbacks: ProcessHostCallbacks,
  ) => CodexProfileSessionCatalogHostPort;
}

export class CodexProfileSessionCatalog implements AgentSessionCatalog {
  private readonly id: string;
  private readonly codexHome: string;
  private readonly allowedWorkingDirs: string[];
  private readonly canonicalizePath: (path: string) => string;

  constructor(
    private readonly options: CodexProfileSessionCatalogOptions,
    private readonly dependencies: CodexProfileSessionCatalogDependencies = {},
  ) {
    if (options.allowedWorkingDirs.length === 0) {
      throw new Error('Codex profile session catalog requires an allowed working directory');
    }
    this.canonicalizePath = dependencies.canonicalizePath ?? realpathSync;
    this.codexHome = this.canonicalizePath(resolve(options.codexHome));
    this.allowedWorkingDirs = options.allowedWorkingDirs.map((path) =>
      this.canonicalizePath(resolve(path)),
    );
    this.id = `codex-profile:${createHash('sha256')
      .update(this.codexHome, 'utf8')
      .digest('hex')}`;
  }

  profileId(): string {
    return this.id;
  }

  async listRecent(input: { limit: number }): Promise<RecoverableAgentSession[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new Error('Codex profile session catalog limit must be a positive integer');
    }
    const host = this.createHost();
    let scanError: unknown;
    try {
      await host.start();
      await this.initialize(host);
      return await this.scan(host, input.limit);
    } catch (error) {
      scanError = error;
      throw error;
    } finally {
      try {
        await host.stop();
      } catch (stopError) {
        if (scanError) {
          throw new AggregateError(
            [scanError, stopError],
            'Codex profile scan failed and app-server cleanup was not confirmed',
          );
        }
        throw stopError;
      }
    }
  }

  private createHost(): CodexProfileSessionCatalogHostPort {
    const options: ProcessHostOptions = {
      bin: this.options.bin,
      cwd: this.allowedWorkingDirs[0]!,
      codexHome: this.codexHome,
      env: buildCodexChildEnvironment(
        this.dependencies.environment ?? process.env,
      ),
      requestTimeoutMs: this.options.requestTimeoutMs,
      terminateGraceMs: this.options.terminateGraceMs,
      maxFrameBytes: MAX_CATALOG_FRAME_BYTES,
    };
    return (this.dependencies.createHost ??
      ((hostOptions, callbacks) =>
        new AppServerProcessHost(hostOptions, {}, callbacks)))(options, {});
  }

  private async initialize(host: CodexProfileSessionCatalogHostPort): Promise<void> {
    const response = object(
      await host.request('initialize', {
        clientInfo: {
          name: 'agent-nexus',
          title: 'agent-nexus',
          version: this.options.clientVersion,
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      }),
      'initialize response',
    );
    if (response['codexHome'] !== this.codexHome) {
      throw new Error('initialize codexHome does not match the selected profile');
    }
    const userAgent = nonEmptyString(response['userAgent'], 'initialize.userAgent');
    const versionMatch = /^agent-nexus\/([^ (]+)/.exec(userAgent);
    const clientEvidence = `(agent-nexus; ${this.options.clientVersion})`;
    if (
      !versionMatch ||
      !SUPPORTED_SERVER_VERSIONS.has(versionMatch[1]!) ||
      (versionMatch[1] !== this.options.clientVersion &&
        !userAgent.endsWith(clientEvidence))
    ) {
      throw new Error('initialize userAgent does not match the catalog client version');
    }
    const expectedPlatformOs =
      process.platform === 'darwin'
        ? 'macos'
        : process.platform === 'linux'
          ? 'linux'
          : null;
    if (
      expectedPlatformOs === null ||
      response['platformFamily'] !== 'unix' ||
      response['platformOs'] !== expectedPlatformOs
    ) {
      throw new Error('initialize platform evidence does not match this runtime');
    }
    await host.notify('initialized', {});
  }

  private async scan(
    host: CodexProfileSessionCatalogHostPort,
    limit: number,
  ): Promise<RecoverableAgentSession[]> {
    const result: RecoverableAgentSession[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_SCAN_PAGES && result.length < limit; page += 1) {
      const response = object(
        await host.request('thread/list', {
          ...(cursor ? { cursor } : {}),
          limit: Math.min(MAX_PAGE_SIZE, Math.max(50, limit * 3)),
          sortKey: 'updated_at',
          sortDirection: 'desc',
          sourceKinds: [...INTERACTIVE_SOURCE_KINDS],
          useStateDbOnly: true,
        }),
        'thread/list response',
      );
      const data = response['data'];
      if (!Array.isArray(data)) {
        throw new Error('thread/list response.data must be an array');
      }
      for (const raw of data) {
        if (result.length >= limit) break;
        const candidate = parseListThread(raw);
        if (!this.isEligible(candidate)) continue;
        const recovered = await this.readRecoverable(host, candidate.id);
        if (recovered) result.push(recovered);
      }
      const nextCursor = response['nextCursor'];
      if (nextCursor === null || nextCursor === undefined) break;
      cursor = nonEmptyString(nextCursor, 'thread/list response.nextCursor');
    }
    return result;
  }

  private isEligible(candidate: ListThread): boolean {
    if (
      candidate.ephemeral ||
      candidate.parentThreadId !== null ||
      candidate.statusType === 'active' ||
      !candidate.sourceKind ||
      !INTERACTIVE_SOURCE_KIND_SET.has(candidate.sourceKind)
    ) {
      return false;
    }
    try {
      const cwd = this.canonicalizePath(resolve(candidate.cwd));
      return this.allowedWorkingDirs.some((root) => isWithin(cwd, root));
    } catch {
      return false;
    }
  }

  private async readRecoverable(
    host: CodexProfileSessionCatalogHostPort,
    threadId: string,
  ): Promise<RecoverableAgentSession | undefined> {
    const response = object(
      await host.request('thread/read', { threadId, includeTurns: true }),
      'thread/read response',
    );
    const thread = object(response['thread'], 'thread/read response.thread');
    const candidate = parseListThread(thread);
    const id = candidate.id;
    if (id !== threadId) throw new Error('thread/read returned a different thread id');
    if (!this.isEligible(candidate)) return undefined;
    const cwd = candidate.cwd;
    let canonicalCwd: string;
    try {
      canonicalCwd = this.canonicalizePath(resolve(cwd));
    } catch {
      throw new Error('thread/read returned an unavailable cwd');
    }
    if (!this.allowedWorkingDirs.some((root) => isWithin(canonicalCwd, root))) {
      throw new Error('thread/read returned a cwd outside the configured allowlist');
    }
    const turns = thread['turns'];
    if (!Array.isArray(turns)) {
      throw new Error('thread/read response.thread.turns must be an array');
    }
    const completed = lastCompletedReply(turns);
    if (!completed) return undefined;
    const name = optionalNonEmptyString(thread['name']);
    const preview = optionalNonEmptyString(thread['preview']);
    return {
      nativeSessionRef: id,
      updatedAt: dateFromUnixSeconds(
        thread['updatedAt'],
        'thread/read response.thread.updatedAt',
      ),
      workingDir: canonicalCwd,
      ...(name ?? preview ? { title: name ?? preview } : {}),
      lastCompletedTurnId: completed.turnId,
      lastCompletedReply: completed.reply,
    };
  }
}

interface ListThread {
  id: string;
  cwd: string;
  ephemeral: boolean;
  parentThreadId: string | null;
  statusType: string;
  sourceKind?: string;
}

function parseListThread(value: unknown): ListThread {
  const thread = object(value, 'thread/list response.data[]');
  const parentThreadId = thread['parentThreadId'];
  if (parentThreadId !== null && typeof parentThreadId !== 'string') {
    throw new Error('thread/list response.data[].parentThreadId must be string|null');
  }
  if (typeof thread['ephemeral'] !== 'boolean') {
    throw new Error('thread/list response.data[].ephemeral must be boolean');
  }
  const status = object(thread['status'], 'thread/list response.data[].status');
  return {
    id: nonEmptyString(thread['id'], 'thread/list response.data[].id'),
    cwd: nonEmptyString(thread['cwd'], 'thread/list response.data[].cwd'),
    ephemeral: thread['ephemeral'],
    parentThreadId,
    statusType: nonEmptyString(status['type'], 'thread/list response.data[].status.type'),
    ...(typeof thread['source'] === 'string'
      ? { sourceKind: thread['source'] }
      : {}),
  };
}

function lastCompletedReply(
  turns: unknown[],
): { turnId: string; reply: string } | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = object(turns[index], 'thread.turns[]');
    if (turn['status'] !== 'completed') continue;
    const items = turn['items'];
    if (!Array.isArray(items)) {
      throw new Error('thread.turns[].items must be an array');
    }
    const messages = items.flatMap((item) => {
      const parsed = object(item, 'thread.turns[].items[]');
      if (parsed['type'] !== 'agentMessage') return [];
      const text = optionalNonEmptyString(parsed['text']);
      const phase = parsed['phase'];
      if (
        phase !== undefined &&
        phase !== null &&
        phase !== 'commentary' &&
        phase !== 'final_answer'
      ) {
        throw new Error('thread.turns[].items[].phase is unsupported');
      }
      return text ? [{ text, phase }] : [];
    });
    const final = messages.filter((message) => message.phase === 'final_answer').at(-1);
    const fallback = messages.filter((message) => message.phase == null).at(-1);
    const selected = final ?? fallback;
    if (!selected) continue;
    return {
      turnId: nonEmptyString(turn['id'], 'thread.turns[].id'),
      reply: selected.text,
    };
  }
  return undefined;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function dateFromUnixSeconds(value: unknown, label: string): Date {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is out of range`);
  return date;
}

function isWithin(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}
