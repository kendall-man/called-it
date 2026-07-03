import { describe, expect, it } from 'vitest';
import { parseSseStream, type SseFrame } from './sse.js';

function streamFromChunks(chunks: string[], close = true): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of parseSseStream(streamFromChunks(chunks))) frames.push(frame);
  return frames;
}

describe('parseSseStream', () => {
  it('parses a data message with id (TxLINE timestamp:index format)', async () => {
    const frames = await collect(['id: 1730000000000:0\ndata: {"a":1}\n\n']);
    expect(frames).toEqual([{ id: '1730000000000:0', event: null, data: '{"a":1}' }]);
  });

  it('parses heartbeat frames', async () => {
    const frames = await collect(['event: heartbeat\ndata: {"Ts": 12345}\n\n']);
    expect(frames).toEqual([{ id: null, event: 'heartbeat', data: '{"Ts": 12345}' }]);
  });

  it('joins multiple data lines with newlines', async () => {
    const frames = await collect(['data: line1\ndata: line2\n\n']);
    expect(frames[0]?.data).toBe('line1\nline2');
  });

  it('ignores comment-only frames', async () => {
    const frames = await collect([': keepalive\n\n', 'data: x\n\n']);
    expect(frames).toEqual([{ id: null, event: null, data: 'x' }]);
  });

  it('strips exactly one leading space after the colon', async () => {
    const frames = await collect(['data:  spaced\n\n']);
    expect(frames[0]?.data).toBe(' spaced');
  });

  it('handles frames split across arbitrary chunk boundaries', async () => {
    const frames = await collect(['id: 1', '0\nda', 'ta: x', '\n\n']);
    expect(frames).toEqual([{ id: '10', event: null, data: 'x' }]);
  });

  it('handles CRLF line endings, including a delimiter split across chunks', async () => {
    const frames = await collect(['id: 1\r\ndata: y\r\n\r', '\nid: 2\r\ndata: z\r\n\r\n']);
    expect(frames).toEqual([
      { id: '1', event: null, data: 'y' },
      { id: '2', event: null, data: 'z' },
    ]);
  });

  it('parses multiple frames from one chunk', async () => {
    const frames = await collect(['data: a\n\ndata: b\n\n']);
    expect(frames.map((f) => f.data)).toEqual(['a', 'b']);
  });

  it('discards an incomplete frame at end of stream', async () => {
    const frames = await collect(['data: complete\n\ndata: partial']);
    expect(frames.map((f) => f.data)).toEqual(['complete']);
  });
});
