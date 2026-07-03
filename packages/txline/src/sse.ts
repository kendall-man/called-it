/**
 * Minimal text/event-stream parser over a fetch ReadableStream.
 *
 * TxLINE streams emit two frame shapes:
 *   - data messages: `id: <timestamp:index>` + `data: <JSON record>`
 *   - heartbeats:    `event: heartbeat` (+ optional `data: {"Ts": …}`)
 *
 * Implements the SSE wire rules we rely on: frames separated by a blank
 * line, `data:` lines accumulate joined by \n, one leading space after the
 * colon is stripped, comment lines (leading ':') are ignored, and an
 * incomplete frame at EOF is discarded.
 */
export interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

const FRAME_DELIMITER = /\r\n\r\n|\n\n|\r\r/;
const LINE_DELIMITER = /\r\n|\r|\n/;

function parseFrame(rawFrame: string): SseFrame | null {
  let id: string | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const line of rawFrame.split(LINE_DELIMITER)) {
    if (line === '' || line.startsWith(':')) continue;
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    // 'retry' and unknown fields are intentionally ignored.
  }

  if (id === null && event === null && dataLines.length === 0) return null;
  return { id, event, data: dataLines.join('\n') };
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = FRAME_DELIMITER.exec(buffer);
        if (match === null) break;
        const rawFrame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = parseFrame(rawFrame);
        if (frame !== null) yield frame;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
