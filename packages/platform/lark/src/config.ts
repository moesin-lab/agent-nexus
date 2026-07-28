export interface LarkPlatformConfig {
  name: string;
  type: 'lark';
  appId: string;
  appSecretRef: string;
  botOpenId: string;
}

export interface LarkBindingMatchConfig {
  chatIds: string[];
}

export class LarkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LarkConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertNoUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new LarkConfigError(`未知字段 ${path}.${key}`);
    }
  }
}

function requireString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new LarkConfigError(`缺字段 ${path}.${key}（非空字符串）`);
  }
  return value;
}

export function parseLarkPlatformConfig(
  raw: unknown,
  ctx: { path: string },
): LarkPlatformConfig {
  if (!isRecord(raw)) {
    throw new LarkConfigError(`字段 ${ctx.path} 必须是对象`);
  }
  assertNoUnknownKeys(
    raw,
    ['name', 'type', 'appId', 'appSecretRef', 'botOpenId', 'auth'],
    ctx.path,
  );

  const name = requireString(raw, 'name', ctx.path);
  const type = requireString(raw, 'type', ctx.path);
  if (type !== 'lark') {
    throw new LarkConfigError(`字段 ${ctx.path}.type 必须是 "lark"`);
  }

  const appId = requireString(raw, 'appId', ctx.path);
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
    throw new LarkConfigError(
      `字段 ${ctx.path}.appId 必须匹配 ^cli_[0-9a-fA-F]{16}$`,
    );
  }

  const appSecretRef = requireString(raw, 'appSecretRef', ctx.path);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(appSecretRef)) {
    throw new LarkConfigError(
      `字段 ${ctx.path}.appSecretRef 必须是 secret ref 名称，不能包含路径分隔符`,
    );
  }

  const botOpenId = requireString(raw, 'botOpenId', ctx.path);
  if (!/^ou_.+/.test(botOpenId)) {
    throw new LarkConfigError(`字段 ${ctx.path}.botOpenId 必须以 "ou_" 开头`);
  }

  return {
    name,
    type: 'lark',
    appId,
    appSecretRef,
    botOpenId,
  };
}

export function parseLarkBindingMatchConfig(
  raw: unknown,
  ctx: { path: string },
): LarkBindingMatchConfig {
  if (!isRecord(raw)) {
    throw new LarkConfigError(`字段 ${ctx.path} 必须是对象`);
  }
  assertNoUnknownKeys(raw, ['chatIds'], ctx.path);

  const chatIds = raw['chatIds'];
  if (
    !Array.isArray(chatIds) ||
    chatIds.length === 0 ||
    chatIds.some((chatId) => typeof chatId !== 'string' || chatId.length === 0)
  ) {
    throw new LarkConfigError(
      `字段 ${ctx.path}.chatIds 必须是非空字符串数组`,
    );
  }
  return { chatIds: [...chatIds] };
}
