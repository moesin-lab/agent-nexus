export class JsonlFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonlFrameError';
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

export class JsonlFrameReader {
  private buffered = new Uint8Array();
  private failed = false;

  constructor(private readonly maxFrameBytes = 8 * 1024 * 1024) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new JsonlFrameError('maxFrameBytes 必须是正整数');
    }
  }

  push(chunk: Uint8Array): Record<string, unknown>[] {
    this.assertOpen();
    try {
      const data = concat(this.buffered, chunk);
      const frames: Record<string, unknown>[] = [];
      let start = 0;

      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0x0a) continue;
        const frame = data.subarray(start, index);
        this.assertFrameSize(frame.length);
        frames.push(this.parseFrame(frame));
        start = index + 1;
      }

      this.buffered = data.slice(start);
      this.assertFrameSize(this.buffered.length);
      return frames;
    } catch (error) {
      this.failed = true;
      if (error instanceof JsonlFrameError) throw error;
      throw new JsonlFrameError('JSONL frame 解析失败');
    }
  }

  finish(): Record<string, unknown>[] {
    this.assertOpen();
    if (this.buffered.length !== 0) {
      this.failed = true;
      throw new JsonlFrameError('JSONL stream 在截断 frame 中结束');
    }
    return [];
  }

  private assertOpen(): void {
    if (this.failed) throw new JsonlFrameError('JSONL reader 已因协议错误终止');
  }

  private assertFrameSize(size: number): void {
    if (size > this.maxFrameBytes) {
      throw new JsonlFrameError(`JSONL frame 超过 ${this.maxFrameBytes} bytes`);
    }
  }

  private parseFrame(frame: Uint8Array): Record<string, unknown> {
    if (frame.length === 0) throw new JsonlFrameError('JSONL 不允许空 frame');
    let value: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
      value = JSON.parse(text);
    } catch {
      throw new JsonlFrameError('JSONL frame 不是合法 UTF-8 JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new JsonlFrameError('JSONL frame 必须是 object');
    }
    return value as Record<string, unknown>;
  }
}
