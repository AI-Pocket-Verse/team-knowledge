import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  MeetingCommentRow,
  MeetingCommentTrigger,
  MeetingConfig,
  MeetingDetailResponse,
  MeetingHubResponse,
  MeetingSessionRow,
  MeetingStatus,
  MeetingTranscriptRow,
} from "@team-knowledge/shared";
import { isMeetingSummaryFailure } from "@team-knowledge/shared";
import { resolve, join } from "node:path";
import { createReadStream, existsSync, statSync } from "node:fs";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { requireUser } from "../utils/guards.js";
import { meetingConfigSchema, meetingCreateSchema, meetingUpdateSchema } from "../schemas/meeting.js";
import { shutdownMeetingChannel, kickViewersFromPrivateMeeting } from "./meeting-ws.js";
import { generateMeetingSummary } from "../services/meeting/summary.js";
import { scheduleAutoEnd, cancelAutoEnd, unlinkTtsClipsForComments } from "../services/meeting/lifecycle.js";
import { getUserRoleIds } from "../utils/permissions.js";
import { canViewMeeting, canEditMeetingMeta } from "../utils/meeting-access.js";
import { ASSISTANT_NAME } from "../utils/assistant.js";
import { uniqueArticleId } from "../utils/shortId.js";
import { syncArticleLinks } from "../utils/articleLinks.js";
import { markRoleSkillStale } from "../services/role-skill/stale.js";

//助手会议 — routes
//   POST   /api/meeting          admin-only, single active per admin
//   GET    /api/meeting/hub      list current active + recent (any user)
//   GET    /api/meeting/:id      live or summary detail (any user)
//   DELETE /api/meeting/:id      end meeting (host OR any admin)
//
// The WebSocket audio channel is separate (meeting-ws.ts); the REST
// routes here only surface session metadata. The shape is fixed now so the frontend can render the
// hub + a stub meeting room without churning later.

// GET /api/meeting/:id hydration caps. Transcripts are returned IN FULL — no
// row cap — so the ended-meeting timeline shows the COMPLETE transcription
// (we want the whole record, not the last N segments). A long meeting can mean
// thousands of rows on each detail GET; that's the deliberate trade for a
// complete transcript. Comments stay capped (they're far fewer and rarely the
// bottleneck). The SUMMARY view is independent either way: generateMeetingSummary
// reads transcripts straight from the DB, bounded by its own MAX_TRANSCRIPT_CHARS.
const MEETING_DETAIL_COMMENT_CAP = 200;

function decodeAllowedRoleIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch { return []; }
}

function decodeConfig(raw: string): MeetingConfig {
  try {
    const parsed = meetingConfigSchema.parse(JSON.parse(raw));
    return parsed;
  } catch {
    // Defensive default — a malformed/legacy config row shouldn't
    // crash the hub. zod's `.default()` chain inside the schema
    // gives us a complete object even when we pass `{}`.
    return meetingConfigSchema.parse({});
  }
}

function decodeCitedArticleIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch { return []; }
}

type RoleDisplay = { id: string; name: string; color: string | null };

// Prefetched lookup maps for the list/batch serialization path. When
// provided, serializeSession skips its per-row role.findMany + host
// user.findUnique and reads from these maps instead — collapsing the
// hub's prior ~140 queries (2 per session × up to 70 rows) down to 2
// total (see serializeSessions). Absent (single-row callers like
// POST/PATCH/DELETE) it falls back to the per-row queries.
interface SessionPrefetch {
  roles: Map<string, RoleDisplay>;
  hostNames: Map<string, string | null>;
}

async function serializeSession(row: {
  id: string;
  title: string;
  status: string;
  visibility: string;
  createdById: string;
  allowedRoleIds: string;
  config: string;
  recordingUrl: string | null;
  summaryMarkdown: string | null;
  createdAt: Date;
  endedAt: Date | null;
}, prefetch?: SessionPrefetch): Promise<MeetingSessionRow> {
  const roleIds = decodeAllowedRoleIds(row.allowedRoleIds);
  // Resolve role display info. Filter+reorder to preserve the admin's
  // chosen order (Prisma findMany doesn't honor `in`-array ordering).
  // Use the prefetched map on the batch path; fall back to a per-row
  // query for single-row callers.
  let byId: Map<string, RoleDisplay>;
  if (prefetch) {
    byId = prefetch.roles;
  } else {
    const roles = await prisma.role.findMany({
      where: { id: { in: roleIds } },
      select: { id: true, name: true, color: true },
    });
    byId = new Map(roles.map((r) => [r.id, r] as const));
  }
  const allowedRoles = roleIds
    .map((id) => byId.get(id))
    .filter((r): r is RoleDisplay => !!r);

  const hostName = prefetch
    ? prefetch.hostNames.get(row.createdById) ?? null
    : (await prisma.user.findUnique({
        where: { id: row.createdById },
        select: { displayName: true },
      }))?.displayName ?? null;

  return {
    id: row.id,
    title: row.title,
    status: row.status as MeetingStatus,
    visibility: row.visibility === "private" ? "private" : "public",
    hostUserId: row.createdById,
    // Host should always exist (FK cascades, so if user is gone the
    // session is too) — fallback string is paranoia.
    hostName: hostName ?? "（已删除）",
    allowedRoleIds: roleIds,
    allowedRoles,
    config: decodeConfig(row.config),
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    recordingUrl: row.recordingUrl,
    summaryMarkdown: row.summaryMarkdown,
  };
}

// Batch-serialize a list of session rows with exactly TWO queries total
// (all roles in one `in`, all host displayNames in one `in`) regardless
// of list length, then map them into serializeSession via the prefetch.
// Replaces the prior N+1 where each row did its own role.findMany + host
// user.findUnique — the hub serializes up to 70 rows, so this cuts ~140
// queries to 2.
async function serializeSessions(
  rows: Parameters<typeof serializeSession>[0][],
): Promise<MeetingSessionRow[]> {
  if (rows.length === 0) return [];
  const roleIdSet = new Set<string>();
  const hostIdSet = new Set<string>();
  for (const row of rows) {
    for (const id of decodeAllowedRoleIds(row.allowedRoleIds)) roleIdSet.add(id);
    hostIdSet.add(row.createdById);
  }
  const [roles, hosts] = await Promise.all([
    roleIdSet.size > 0
      ? prisma.role.findMany({
          where: { id: { in: [...roleIdSet] } },
          select: { id: true, name: true, color: true },
        })
      : Promise.resolve([] as RoleDisplay[]),
    prisma.user.findMany({
      where: { id: { in: [...hostIdSet] } },
      select: { id: true, displayName: true },
    }),
  ]);
  const prefetch: SessionPrefetch = {
    roles: new Map(roles.map((r) => [r.id, r] as const)),
    hostNames: new Map(hosts.map((h) => [h.id, h.displayName] as const)),
  };
  return Promise.all(rows.map((row) => serializeSession(row, prefetch)));
}

function serializeTranscript(row: {
  id: string; text: string; startMs: number; endMs: number;
  speaker: string | null; createdAt: Date;
}): MeetingTranscriptRow {
  return {
    id: row.id,
    text: row.text,
    startMs: row.startMs,
    endMs: row.endMs,
    speaker: row.speaker,
    createdAt: row.createdAt.toISOString(),
  };
}

type CommentRowInput = {
  id: string; triggerType: string; triggeredByUserId: string | null;
  text: string; citedArticleIds: string | null; ttsAudioUrl: string | null;
  atMs: number; createdAt: Date;
};

function serializeComment(
  row: CommentRowInput,
  triggeredByName: string | null,
  titleById: Map<string, string>,
): MeetingCommentRow {
  const citedArticleIds = decodeCitedArticleIds(row.citedArticleIds);
  // Build the clickable refs from resolved titles. A cited id with no title
  // (doc deleted) drops out of citedRefs but stays counted in citedArticleIds.
  const citedRefs = citedArticleIds.flatMap((articleId) => {
    const title = titleById.get(articleId);
    return title ? [{ articleId, title }] : [];
  });
  return {
    id: row.id,
    triggerType: row.triggerType as MeetingCommentTrigger,
    triggeredByUserId: row.triggeredByUserId,
    triggeredByName,
    text: row.text,
    citedArticleIds,
    citedRefs,
    ttsAudioUrl: row.ttsAudioUrl,
    atMs: row.atMs,
    createdAt: row.createdAt.toISOString(),
  };
}

// Batch-serialize comments with ONE query for all triggeredByUserId
// displayNames (was a per-comment user.findUnique → N+1 across the set).
async function serializeComments(rows: CommentRowInput[]): Promise<MeetingCommentRow[]> {
  const triggeredByIds = [...new Set(
    rows.map((r) => r.triggeredByUserId).filter((id): id is string => id != null),
  )];
  const nameById = new Map<string, string | null>();
  if (triggeredByIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: triggeredByIds } },
      select: { id: true, displayName: true },
    });
    for (const u of users) nameById.set(u.id, u.displayName);
  }
  // Resolve titles for every cited article across the whole set in ONE query
  // so the post-comment links can render 《title》. Only live docs
  // (deletedAt: null) — a binned doc drops out of citedRefs (its link would
  // 404) while still counting toward citedArticleIds.
  const citedIds = [...new Set(rows.flatMap((r) => decodeCitedArticleIds(r.citedArticleIds)))];
  const titleById = new Map<string, string>();
  if (citedIds.length > 0) {
    const articles = await prisma.article.findMany({
      where: { id: { in: citedIds }, deletedAt: null },
      select: { id: true, title: true },
    });
    for (const a of articles) titleById.set(a.id, a.title);
  }
  return rows.map((row) =>
    serializeComment(row, row.triggeredByUserId ? nameById.get(row.triggeredByUserId) ?? null : null, titleById),
  );
}

const idParamSchema = z.object({ id: z.string().min(1) });

// Permanently remove a meeting: delete the row (FK cascades transcripts
// + comments) and best-effort unlink the on-disk .wav recording + every
// assistant TTS .mp3. Extracted from the old DELETE /:id/hard handler so the
// recycle-bin permanent-delete route can reuse the exact same teardown.
// Caller is responsible for authorization + the "ended" guard.
// 存进文档的录音链接必须离开应用也能点开:库里的 recordingUrl 是不带 /api 前缀的相对路径
// (前端播放器用 API_BASE 拼接),直接写进文档会解析到站点根而 404。这里用站点地址
// WEB_PUBLIC_URL(部署在子路径时含路径前缀;未配置时取默认 http://localhost:5030)+ /api 拼成
// 绝对地址,并带 download=1 让浏览器按会议标题另存。
function recordingDownloadUrl(recordingUrl: string): string {
  return `${env.WEB_PUBLIC_URL.replace(/\/$/, "")}/api${recordingUrl}?download=1`;
}

export async function purgeMeeting(row: { id: string }): Promise<void> {
  // Collect comment ids BEFORE the row is deleted, so we know which
  // mp3 files to unlink from disk. Cascade FK takes care of the
  // MeetingComment + MeetingTranscript rows themselves when we delete
  // the session. NOT filtered on ttsAudioUrl: streamed assistant comments leave
  // it null but still write per-sentence `<id>-<seq>.mp3` clips that must be
  // reaped — so we collect every comment id and let the readdir-glob helper
  // match both `<id>.mp3` and `<id>-<seq>.mp3`.
  const commentIds = (await prisma.meetingComment.findMany({
    where: { sessionId: row.id },
    select: { id: true },
  })).map((c) => c.id);

  // Belt-and-suspenders cancel of any pending auto-end timer.
  cancelAutoEnd(row.id);

  await prisma.meetingSession.delete({ where: { id: row.id } });

  // Disk cleanup — best effort. The DB row is the source of truth; if
  // unlink fails (file already gone, permission, etc) we leave the file
  // and continue. The daily artifact cleanup picks orphans up later.
  const recDir = resolve(join(env.DATA_DIR, "meeting-recordings"));
  const ttsDir = resolve(join(env.DATA_DIR, "meeting-tts"));
  const { unlink } = await import("node:fs/promises");
  try { await unlink(join(recDir, `${row.id}.wav`)); } catch { /* may not exist */ }
  // Unlink both `<id>.mp3` and the streamed per-sentence `<id>-<seq>.mp3`
  // clips via the shared readdir-glob (handles the ttsAudioUrl-null clips).
  await unlinkTtsClipsForComments(ttsDir, commentIds);
}

export async function meetingRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/meeting — start a new meeting (admin only).
  // Enforces "this admin doesn't already host an active meeting".
  // We do the check + create in a tiny critical section using
  // `findFirst`; SQLite + Prisma serializes writes anyway so the race
  // window is microseconds. If two requests slip through, the second
  // still succeeds — worst case is two active rows for the same host,
  // which is recoverable by the admin ending one.
  app.post("/api/meeting", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    // Any logged-in user (incl. role-less) may start a meeting. Visibility
    // (public/private) controls who can see it, not who can create it.

    const parsed = meetingCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_input",
        message: parsed.error.issues[0]?.message ?? "无效的会议参数",
      });
    }

    // Verify every chosen role exists — only when roles were actually
    // provided. An empty scope is valid now (assistant retrieves public docs only),
    // so skip the lookup rather than treating "no roles" as an error.
    if (parsed.data.allowedRoleIds.length > 0) {
      const roles = await prisma.role.findMany({
        where: { id: { in: parsed.data.allowedRoleIds } },
        select: { id: true },
      });
      if (roles.length !== parsed.data.allowedRoleIds.length) {
        return reply.code(400).send({
          error: "invalid_input",
          message: "包含无效的角色，请刷新后重试",
        });
      }
    }

    // Wrap the single-active check + create in a
    // transaction. The prior pattern (findFirst → create as two
    // separate statements) had a microsecond race where a
    // rapid double-POST from the same admin could pass both
    // checks and create two active rows for the same host.
    // The transaction collapses that window to zero.
    const txResult = await prisma.$transaction(async (tx) => {
      const existing = await tx.meetingSession.findFirst({
        where: { createdById: user.id, status: "active" },
        select: { id: true, title: true },
      });
      if (existing) return { kind: "existing" as const, existing };
      const created = await tx.meetingSession.create({
        data: {
          title: parsed.data.title,
          createdById: user.id,
          allowedRoleIds: JSON.stringify(parsed.data.allowedRoleIds),
          config: JSON.stringify(parsed.data.config),
          status: "active",
          visibility: parsed.data.visibility,
        },
      });
      return { kind: "created" as const, created };
    });

    if (txResult.kind === "existing") {
      return reply.code(409).send({
        error: "active_meeting_exists",
        message: `你已经在主持「${txResult.existing.title}」，请先结束再开新会议`,
        activeMeetingId: txResult.existing.id,
      });
    }
    const created = txResult.created;

    // Schedule the auto-end timer so an abandoned
    // meeting (browser crash, host forgot) eventually flips
    // ended and frees the admin's single-active slot. The
    // helper is idempotent and cancelable; DELETE cancels.
    scheduleAutoEnd(created.id, created.createdAt, parsed.data.config.durationHintHours, req.log);

    req.log.info(
      { event: "meeting.created", id: created.id, by: user.id },
      "meeting started",
    );

    return { session: await serializeSession(created) };
  });

  // GET /api/meeting/hub — list page.
  //   active: every running meeting in the org (capped at 50 for safety)
  //   recent: last 20 ended meetings, newest first
  // Any logged-in user can see this list; doesn't leak content, only
  // metadata + role display info. Active meetings are deliberately
  // visible to everyone so non-admin can find the in-progress room
  // and click in to watch read-only.
  app.get("/api/meeting/hub", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    // Visibility filter: everyone (admins included) sees public meetings plus
    // their own private ones. A private meeting is creator-only — admins get no
    // bypass. Spreads into each `where` below.
    const visWhere = { OR: [{ visibility: "public" }, { createdById: user.id }] };

    const [activeRows, recentRows] = await Promise.all([
      prisma.meetingSession.findMany({
        where: { status: "active", deletedAt: null, ...visWhere },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.meetingSession.findMany({
        where: { status: "ended", deletedAt: null, ...visWhere },
        orderBy: { endedAt: "desc" },
        take: 20,
      }),
    ]);

    // Batch-serialize both lists (2 queries each) instead of the prior
    // per-row N+1 — at up to 50+20 rows that was ~140 queries per /hub hit.
    const [active, recent] = await Promise.all([
      serializeSessions(activeRows),
      serializeSessions(recentRows),
    ]);
    return { active, recent } satisfies MeetingHubResponse;
  });

  // GET /api/meeting/:id — detail (live room data or summary view).
  // Bundles the session row + persisted transcripts + persisted
  // comments. Transcripts/comments are empty here (no audio path
  // yet), so the response is just session + two empty arrays for now
  // — the shape stays stable across phases.
  app.get<{ Params: { id: string } }>("/api/meeting/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_input", message: "无效的会议 id" });

    const row = await prisma.meetingSession.findUnique({ where: { id: params.data.id } });
    if (!row || row.deletedAt != null) return reply.code(404).send({ error: "not_found", message: "会议不存在或已删除" });
    // Private meetings: 404 (not 403) for non-creator non-admins so their
    // existence isn't revealed.
    if (!canViewMeeting(user, row)) return reply.code(404).send({ error: "not_found", message: "会议不存在或已删除" });

    // Full transcript — fetched in ascending order with NO cap, so a late
    // joiner / refreshed viewer and the ended-meeting timeline both get the
    // COMPLETE transcription; WS deltas append the live edge from there.
    // Comments are still capped (far fewer, rarely a bottleneck). The SUMMARY
    // view is independent: generateMeetingSummary reads straight from the DB,
    // bounded by its own MAX_TRANSCRIPT_CHARS.
    const [transcriptRows, commentRows] = await Promise.all([
      prisma.meetingTranscript.findMany({
        where: { sessionId: row.id },
        orderBy: { startMs: "asc" },
      }),
      prisma.meetingComment.findMany({
        where: { sessionId: row.id },
        orderBy: { atMs: "desc" },
        take: MEETING_DETAIL_COMMENT_CAP,
      }),
    ]);
    const transcripts = transcriptRows.map(serializeTranscript);
    const comments = await serializeComments(
      commentRows.sort((a, b) => a.atMs - b.atMs),
    );

    return {
      session: await serializeSession(row),
      transcripts,
      comments,
    } satisfies MeetingDetailResponse;
  });

  // PATCH /api/meeting/:id — edit meeting metadata (visibility, title).
  // Allowed for the creator or any admin, on active OR ended meetings (you
  // can flip a finished meeting public/private after the fact).
  app.patch<{ Params: { id: string } }>("/api/meeting/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_input", message: "无效的会议 id" });

    const parsed = meetingUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "无效的参数" });
    }
    if (parsed.data.title === undefined && parsed.data.visibility === undefined) {
      return reply.code(400).send({ error: "invalid_input", message: "没有可更新的字段" });
    }

    const row = await prisma.meetingSession.findUnique({ where: { id: params.data.id } });
    if (!row || row.deletedAt != null) return reply.code(404).send({ error: "not_found", message: "会议不存在或已删除" });
    // View gate first: a private meeting is creator-only, so a non-creator
    // (incl. an admin) gets 404 — its existence isn't revealed — before any
    // edit-permission check runs.
    if (!canViewMeeting(user, row)) return reply.code(404).send({ error: "not_found", message: "会议不存在或已删除" });
    if (!canEditMeetingMeta(user, row)) {
      return reply.code(403).send({ error: "forbidden", message: "只有主持人或管理员可以修改会议" });
    }

    const updated = await prisma.meetingSession.update({
      where: { id: row.id },
      data: {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
      },
    });
    // 改为私密后,已在线的围观者仍握着升级时通过的可见性检查,必须主动踢出(主持人即创建者,保留)。
    if (updated.visibility === "private") kickViewersFromPrivateMeeting(updated.id);
    req.log.info({ event: "meeting.updated", id: row.id, by: user.id, visibility: updated.visibility }, "meeting metadata updated");
    return { session: await serializeSession(updated) };
  });

  // DELETE /api/meeting/:id — end the meeting.
  // Allowed by the host OR any other admin (so an admin can clean up
  // after a teammate who forgot to end their meeting / closed their
  // browser). Idempotent: ending an already-ended meeting returns 200
  // unchanged. Cascades on the schema take care of transcripts /
  // comments, but those stay in place — we only flip status + endedAt
  // so the summary view still has data to render.
  app.delete<{ Params: { id: string } }>("/api/meeting/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_input", message: "无效的会议 id" });

    const row = await prisma.meetingSession.findUnique({ where: { id: params.data.id } });
    if (!row || row.deletedAt != null) return reply.code(404).send({ error: "not_found", message: "会议不存在或已删除" });

    // View gate first: a private meeting is creator-only, so a non-creator
    // (incl. an admin) gets 404 before the host/admin end-permission check.
    if (!canViewMeeting(user, row)) return reply.code(404).send({ error: "not_found", message: "会议不存在或已删除" });

    if (!user.isAdmin && row.createdById !== user.id) {
      return reply.code(403).send({ error: "forbidden", message: "只有主持人或管理员可以结束会议" });
    }

    if (row.status === "ended") {
      // Idempotent — surface the already-ended state without an error
      // so the host's "end" button + an admin's parallel "force end"
      // don't race into a confusing 4xx.
      return { session: await serializeSession(row) };
    }

    // Cancel any pending auto-end timer — this DELETE is the
    // host/admin's explicit end, so the auto-end no longer
    // needs to fire. Idempotent: safe to call even if no timer
    // is registered.
    cancelAutoEnd(row.id);

    // Atomic transition guard: updateMany only flips rows still in
    // "active". If two concurrent DELETEs race past the findUnique
    // above, only one's updateMany returns count=1; the other gets
    // count=0 and bails to the idempotent already-ended path. We
    // also flip the DB status BEFORE shutdown so an immediate
    // POST /api/meeting from the same admin doesn't see a stale
    // "active" row in its single-active-per-admin check.
    const transition = await prisma.meetingSession.updateMany({
      where: { id: row.id, status: "active" },
      data: { status: "ended", endedAt: new Date() },
    });
    if (transition.count === 0) {
      const reread = await prisma.meetingSession.findUnique({ where: { id: row.id } });
      return { session: await serializeSession(reread ?? row) };
    }

    // Shutdown the WS channel after the DB row is locked into
    // "ended": disconnects every host/viewer socket, flushes the
    // on-disk recording stream, and returns the recording URL
    // (null if recording was disabled OR no audio was captured).
    // The shutdown helper itself is idempotent via shuttingDown,
    // so any duplicate caller is harmless.
    const { recordingUrl } = await shutdownMeetingChannel(row.id);

    // Persist the recording URL onto the now-ended row.
    const updated = await prisma.meetingSession.update({
      where: { id: row.id },
      data: { recordingUrl },
    });

    req.log.info(
      { event: "meeting.ended", id: updated.id, by: user.id, byHost: row.createdById === user.id, recordingUrl },
      "meeting ended",
    );

    // Kick the summary generator fire-and-forget. It writes
    // back to MeetingSession.summaryMarkdown when done; the
    // frontend polls /api/meeting/:id until summaryMarkdown !==
    // null. We don't await it — the DELETE response should be
    // snappy + the user's UI flips to the post-meeting view
    // immediately, just with a "generating..." placeholder until
    // the LLM call finishes.
    void generateMeetingSummary(updated.id, req.log).catch((err) => {
      req.log.error({ event: "meeting.summary.unhandled", id: updated.id, err: (err as Error).message }, "summary generator threw");
    });

    return { session: await serializeSession(updated) };
  });

  // POST /api/meeting/:id/summary — force-regenerate the meeting
  // summary, bypassing the helper's "already-generated" short-circuit.
  // Used by the post-meeting "重新生成纪要" button when the
  // auto-fire produced a bad/empty/failure-marker result. Admin OR
  // host can run it.
  //
  // Force semantics: clears summaryMarkdown to NULL before calling
  // the generator, so the helper's early-return on already-set
  // markdown doesn't kick in. The CAS inside the generator handles
  // any race with a concurrent auto-fire from DELETE.
  app.post<{ Params: { id: string } }>("/api/meeting/:id/summary", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_input", message: "无效的会议 id" });

    const row = await prisma.meetingSession.findUnique({ where: { id: params.data.id } });
    if (!row || row.deletedAt != null) return reply.code(404).send({ error: "not_found", message: "会议不存在" });
    // View gate first: a private meeting is creator-only, so a non-creator
    // (incl. an admin) gets 404 before the host/admin regenerate check.
    if (!canViewMeeting(user, row)) return reply.code(404).send({ error: "not_found", message: "会议不存在" });
    if (!user.isAdmin && row.createdById !== user.id) {
      return reply.code(403).send({ error: "forbidden", message: "只有主持人或管理员可以重新生成纪要" });
    }
    if (row.status !== "ended") {
      return reply.code(400).send({ error: "not_ended", message: "会议尚未结束，不能生成纪要" });
    }

    // Clear the existing markdown so the generator actually re-runs
    // the LLM instead of short-circuiting. We don't need a CAS here
    // because the helper's own CAS (on `summaryMarkdown: null`) is
    // the race linchpin — losing this clear means a concurrent
    // writer already cleared, which we'd just redo anyway.
    await prisma.meetingSession.update({
      where: { id: row.id },
      data: { summaryMarkdown: null },
    });

    const result = await generateMeetingSummary(row.id, req.log);
    if (!result.summaryMarkdown || isMeetingSummaryFailure(result.summaryMarkdown)) {
      return reply.code(502).send({ error: "summary_failed", message: "纪要生成失败，请稍后再试", reason: result.reason });
    }
    const updated = await prisma.meetingSession.findUnique({ where: { id: row.id } });
    return { session: await serializeSession(updated ?? row) };
  });

  // POST /api/meeting/:id/save-as-article — admin saves the
  // generated summary into the knowledge base as a new Article.
  // By product decision the default is NOT to auto-archive; this button is
  // the opt-in. Requires summaryMarkdown to be set (LLM-generated
  // already). Body: {roleId, folderId?} — admin picks where it
  // lands. Returns the new article id so the UI can link to it.
  //
  // Per-article ACL: the created Article gets only `createdById`
  // set — meeting participants are NOT auto-granted editor access
  // via ArticleEditor. The article inherits the standard role-
  // membership permission model (author + admins can edit). The
  // host can add collaborators after the article opens for
  // review, the same way any draft is shared.
  app.post<{ Params: { id: string }; Body: unknown }>("/api/meeting/:id/save-as-article", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_input", message: "无效的会议 id" });
    const bodySchema = z.object({
      roleId: z.string().min(1),
      folderId: z.string().min(1).nullable().optional(),
    });
    const body = bodySchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_input", message: body.error.issues[0]?.message ?? "无效的参数" });
    }

    const row = await prisma.meetingSession.findUnique({ where: { id: params.data.id } });
    if (!row || row.deletedAt != null) return reply.code(404).send({ error: "not_found", message: "会议不存在" });
    // View gate first: a private meeting is creator-only, so a non-creator
    // (incl. an admin) gets 404 before the host/admin save check.
    if (!canViewMeeting(user, row)) return reply.code(404).send({ error: "not_found", message: "会议不存在" });
    if (!user.isAdmin && row.createdById !== user.id) {
      return reply.code(403).send({ error: "forbidden", message: "只有主持人或管理员可以保存纪要" });
    }
    if (!row.summaryMarkdown || isMeetingSummaryFailure(row.summaryMarkdown)) {
      return reply.code(400).send({ error: "no_summary", message: "纪要尚未生成或生成失败，请先重新生成" });
    }

    // Resolve role + optional folder. Verify they exist and that
    // the folder (if any) belongs to the chosen role.
    const role = await prisma.role.findUnique({ where: { id: body.data.roleId }, select: { id: true } });
    if (!role) return reply.code(400).send({ error: "invalid_input", message: "目标角色不存在" });

    // Match the article-creation permission model in routes/articles.ts:
    // role membership (or admin) is the gate for writing under a role.
    // Folder visibility is read-only by design and doesn't gate writes.
    const userRoleIds = await getUserRoleIds(user.id);
    if (!user.isAdmin && !userRoleIds.has(role.id)) {
      return reply.code(403).send({ error: "forbidden", message: "无权在该角色下创建文档" });
    }
    let folderId: string | null = null;
    if (body.data.folderId) {
      const folder = await prisma.folder.findUnique({ where: { id: body.data.folderId }, select: { id: true, roleId: true, deletedAt: true } });
      if (!folder || folder.deletedAt != null || folder.roleId !== body.data.roleId) {
        return reply.code(400).send({ error: "invalid_input", message: "目录不存在或不属于该角色" });
      }
      folderId = folder.id;
    }

    // Idempotency: tag the article body with a hidden HTML comment
    // keyed off the meeting id. A re-click (or a parallel click from
    // a second admin) finds the existing article and returns its id
    // instead of creating a duplicate. The marker renders to nothing
    // in any Markdown viewer.
    //
    // Robustness (no schema migration this round):
    //   - DETERMINISTIC target: order by createdAt asc, id asc and take the
    //     FIRST match. Without an orderBy the chosen row was non-deterministic
    //     when two live articles carry the same marker (e.g. a binned saved
    //     summary was restored alongside a re-save), so back-to-back saves
    //     could return different ids. Earliest-created is the canonical draft.
    //   - ANCHORED match: save-as-article always writes the marker as the very
    //     first characters of contentMarkdown (see the compose step below), so
    //     we post-filter on startsWith(sourceMarker). The `contains` DB filter
    //     stays as the (cheap) prefilter, but an unrelated doc that merely PASTED
    //     the marker string mid-body is no longer a false idempotent hit.
    //
    // Long-term proper fix (DEFERRED — needs a migration + backfill): a
    // dedicated indexed `meetingSourceId` column on Article. That removes the
    // string scan entirely and makes the dedupe a unique-index lookup. Tracked
    // separately; out of scope for this no-migration round.
    const sourceMarker = `<!-- meeting-source:${row.id} -->`;
    const candidates = await prisma.article.findMany({
      // A previously-saved article that's now in the bin shouldn't count
      // as the idempotent hit — let a re-save create a fresh draft.
      where: { contentMarkdown: { contains: sourceMarker }, deletedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, title: true, contentMarkdown: true },
    });
    // Earliest-created article whose body actually STARTS with the marker — a
    // genuine save-as-article output, not a coincidental mid-body paste.
    const match = candidates.find((a) => a.contentMarkdown.startsWith(sourceMarker));
    if (match) {
      const existing = { id: match.id, title: match.title };
      req.log.info(
        { event: "meeting.save_as_article.idempotent_hit", meetingId: row.id, articleId: existing.id, by: user.id },
        "save-as-article returned existing draft",
      );
      return { article: existing };
    }

    // Compose the article body: marker + meta block + the generated
    // summary. Title = meeting title.
    const meta = [
      `> 来源：${ASSISTANT_NAME} 会议「${row.title}」`,
      `> 开始时间：${row.createdAt.toISOString()}`,
      row.endedAt ? `> 结束时间：${row.endedAt.toISOString()}` : null,
      row.recordingUrl ? `> 录音：[下载](${recordingDownloadUrl(row.recordingUrl)})` : null,
    ].filter(Boolean).join("\n");
    const contentMarkdown = `${sourceMarker}\n${meta}\n\n${row.summaryMarkdown}`;

    // Next sortOrder = (current max in the target sibling group) + 1, matching
    // routes/articles.ts create. Without this the saved summary defaulted to
    // sortOrder=0 and always landed at the top of its folder/role (or tied
    // with other 0s) instead of appending to the end like a normal new draft.
    const sortAgg = await prisma.article.aggregate({
      where: folderId ? { folderId } : { folderId: null, roleId: role.id },
      _max: { sortOrder: true },
    });
    const nextSort = (sortAgg._max.sortOrder ?? 0) + 1;

    // 与 POST /api/articles 同一口径:短 id、同事务内同步引用与图片绑定,提交后标记角色技能待更新。
    const newArticleId = await uniqueArticleId();
    const article = await prisma.$transaction(async (tx) => {
      const a = await tx.article.create({
        data: {
          id: newArticleId,
          title: `${row.title} - 会议纪要`,
          contentMarkdown,
          roleId: role.id,
          folderId,
          sortOrder: nextSort,
          createdById: user.id,
        },
        select: { id: true, title: true },
      });
      await syncArticleLinks(tx, a.id, contentMarkdown);
      return a;
    });
    markRoleSkillStale(role.id);

    req.log.info(
      { event: "meeting.saved_as_article", meetingId: row.id, articleId: article.id, by: user.id },
      "meeting summary saved as article",
    );
    return { article };
  });

  // GET /meeting-recordings/:filename — auth-gated playback
  // endpoint for the .ogg file written during the meeting. Any
  // logged-in user who can see the meeting (the existing /hub
  // surfaces all meetings to all logged-in users) can listen,
  // matching the "viewer can watch in real-time" semantics
  // for the post-meeting replay too.
  app.get<{ Params: { filename: string }; Querystring: { download?: string } }>("/api/meeting-recordings/:filename", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const filename = req.params.filename;
    // Strict regex: only cuid-shaped session ids + .wav. Blocks
    // path traversal / arbitrary file access via this endpoint.
    if (!/^[a-z0-9]+\.wav$/i.test(filename)) {
      return reply.code(404).send({ error: "not_found", message: "文件不存在" });
    }
    const sessionId = filename.replace(/\.wav$/i, "");
    // Verify a MeetingSession exists with a matching recordingUrl.
    // We compare against the persisted URL (not just the
    // filename) so an attacker can't access recordings whose
    // session was deleted or whose recordingUrl was nulled.
    const row = await prisma.meetingSession.findUnique({
      where: { id: sessionId },
      select: { recordingUrl: true, createdById: true, visibility: true, deletedAt: true, title: true },
    });
    if (!row || row.deletedAt != null || row.recordingUrl !== `/meeting-recordings/${filename}`) {
      return reply.code(404).send({ error: "not_found", message: "录音不存在" });
    }
    // Access gates purely on visibility: a private meeting's audio is for the
    // creator only (admins get no bypass), a public meeting's audio is for any
    // logged-in user. allowedRoleIds is NOT consulted — per product decision it
    // scopes only assistant retrieval, never access to the meeting's artifacts.
    if (!canViewMeeting(user, row)) {
      return reply.code(403).send({ error: "forbidden", message: "无权访问该录音" });
    }
    const filePath = resolve(join(env.DATA_DIR, "meeting-recordings", filename));
    // Defense in depth: ensure resolved path stays inside the
    // recordings dir even if the regex is bypassed somehow.
    const base = resolve(join(env.DATA_DIR, "meeting-recordings"));
    if (!filePath.startsWith(base + "/") || !existsSync(filePath)) {
      return reply.code(404).send({ error: "not_found", message: "录音文件已删除" });
    }
    const stat = statSync(filePath);
    reply.header("Content-Type", "audio/wav");
    // Playback (the <audio> element) uses inline; an explicit ?download=1 from
    // the "下载录音文件" link forces attachment with the MEETING TITLE as the
    // filename (was the opaque cuid). Title may be CJK → RFC 5987 filename*
    // carries the real name, with an ASCII filename= fallback for old clients.
    if (req.query.download) {
      const base = (row.title || "").trim() || "会议录音";
      const safe = [...base]
        .filter((ch) => ch >= " " && !'\\/:*?"<>|'.includes(ch))
        .join("").replace(/\s+/g, " ").trim().slice(0, 80) || "会议录音";
      const ascii = [...safe].filter((ch) => ch >= " " && ch <= "~").join("").trim() || "meeting";
      reply.header(
        "Content-Disposition",
        `attachment; filename="${ascii}.wav"; filename*=UTF-8''${encodeURIComponent(safe)}.wav`,
      );
    } else {
      reply.header("Content-Disposition", `inline; filename="${filename}"`);
    }
    reply.header("Accept-Ranges", "bytes");

    // Range request handling — the <audio> element relies on this
    // for seeking + for fetching only metadata (preload="metadata"
    // sends a `Range: bytes=0-N` head request, Safari especially
    // refuses to play if range requests aren't honored). We only
    // support single-range; multi-range is RFC-legal but no browser
    // audio client actually uses it.
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (!m) {
        reply.code(416);
        reply.header("Content-Range", `bytes */${stat.size}`);
        return reply.send();
      }
      const start = parseInt(m[1]!, 10);
      const end = m[2] ? parseInt(m[2]!, 10) : stat.size - 1;
      if (Number.isNaN(start) || start < 0 || end >= stat.size || start > end) {
        reply.code(416);
        reply.header("Content-Range", `bytes */${stat.size}`);
        return reply.send();
      }
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      reply.header("Content-Length", String(end - start + 1));
      return reply.send(createReadStream(filePath, { start, end }));
    }

    reply.header("Content-Length", String(stat.size));
    return reply.send(createReadStream(filePath));
  });

  // DELETE /api/meeting/:id/hard — soft-delete into the deleter's
  // recycle bin. (Path kept as /:id/hard so the existing frontend
  // "delete meeting" button keeps working; only the behavior changed
  // from hard-delete to soft-delete.) The regular DELETE above just
  // flips status="ended"; THIS endpoint removes the ended meeting from
  // the hub by moving it into the bin. Permanent removal (file unlink +
  // row delete) now happens from the bin via DELETE
  // /api/recycle-bin/meeting/:id, which calls the shared purgeMeeting
  // helper (see top of this module).
  //
  // Guards:
  //   - creator OR admin (canEditMeetingMeta) — was admin-only; a host
  //     may now bin their own meeting
  //   - meeting must already be in "ended" state — explicit force-end
  //     first via the regular DELETE; refusing to bin a live meeting
  //     avoids losing audio mid-recording
  app.delete<{ Params: { id: string } }>("/api/meeting/:id/hard", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_input", message: "无效的会议 id" });

    const row = await prisma.meetingSession.findUnique({ where: { id: params.data.id } });
    if (!row || row.deletedAt != null) return reply.code(404).send({ error: "not_found", message: "会议不存在或已删除" });
    // View gate first: a private meeting is creator-only, so a non-creator
    // (incl. an admin) gets 404 before the canEditMeetingMeta delete check.
    if (!canViewMeeting(user, row)) return reply.code(404).send({ error: "not_found", message: "会议不存在或已删除" });
    if (!canEditMeetingMeta(user, row)) {
      return reply.code(403).send({ error: "forbidden", message: "只有主持人或管理员可以删除会议" });
    }
    if (row.status !== "ended") {
      return reply.code(400).send({ error: "not_ended", message: "请先结束会议再删除" });
    }

    // Belt-and-suspenders cancel of any pending auto-end timer (the
    // meeting is already ended, but the timer map may still hold a
    // stale reference in edge cases).
    cancelAutoEnd(row.id);

    await prisma.meetingSession.update({
      where: { id: row.id },
      data: { deletedAt: new Date(), deletedById: user.id },
    });

    req.log.info(
      { event: "meeting.soft_deleted", id: row.id, by: user.id },
      "meeting moved to recycle bin",
    );
    return reply.code(204).send();
  });

  // GET /meeting-tts/:filename — serves the cached TTS mp3 files
  // written by VolcTtsProvider. Auth-gated (same logged-in-user
  // model as /meeting-recordings). The frontend `<audio src=>`
  // playback queue hits this URL for each assistant comment that has
  // a populated ttsAudioUrl. Files are named after the comment
  // id so the URL is naturally idempotent + safe to cache.
  app.get<{ Params: { filename: string } }>("/api/meeting-tts/:filename", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const filename = req.params.filename;
    // Strict regex: cuid-shaped id, optionally suffixed with `-<seq>` for
    // the per-sentence clips of a streamed assistant comment, + .mp3. Same
    // defense-in-depth pattern as /meeting-recordings.
    const m = /^([a-z0-9]+)(?:-(\d+))?\.mp3$/i.exec(filename);
    if (!m) {
      return reply.code(404).send({ error: "not_found", message: "文件不存在" });
    }
    const commentId = m[1]!;
    const isSentenceClip = m[2] != null;
    // For a per-sentence clip, bound the `seq` to a plausible range. A single
    // assistant comment streams at most a few dozen sentence clips, so a 4-digit
    // ceiling is far past any real value while rejecting a crafted
    // `<commentId>-999999999.mp3` from probing the fs with absurd seqs.
    // (Bounded scope: the clip's binding to its comment is otherwise enforced
    // structurally — the filename prefix IS the comment id, the session is
    // loaded + visibility-gated below, and disk reads stay inside the tts dir.)
    if (isSentenceClip) {
      const seq = Number(m[2]);
      if (!Number.isInteger(seq) || seq < 0 || seq > 9999) {
        return reply.code(404).send({ error: "not_found", message: "音频不存在" });
      }
    }
    // Authorize against the parent MeetingComment row. For the whole-comment
    // clip the row's ttsAudioUrl must point at this exact file. For a streamed
    // per-sentence clip the row's ttsAudioUrl is null (live TTS = the streamed
    // chunks, not a persisted url) — we authorize on row existence + the
    // meeting's visibility/role gate below, which is the same scope.
    const row = await prisma.meetingComment.findUnique({
      where: { id: commentId },
      select: {
        ttsAudioUrl: true,
        session: { select: { createdById: true, visibility: true, deletedAt: true } },
      },
    });
    if (!row || row.session.deletedAt != null) {
      return reply.code(404).send({ error: "not_found", message: "音频不存在" });
    }
    if (!isSentenceClip && row.ttsAudioUrl !== `/meeting-tts/${filename}`) {
      return reply.code(404).send({ error: "not_found", message: "音频不存在" });
    }
    // Same scope as /meeting-recordings — TTS echoes what assistant said about the
    // meeting, so it inherits the meeting's visibility gate. allowedRoleIds is
    // NOT consulted (assistant-retrieval scope only, never an access gate).
    if (!canViewMeeting(user, row.session)) {
      return reply.code(403).send({ error: "forbidden", message: "无权访问该音频" });
    }
    const filePath = resolve(join(env.DATA_DIR, "meeting-tts", filename));
    const base = resolve(join(env.DATA_DIR, "meeting-tts"));
    if (!filePath.startsWith(base + "/") || !existsSync(filePath)) {
      return reply.code(404).send({ error: "not_found", message: "音频文件已删除" });
    }
    const stat = statSync(filePath);
    reply.header("Content-Type", "audio/mpeg");
    reply.header("Content-Length", String(stat.size));
    reply.header("Content-Disposition", `inline; filename="${filename}"`);
    // TTS clips are short (<30s) — no range support needed for
    // the existing `new Audio()` playback path.
    return reply.send(createReadStream(filePath));
  });

  // GET /api/meeting/has-active — cheap polling endpoint for the
  // nav red dot. Returns {hasActive: boolean} via a single COUNT
  // query — no role lookups, no host displayName joins. The /hub
  // endpoint was overkill for the indicator and made ~130 req/min
  // at 100 idle users just for the badge.
  //
  // Visibility: the badge must only light up for meetings the caller can
  // actually open — otherwise a private meeting (now that those ship) would
  // flash the red dot for everyone while only its creator can join. Scoped
  // with the SAME `public OR mine` filter /hub uses, so badge ⇔ hub list.
  app.get("/api/meeting/has-active", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const visWhere = { OR: [{ visibility: "public" }, { createdById: user.id }] };
    const count = await prisma.meetingSession.count({ where: { status: "active", deletedAt: null, ...visWhere } });
    return { hasActive: count > 0 };
  });
}
