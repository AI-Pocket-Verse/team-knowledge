// SSE endpoint for the dashboard's live updates. Any authenticated user (the
// live activity stream is part of the aggregate, publicly-visible dashboard).
// Auth is checked BEFORE opening the stream so a 401/403 is a normal JSON reply;
// only an authorized user gets the hijacked event-stream. The shared poller
// (services/dashboard-stream.ts) does the actual work — this just wires one
// connection in/out of its subscriber set.
import type { FastifyInstance } from "fastify";
import { requireUser } from "../utils/guards.js";
import { openSse } from "../utils/sse.js";
import { subscribeDashboard, unsubscribeDashboard } from "../services/dashboard-stream.js";

export async function adminDashboardStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/dashboard/stream", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return; // 401 / 403 already sent as JSON — stream not opened.

    const sse = openSse(reply);
    sse.send("hello", { at: new Date().toISOString() });
    subscribeDashboard(sse, user.isAdmin);

    // Client navigated away / closed the tab → drop the subscription and end
    // the stream. The poller stops itself once the last subscriber leaves.
    req.raw.on("close", () => {
      unsubscribeDashboard(sse);
      sse.end();
    });
  });
}
