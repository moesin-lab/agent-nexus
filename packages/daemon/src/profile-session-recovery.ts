import { createHash } from 'node:crypto';
import { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import type {
  AgentSessionCatalog,
  CreateThreadInput,
  CreateThreadResult,
  RecoverableAgentSession,
  SessionKey,
} from '@agent-nexus/protocol';
import { BasicRedactor, type Redactor } from './redaction.js';
import { SessionStore } from './session-store.js';

export type NativeSessionMaterializationState =
  | 'planned'
  | 'container_created'
  | 'linked'
  | 'failed'
  | 'ambiguous';

export interface ProfileSessionRecoverySyncInput {
  catalog: AgentSessionCatalog;
  agentName: string;
  agentOwner: string;
  platformName: string;
  platform: string;
  parentChannelId: string;
  ownerUserId: string;
  traceId: string;
  maxTextLength: number;
  createThread(input: CreateThreadInput): Promise<CreateThreadResult>;
  limit?: number;
  maxCreates?: number;
}

export interface ProfileSessionRecoveryResult {
  discovered: number;
  linked: number;
  existing: number;
  failed: number;
  ambiguous: number;
  retryable: number;
  deferred: number;
}

export interface ProfileSessionRecoveryServiceOptions {
  database: BetterSqliteDatabase;
  sessionStore: SessionStore;
  now?(): Date;
  redactor?: Redactor;
}

interface MaterializationIdentity {
  profileId: string;
  nativeSessionRef: string;
  agentName: string;
  agentOwner: string;
  platformName: string;
  platform: string;
  parentChannelId: string;
  ownerUserId: string;
}

interface MaterializationRecord extends MaterializationIdentity {
  operationId: string;
  idempotencyKey: string;
  state: NativeSessionMaterializationState;
  threadId?: string;
  rootMessageId?: string;
  url?: string;
  linkedSessionId?: string;
  errorCode?: string;
}

interface MaterializationRow {
  operation_id: string;
  profile_id: string;
  native_session_ref: string;
  agent_name: string;
  agent_owner: string;
  platform_name: string;
  platform: string;
  parent_channel_id: string;
  owner_user_id: string;
  idempotency_key: string;
  state: NativeSessionMaterializationState;
  thread_id: string | null;
  root_message_id: string | null;
  url: string | null;
  linked_session_id: string | null;
  error_code: string | null;
}

export class ProfileSessionRecoveryService {
  private readonly store: NativeSessionMaterializationStore;
  private readonly now: () => Date;
  private readonly redactor: Redactor;

  constructor(private readonly options: ProfileSessionRecoveryServiceOptions) {
    this.store = new NativeSessionMaterializationStore(options.database);
    this.now = options.now ?? (() => new Date());
    this.redactor = options.redactor ?? new BasicRedactor();
  }

  async sync(
    input: ProfileSessionRecoverySyncInput,
  ): Promise<ProfileSessionRecoveryResult> {
    assertSyncInput(input);
    const profileId = input.catalog.profileId();
    if (profileId.length === 0) {
      throw new Error('catalog profileId must be non-empty');
    }
    const sessions = await input.catalog.listRecent({
      limit: input.limit ?? 100,
    });
    const maxCreates = input.maxCreates ?? 10;
    let createAttempts = 0;
    const result: ProfileSessionRecoveryResult = {
      discovered: sessions.length,
      linked: 0,
      existing: 0,
      failed: 0,
      ambiguous: 0,
      retryable: 0,
      deferred: 0,
    };
    for (const session of sessions) {
      const identity: MaterializationIdentity = {
        profileId,
        nativeSessionRef: session.nativeSessionRef,
        agentName: input.agentName,
        agentOwner: input.agentOwner,
        platformName: input.platformName,
        platform: input.platform,
        parentChannelId: input.parentChannelId,
        ownerUserId: input.ownerUserId,
      };
      if (
        this.options.sessionStore.adoptFixedNativeResumeBindingProfile({
          profileId,
          nativeSessionRef: session.nativeSessionRef,
          agentName: input.agentName,
          agentOwner: input.agentOwner,
          platformName: input.platformName,
          platform: input.platform,
          ownerUserId: input.ownerUserId,
        })
      ) {
        result.existing += 1;
        continue;
      }
      let record = this.store.getOrCreate(identity, this.now());
      if (record.state === 'linked') {
        result.existing += 1;
        continue;
      }
      if (record.state === 'ambiguous') {
        result.ambiguous += 1;
        continue;
      }
      if (record.state === 'failed') {
        result.failed += 1;
        continue;
      }
      if (record.state === 'planned') {
        // 全局 reservation 的首个父群拥有 create 权；其它父群只能观察，
        // 不能把同一 native ref 物化到第二个容器。
        if (record.parentChannelId !== input.parentChannelId) {
          result.deferred += 1;
          continue;
        }
        if (createAttempts >= maxCreates) {
          result.deferred += 1;
          continue;
        }
        const dispatch = this.store.beginDispatch(record.operationId, this.now());
        if (!dispatch.acquired) {
          if (dispatch.record.state === 'linked') result.existing += 1;
          else if (dispatch.record.state === 'failed') result.failed += 1;
          else result.ambiguous += 1;
          continue;
        }
        record = dispatch.record;
        createAttempts += 1;
        const created = await this.createContainer(input, session, record);
        if (created.outcome !== 'created') {
          const current = this.store.get(record.operationId);
          if (current?.state === 'ambiguous') result.ambiguous += 1;
          else if (created.outcome === 'retryable') result.retryable += 1;
          else result.failed += 1;
          continue;
        }
        record = created.record;
      }
      try {
        this.linkContainer(input, session, record);
        result.linked += 1;
      } catch {
        // container_created 是可恢复 checkpoint；不能降级为 failed 后丢失绑定机会。
        result.failed += 1;
      }
    }
    return result;
  }

  private async createContainer(
    input: ProfileSessionRecoverySyncInput,
    session: RecoverableAgentSession,
    record: MaterializationRecord,
  ): Promise<
    | { outcome: 'created'; record: MaterializationRecord }
    | { outcome: 'failed' | 'retryable' | 'ambiguous' }
  > {
    let created: CreateThreadResult;
    try {
      created = await input.createThread({
        parentChannelId: record.parentChannelId,
        initiatorUserId: input.ownerUserId,
        title: truncateUtf16(
          this.redactor.redact(session.title ?? 'Recovered agent session'),
          Math.min(100, input.maxTextLength),
        ),
        visibility: 'public',
        initialMessage: truncateUtf16(
          this.redactor.redact(session.lastCompletedReply),
          input.maxTextLength,
        ),
        idempotencyKey: record.idempotencyKey,
        traceId: input.traceId,
      });
      validateCreatedContainer(created, record.parentChannelId);
    } catch (error) {
      const failure = readCreationFailure(error);
      if (failure.outcome === 'unknown') {
        this.store.markAmbiguous(
          record.operationId,
          'thread-create-outcome-unknown',
          this.now(),
        );
        return { outcome: 'ambiguous' };
      }
      if (failure.retryable) {
        this.store.resetPlanned(
          record.operationId,
          'thread-create-retryable',
          this.now(),
        );
        return { outcome: 'retryable' };
      }
      this.store.markTerminalFailure(
        record.operationId,
        'thread-create-failed',
        this.now(),
      );
      return { outcome: 'failed' };
    }
    try {
      return {
        outcome: 'created',
        record: this.store.markContainerCreated(
          record.operationId,
          created,
          this.now(),
        ),
      };
    } catch {
      // 远端已经明确成功，而本地 checkpoint 未确认；若仍可写库，只能标为 ambiguous。
      try {
        this.store.markAmbiguous(
          record.operationId,
          'container-checkpoint-failed',
          this.now(),
        );
        return { outcome: 'ambiguous' };
      } catch {
        throw new Error('Remote thread was created but local checkpoint could not be recorded');
      }
    }
  }

  private linkContainer(
    input: ProfileSessionRecoverySyncInput,
    session: RecoverableAgentSession,
    record: MaterializationRecord,
  ): void {
    if (record.state !== 'container_created' || !record.threadId) {
      throw new Error('Materialization is not ready for local binding');
    }
    const key: SessionKey = {
      platformName: input.platformName,
      platform: input.platform,
      channelId: record.threadId,
      initiatorUserId: input.ownerUserId,
    };
    const sessionId = this.options.sessionStore.createSessionId();
    this.options.sessionStore.runInPersistenceTransaction(
      (action) => this.options.database.transaction(action)(),
      () => {
        this.options.sessionStore.bindNativeResumeToFixedThread(
          key,
          {
            agentSessionId: session.nativeSessionRef,
            agentOwner: input.agentOwner,
            lastTurnAt: new Date(session.updatedAt),
            ...(session.title ? { title: session.title } : {}),
            workingDir: session.workingDir,
          },
          {
            parentChannelId: record.parentChannelId,
            ownerUserId: input.ownerUserId,
            bindingMode: 'fixed',
            ...(record.rootMessageId
              ? { rootMessageId: record.rootMessageId }
              : {}),
            ...(record.url ? { url: record.url } : {}),
            agentName: input.agentName,
            agentOwner: input.agentOwner,
            profileId: record.profileId,
          },
          sessionId,
        );
        this.store.markLinked(record.operationId, sessionId, this.now());
      },
    );
  }
}

class NativeSessionMaterializationStore {
  constructor(private readonly database: BetterSqliteDatabase) {}

  getOrCreate(
    identity: MaterializationIdentity,
    now: Date,
  ): MaterializationRecord {
    const digest = reservationDigest(identity);
    const operationId = `native-session:${digest}`;
    const idempotencyKey = createHash('sha256')
      .update(`lark-thread:v1:${digest}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO native_session_materializations (
          operation_id, profile_id, native_session_ref, agent_name, agent_owner,
          platform_name, platform, parent_channel_id, owner_user_id,
          idempotency_key, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
      )
      .run(
        operationId,
        identity.profileId,
        identity.nativeSessionRef,
        identity.agentName,
        identity.agentOwner,
        identity.platformName,
        identity.platform,
        identity.parentChannelId,
        identity.ownerUserId,
        idempotencyKey,
        now.toISOString(),
        now.toISOString(),
      );
    const record = this.get(operationId);
    if (!record || reservationDigest(record) !== digest) {
      throw new Error('Native session materialization identity collision');
    }
    return record;
  }

  get(operationId: string): MaterializationRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT operation_id, profile_id, native_session_ref, agent_name,
                agent_owner, platform_name, platform, parent_channel_id,
                owner_user_id, idempotency_key, state, thread_id,
                root_message_id, url, linked_session_id, error_code
         FROM native_session_materializations
         WHERE operation_id = ?`,
      )
      .get(operationId) as MaterializationRow | undefined;
    return row ? recordFromRow(row) : undefined;
  }

  beginDispatch(
    operationId: string,
    now: Date,
  ): { acquired: boolean; record: MaterializationRecord } {
    const changed = this.database
      .prepare(
        `UPDATE native_session_materializations
         SET state = 'ambiguous', error_code = 'thread-create-in-flight',
             updated_at = ?
         WHERE operation_id = ? AND state = 'planned'`,
      )
      .run(now.toISOString(), operationId).changes;
    const record = this.get(operationId);
    if (!record) throw new Error('Materialization dispatch checkpoint was lost');
    return { acquired: changed === 1, record };
  }

  markContainerCreated(
    operationId: string,
    created: CreateThreadResult,
    now: Date,
  ): MaterializationRecord {
    const changed = this.database
      .prepare(
        `UPDATE native_session_materializations
         SET state = 'container_created', thread_id = ?, root_message_id = ?,
             url = ?, error_code = NULL, updated_at = ?
         WHERE operation_id = ? AND state = 'ambiguous'`,
      )
      .run(
        created.threadId,
        created.rootMessageId ?? null,
        created.url ?? null,
        now.toISOString(),
        operationId,
      ).changes;
    if (changed !== 1) throw new Error('Materialization dispatch checkpoint was lost');
    return this.get(operationId)!;
  }

  markTerminalFailure(
    operationId: string,
    errorCode: string,
    now: Date,
  ): void {
    const changed = this.database
      .prepare(
        `UPDATE native_session_materializations
         SET state = 'failed', error_code = ?, updated_at = ?
         WHERE operation_id = ? AND state = 'ambiguous'`,
      )
      .run(errorCode, now.toISOString(), operationId).changes;
    if (changed !== 1) throw new Error('Materialization terminal checkpoint was lost');
  }

  markAmbiguous(operationId: string, errorCode: string, now: Date): void {
    const changed = this.database
      .prepare(
        `UPDATE native_session_materializations
         SET error_code = ?, updated_at = ?
         WHERE operation_id = ? AND state = 'ambiguous'`,
      )
      .run(errorCode, now.toISOString(), operationId).changes;
    if (changed !== 1) throw new Error('Materialization ambiguous checkpoint was lost');
  }

  resetPlanned(operationId: string, errorCode: string, now: Date): void {
    const changed = this.database
      .prepare(
        `UPDATE native_session_materializations
         SET state = 'planned', error_code = ?, updated_at = ?
         WHERE operation_id = ? AND state = 'ambiguous'`,
      )
      .run(errorCode, now.toISOString(), operationId).changes;
    if (changed !== 1) throw new Error('Materialization retry checkpoint was lost');
  }

  markLinked(operationId: string, sessionId: string, now: Date): void {
    const changed = this.database
      .prepare(
        `UPDATE native_session_materializations
         SET state = 'linked', linked_session_id = ?, error_code = NULL,
             updated_at = ?
         WHERE operation_id = ? AND state = 'container_created'`,
      )
      .run(sessionId, now.toISOString(), operationId).changes;
    if (changed !== 1) throw new Error('Materialization container checkpoint was lost');
  }
}

function assertSyncInput(input: ProfileSessionRecoverySyncInput): void {
  for (const [label, value] of Object.entries({
    agentName: input.agentName,
    agentOwner: input.agentOwner,
    platformName: input.platformName,
    platform: input.platform,
    parentChannelId: input.parentChannelId,
    ownerUserId: input.ownerUserId,
    traceId: input.traceId,
  })) {
    if (value.length === 0) throw new Error(`${label} must be non-empty`);
  }
  if (!Number.isSafeInteger(input.maxTextLength) || input.maxTextLength < 1) {
    throw new Error('maxTextLength must be a positive integer');
  }
  for (const [label, value] of Object.entries({
    limit: input.limit ?? 100,
    maxCreates: input.maxCreates ?? 10,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${label} must be a positive integer`);
    }
  }
}

function validateCreatedContainer(
  created: CreateThreadResult,
  expectedParentChannelId: string,
): void {
  if (
    !created.threadId ||
    created.parentChannelId !== expectedParentChannelId ||
    !created.rootMessageId
  ) {
    throw Object.assign(new Error('Created thread identity is incomplete'), {
      creationOutcome: 'unknown' as const,
    });
  }
}

function readCreationFailure(error: unknown): {
  outcome: 'not-created' | 'unknown';
  retryable: boolean;
} {
  if (!error || typeof error !== 'object') {
    return { outcome: 'unknown', retryable: false };
  }
  const candidate = error as {
    creationOutcome?: unknown;
    retryable?: unknown;
  };
  return {
    outcome:
      candidate.creationOutcome === 'not-created' ? 'not-created' : 'unknown',
    retryable: candidate.retryable === true,
  };
}

function reservationDigest(identity: MaterializationIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        identity.profileId,
        identity.nativeSessionRef,
        identity.agentName,
        identity.agentOwner,
        identity.platformName,
        identity.platform,
        identity.ownerUserId,
      ]),
      'utf8',
    )
    .digest('hex');
}

function recordFromRow(row: MaterializationRow): MaterializationRecord {
  return {
    operationId: row.operation_id,
    profileId: row.profile_id,
    nativeSessionRef: row.native_session_ref,
    agentName: row.agent_name,
    agentOwner: row.agent_owner,
    platformName: row.platform_name,
    platform: row.platform,
    parentChannelId: row.parent_channel_id,
    ownerUserId: row.owner_user_id,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.root_message_id ? { rootMessageId: row.root_message_id } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.linked_session_id ? { linkedSessionId: row.linked_session_id } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}

function truncateUtf16(text: string, maxLength: number): string {
  let result = '';
  for (const character of text) {
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result || '\u200b';
}
