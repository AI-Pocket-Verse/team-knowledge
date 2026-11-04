import { describe, it, expect } from "vitest";
import { parseFrame } from "./volc.js";

// Regression for the live-verified bug: connection-level server events
// (50/51/52) carry a connection_id string before the payload, but parseFrame
// only read an id string for events >=100. That made `offset` land mid-frame,
// so `payload` became the connection_id and the synthesis session stalled.

const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };

// Build a server event frame: header(mt=0x9, FLAG_EVENT) + event + [idStr] + payload.
function serverFrame(eventId: number, idStr: string | null, payload: string): Buffer {
  const header = Buffer.from([0x11, (0x9 << 4) | 0x4, 0x10, 0x00]);
  const parts = [header, be32(eventId)];
  if (idStr !== null) { const s = Buffer.from(idStr, "utf8"); parts.push(be32(s.length), s); }
  const p = Buffer.from(payload, "utf8");
  parts.push(be32(p.length), p);
  return Buffer.concat(parts);
}

describe("volc tts parseFrame", () => {
  it("reads the connection_id on connection-level events (50) so payload isn't the id", () => {
    const connId = "4c7e2220-c0b5-406e-a83c-a55ca6ddbbaa";
    const parsed = parseFrame(serverFrame(50, connId, "{}"));
    expect(parsed).not.toBeNull();
    expect(parsed!.eventId).toBe(50);
    expect(parsed!.sessionId).toBe(connId);
    expect(parsed!.payload.toString("utf8")).toBe("{}"); // NOT the connId
  });

  it("reads the session_id on session-level events (>=100)", () => {
    const parsed = parseFrame(serverFrame(150, "session-xyz", '{"ok":true}'))!;
    expect(parsed.eventId).toBe(150);
    expect(parsed.sessionId).toBe("session-xyz");
    expect(parsed.payload.toString("utf8")).toBe('{"ok":true}');
  });
});
