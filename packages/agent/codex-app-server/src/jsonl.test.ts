import { describe, expect, it } from 'vitest';
import { JsonlFrameError, JsonlFrameReader } from './jsonl.js';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('JsonlFrameReader', () => {
  it('should_emit_objects_when_utf8_and_lines_are_split_across_chunks', () => {
    const reader = new JsonlFrameReader(1024);
    const encoded = bytes('{"text":"你好"}\n{"id":2}\n');
    const splitInsideMultibyte = encoded.indexOf(0xe4) + 1;

    expect(reader.push(encoded.subarray(0, splitInsideMultibyte))).toEqual([]);
    expect(reader.push(encoded.subarray(splitInsideMultibyte))).toEqual([
      { text: '你好' },
      { id: 2 },
    ]);
    expect(reader.finish()).toEqual([]);
  });

  it('should_reject_empty_non_object_and_invalid_json_frames', () => {
    expect(() => new JsonlFrameReader(100).push(bytes('\n'))).toThrow(
      JsonlFrameError,
    );
    expect(() => new JsonlFrameReader(100).push(bytes('[]\n'))).toThrow(
      /object/,
    );
    expect(() => new JsonlFrameReader(100).push(bytes('{bad}\n'))).toThrow(
      JsonlFrameError,
    );
  });

  it('should_reject_invalid_utf8_without_replacement_decoding', () => {
    const reader = new JsonlFrameReader(100);

    expect(() => reader.push(Uint8Array.from([0xff, 0x0a]))).toThrow(
      JsonlFrameError,
    );
  });

  it('should_reject_a_frame_as_soon_as_its_byte_limit_is_exceeded', () => {
    const reader = new JsonlFrameReader(8);

    expect(() => reader.push(bytes('{"long":'))).not.toThrow();
    expect(() => reader.push(bytes('1}\n'))).toThrow(/8/);
  });

  it('should_reject_truncated_frame_at_eof', () => {
    const reader = new JsonlFrameReader(100);
    reader.push(bytes('{"id":1}'));

    expect(() => reader.finish()).toThrow(/truncated|截断/);
  });

  it('should_become_terminal_after_the_first_protocol_error', () => {
    const reader = new JsonlFrameReader(100);
    expect(() => reader.push(bytes('null\n'))).toThrow(JsonlFrameError);

    expect(() => reader.push(bytes('{"id":1}\n'))).toThrow(/failed|终止/);
  });
});
