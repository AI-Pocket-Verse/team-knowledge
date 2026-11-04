// Shared SSE parsing for fetch-based event streams (chat + dashboard). We use
// fetch + ReadableStream rather than native EventSource so requests carry the
// auth cookie via credentials:"include" and can reuse the central 401 handling.
export interface SseEvent {
  event: string;
  data: string;
}

/** Parse complete `event:/data:` records out of a buffer, returning the events
 *  and any trailing partial record (to prepend to the next chunk). A record
 *  ends at a blank line ("\n\n"). */
export function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  // 规整 CRLF:个别反代(nginx/ALB)会把 \n 透传成 \r\n,残留的 \r 会让 "token\r"
  // 匹配不上事件名而被静默丢弃。直接剥掉 \r(\r\n→\n),不新增空行。
  let rest = buffer.replace(/\r/g, "");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const idx = rest.indexOf("\n\n");
    if (idx < 0) break;
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let evt = "message";
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event: ")) evt = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    events.push({ event: evt, data: dataLines.join("\n") });
  }
  return { events, rest };
}
