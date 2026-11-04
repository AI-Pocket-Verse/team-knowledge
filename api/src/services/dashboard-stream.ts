// In-process shared poller backing the admin dashboard SSE stream. Mirrors the
// notify dispatcher's "poll loop, fine at this scale" posture: there is no
// audit-log table, so we re-derive recent activity from content tables every
// few seconds (loadActivityEvents) and push only the events newer than a
// cursor. ZERO write-path changes — write routes don't know this exists.
//
// Push shape (see openSse in utils/sse.ts):
//   event: hello    {at}            once, on connect
//   event: activity {items:[...]}   when new events appear (drives the live feed)
//   event: tick     {at}            every poll (drives the client's throttled
//                                    chart refetch + acts as a heartbeat)
import type { AdminDashboardActivity, DashboardStreamActivity } from "@team-knowledge/shared";
import type { SseWriter } from "../utils/sse.js";
import { prisma } from "../db.js";
import { loadActivityEvents, redactPrivateTitle, type ActivityEvent } from "./activity.js";

export const POLL_MS = 3000;
// How far back each poll scans for "new" events. Generous enough to tolerate a
// delayed tick, bounded so the query stays cheap (loadActivityEvents also caps
// rows per source internally).
const LOOKBACK_MS = 10 * 60 * 1000;

// 值 = 该订阅者是否管理员：管理员收到完整标题，其余人收不到自动化名 / 上传名。
const subscribers = new Map<SseWriter, boolean>();
let cursorMs = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** Pure: events with a real actor strictly newer than `cursor`, ascending. */
export function selectNewEvents(events: ActivityEvent[], cursor: number): ActivityEvent[] {
  return events
    .filter((e) => e.uid && e.at.getTime() > cursor)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

function broadcast(event: string, data: unknown, audience?: boolean): void {
  for (const [w, isAdmin] of subscribers) {
    if (audience !== undefined && audience !== isAdmin) continue;
    // Each writer self-guards against write-after-close; ignore any throw so
    // one dead connection can't break the broadcast to the others.
    try { w.send(event, data); } catch { /* ignore */ }
  }
}

/** One poll pass: discover new events since the cursor, push them, then tick. */
export async function tick(): Promise<void> {
  try {
    const windowStart = new Date(Date.now() - LOOKBACK_MS);
    // loadActivityEvents caps each source at SOURCE_CAP newest rows. At a 3s
    // poll that's far more than any realistic burst, but a bulk import/like-storm
    // exceeding the cap within one LOOKBACK window could let the live FEED skip
    // the overflow (the cursor advances past them). Aggregate numbers stay
    // correct via the tick-driven /analytics refetch; only the live list is
    // best-effort. Acceptable at admin-tooling scale.
    const events = await loadActivityEvents(windowStart);
    const fresh = selectNewEvents(events, cursorMs);
    if (fresh.length) {
      const ids = [...new Set(fresh.map((e) => e.uid as string))];
      const names = new Map(
        (await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }))
          .map((u) => [u.id, u.displayName]),
      );
      const items: AdminDashboardActivity[] = fresh.map((e) => ({
        id: e.id,
        userId: e.uid as string,
        userName: names.get(e.uid as string) ?? "（已删除）",
        type: e.type,
        title: e.title,
        at: e.at.toISOString(),
      }));
      broadcast("activity", { items } satisfies DashboardStreamActivity, true);
      const publicItems = items.map(redactPrivateTitle);
      broadcast("activity", { items: publicItems } satisfies DashboardStreamActivity, false);
      cursorMs = Math.max(cursorMs, ...fresh.map((e) => e.at.getTime()));
    }
    broadcast("tick", { at: new Date().toISOString() });
  } catch {
    // A single failed poll must not kill the interval.
  }
}

function start(): void {
  if (timer) return;
  // Only surface events AFTER the FIRST subscriber connects — the live feed
  // backfills its initial page via REST, so replaying LOOKBACK history here
  // would double up. The cursor is shared across subscribers: a later-joining
  // admin inherits the running cursor (may briefly see events that predate
  // their connect), which the client dedupes by event id. Reset only happens
  // when the loop restarts from zero subscribers.
  cursorMs = Date.now();
  timer = setInterval(() => { void tick(); }, POLL_MS);
}

function stop(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export function subscribeDashboard(w: SseWriter, isAdmin: boolean): void {
  subscribers.set(w, isAdmin);
  start();
}

export function unsubscribeDashboard(w: SseWriter): void {
  subscribers.delete(w);
  if (subscribers.size === 0) stop();
}

/** Stop the loop + end and drop all subscribers (called on app shutdown). */
export function stopDashboardStream(): void {
  // End the hijacked sockets — they're detached from Fastify's lifecycle, so
  // app.close() won't drain them for us.
  for (const w of subscribers.keys()) {
    try { w.end(); } catch { /* writer self-guards; ignore */ }
  }
  subscribers.clear();
  stop();
}

// ── test-only hooks (avoid spinning a real interval in unit tests) ──
export function __addTestSubscriber(w: SseWriter, isAdmin = false): void { subscribers.set(w, isAdmin); }
export function __setCursorMs(ms: number): void { cursorMs = ms; }
export function __subscriberCount(): number { return subscribers.size; }
export function __resetDashboardStream(): void { subscribers.clear(); stop(); cursorMs = 0; }
