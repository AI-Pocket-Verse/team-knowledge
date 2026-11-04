import { useEffect, useRef } from "react";
import type { DashboardStreamActivity } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { parseSseChunk } from "@/lib/sse";
import { handleUnauthorized } from "@/lib/sseAuth";

interface Handlers {
  /** New live events (newest-first within the batch is NOT guaranteed; the
   *  poller pushes ascending, the consumer prepends). */
  onActivity: (items: DashboardStreamActivity["items"]) => void;
  /** A poll tick — drives the consumer's throttled chart refetch. */
  onTick: () => void;
}

const RECONNECT_MS = 3000;

// Subscribe to GET /api/admin/dashboard/stream via fetch + ReadableStream
// (cookie auth, shared parseSseChunk). Auto-reconnects with a fixed backoff
// when the stream ends/errors; never reconnects after unmount (abort) or a
// terminal 401/403.
export function useDashboardStream({ onActivity, onTick }: Handlers): void {
  // Keep the latest callbacks in a ref so a parent re-render (new closures)
  // doesn't tear down and re-open the stream.
  const cbs = useRef({ onActivity, onTick });
  cbs.current = { onActivity, onTick };

  useEffect(() => {
    const ac = new AbortController();
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    async function connect(): Promise<void> {
      try {
        const res = await fetch(api.admin.dashboardStreamUrl(), { credentials: "include", signal: ac.signal });
        if (!res.ok) {
          if (res.status === 401) { void handleUnauthorized(); return; } // terminal
          if (res.status === 403) return; // not an admin — don't hammer
          throw new Error(`stream ${res.status}`); // transient → reconnect
        }
        if (!res.body) throw new Error("no body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { events, rest } = parseSseChunk(buf);
          buf = rest;
          for (const evt of events) {
            if (evt.event === "activity") {
              try {
                const p = JSON.parse(evt.data) as DashboardStreamActivity;
                if (p.items?.length) cbs.current.onActivity(p.items);
              } catch { /* skip malformed */ }
            } else if (evt.event === "tick") {
              cbs.current.onTick();
            }
            // hello / ping ignored
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return; // unmounted — no reconnect
        // any other error falls through to the reconnect scheduler below
      }
      // Stream ended or errored (not aborted, not terminal) → backoff reconnect.
      if (!stopped) {
        reconnectTimer = setTimeout(() => { void connect(); }, RECONNECT_MS);
      }
    }

    void connect();
    return () => {
      stopped = true;
      ac.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);
}
