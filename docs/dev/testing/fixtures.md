# 测试数据与 Fixture

所有测试数据（输入 fixture、预期输出 snapshot、CC transcript）的组织、命名、更新规则。

## 目录结构

```
<repo>/
└── testdata/
    ├── discord/
    │   ├── events/            # Discord gateway 事件 fixture（JSON）
    │   │   ├── message_simple.json
    │   │   ├── message_with_attachment.json
    │   │   ├── slash_command_reset.json
    │   │   └── ...
    │   ├── api_responses/     # Mock Discord HTTP 响应
    │   │   ├── send_message_ok.json
    │   │   ├── rate_limit_429.json
    │   │   └── ...
    │   └── snapshots/         # NormalizedEvent 快照比对
    │       └── ...
    ├── cc-cli/
    │   ├── transcripts/       # CC 输出回放
    │   │   ├── v<ccver>/      # 按 CC 版本分组
    │   │   │   ├── basic_qa.jsonl
    │   │   │   ├── tool_call_read.jsonl
    │   │   │   └── ...
    │   └── snapshots/         # AgentEvent 快照
    │       └── ...
    ├── anthropic/
    │   └── responses/         # Anthropic API mock 响应
    └── eval/
        └── cases/             # Eval case（见 eval.md）
```

## Fixture 类型

### Discord 事件（`testdata/discord/events/*.json`）

- 原始 gateway event payload（单条）
- 从真实 Discord 录制后脱敏（去除真实 user id、email、token；保留结构）
- 文件名描述场景：`<event_kind>_<scenario>.json`

示例结构（简化）：

```json
{
  "t": "MESSAGE_CREATE",
  "d": {
    "id": "1000000000000000001",
    "channel_id": "2000000000000000002",
    "author": { "id": "3000000000000000003", "username": "test-user" },
    "content": "@bot hello",
    "attachments": []
  }
}
```

### Discord API 响应（`testdata/discord/api_responses/*.json`）

- HTTP 状态码 + 响应体 + 关键响应头
- 用于 mock Discord REST API

示例：

```json
{
  "status": 429,
  "headers": {
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset-After": "2.5",
    "Retry-After": "2.5"
  },
  "body": { "message": "You are being rate limited.", "retry_after": 2.5 }
}
```

### CC CLI Transcript（`testdata/cc-cli/transcripts/v<ver>/*.jsonl`）

- CC 输出的 JSONL（按行一个事件）
- 包含 timestamp、事件类型、payload
- 用于 transcript 回放测试：mock CC runtime 按节奏吐出这些行

示例（简化）：

```jsonl
{"ts":"2026-04-22T10:00:00.000Z","type":"message_start","model":"claude-opus-4-7"}
{"ts":"2026-04-22T10:00:00.100Z","type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
{"ts":"2026-04-22T10:00:00.200Z","type":"content_block_delta","delta":{"type":"text_delta","text":", world"}}
{"ts":"2026-04-22T10:00:00.300Z","type":"message_stop","usage":{"input_tokens":10,"output_tokens":3}}
```

### 快照（`testdata/*/snapshots/*.json`）

- 预期的归一化输出（NormalizedEvent、AgentEvent、OutboundMessage）
- 测试跑时比对实际输出 == 快照
- 更新策略见下文

## 命名约定

- 全小写加下划线
- 场景描述：`<subject>_<scenario>[_<expected>].<ext>`
- 例：
  - `message_with_attachment.json`（输入）
  - `message_with_attachment.normalized.json`（快照）
  - `slash_command_reset_denied.json`
  - `tool_call_read_file_ok.jsonl`

## 版本控制

### CC Transcript

- 按 CC CLI 版本分目录：`v1.3.0/`, `v1.4.0/`
- 测试根据测的 CC 版本读对应目录
- 新增 CC 版本：新开目录，运行录制脚本生成一批

### 快照

- 与代码同步更新
- **不可手工改**——改实现时重新生成快照并 review diff

## 更新 fixture 的规则

Fixture 是契约的一部分，不是"试试看"：

1. 改 fixture 必须走 PR review
2. PR 描述说明为什么改（真实世界变化？bug 修正？新增场景？）
3. 改 fixture 同时改相关的 snapshot（保持对齐）
4. 快照大量变动时，手工抽样验证 3–5 个是否符合预期

**禁止**：

- `--update-snapshots` 后直接提交不检查 diff
- 为了让测试通过而改 fixture（测试挂说明代码或 fixture 有问题，要定位）

## 录制工具（待实现）

需要的工具（ADR-0004 语言定后补实现）：

- `scripts/record-discord-event`：从真实 Discord 连接录制事件 + 脱敏
- `scripts/record-cc-transcript`：在一个指定 prompt 下运行 CC CLI，落盘 JSONL
- `scripts/regenerate-snapshots`：重新生成所有 snapshot（需要手工 review diff）

## 脱敏

录制 fixture 时必须脱敏：

- user id / channel id / guild id → 全部替换为固定的测试 ID（`1000000000000000001` 等）
- username / display_name → 固定虚拟名（`test-user` / `tester`）
- email / phone / 真实姓名 → 去除或替换
- 附件 URL → 替换为 `https://testdata.example/…`

录制脚本内建脱敏规则；手工检查 diff 确认没漏。

## 合约测试用的 fixture

每个 spec 文件声明了合约测试（例：`spec/platform-adapter.md` §"测试契约"）。这些测试需要的 fixture：

- 至少一个 happy path fixture
- 至少一个错误路径 fixture
- 至少一个边界 fixture（超长文本、空 attachment 列表等）

## 反模式

- 在测试代码里内联大段 JSON（放 fixture 文件）
- Fixture 文件用 `final_v2_fixed.json` 这种人类命名（用语义化名字）
- 录制的 fixture 未脱敏直接入库
- CC 升级了但不更新 transcript fixture（下次测试不稳）
- 多个测试共享一个 mutable fixture（改一处挂一片）

## Out of spec

- 合成数据生成（property-based testing）：MVP 不上
- Fixture 的自动化一致性检查：等有了才补
