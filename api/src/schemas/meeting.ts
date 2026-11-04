import { z } from "zod";

// Knobs the admin sets at create time + can tweak live. Stored
// as a JSON string on MeetingSession.config so adding a field here
// doesn't require a schema migration. Defaults are the product's
// chosen defaults.
export const meetingConfigSchema = z.object({
  /** Speak assistant's comments through the host's device speaker. */
  tts: z.boolean().default(true),
  /** Save the host's mic audio to OSS for post-meeting playback. */
  recording: z.boolean().default(true),
  /** Sliding-window throttle: at most `freqLimitMessages` natural-
   *  trigger comments per `freqLimitMinutes` minutes. Explicit wake /
   *  manual button / user question always bypass. Default 1/5 keeps
   *  the original "one comment per 5 minutes" behavior; the create
   *  form's wheel UI lets admins relax to e.g. 3 per 10 min. */
  freqLimitMinutes: z.number().int().min(1).max(60).default(5),
  freqLimitMessages: z.number().int().min(1).max(10).default(1),
  /** Wake up assistant when discussion stalls 12s+ on an open question. */
  triggerSilence: z.boolean().default(true),
  /** Trigger on "我们以前/上次..." style references. */
  triggerKeyword: z.boolean().default(true),
  /** Proactively comment once enough NEW discussion accrues since
   *  assistant's last chime (≥6 new finals OR ≥45s of speech), grounded
   *  in the KB. Has its own ≥60s cadence independent of the keyword/
   *  silence throttle. Defaults ON so assistant participates in a normal
   *  meeting without anyone pressing a button. */
  triggerProactive: z.boolean().default(true),
  /** Soft cap in hours. UI prompts host to renew at this point. */
  durationHintHours: z.number().int().min(1).max(12).default(4),
  /** Voice/wording style for assistant's chimes. */
  style: z.enum(["neutral", "concise", "verbose"]).default("neutral"),
});

export type MeetingConfigInput = z.infer<typeof meetingConfigSchema>;

export const meetingCreateSchema = z.object({
  // Title is required + bounded. The summary article's title (if the
  // admin opts to archive it) reuses this value, so keep it
  // markdown-safe; we don't sanitize aggressively here, just trim.
  title: z.string().trim().min(1, "请填写会议主题").max(120, "主题最多 120 字"),
  // Optional assistant retrieval scope. EMPTY (default) = no role narrowing →
  // assistant retrieves only public docs (still intersected with the asker's
  // permissions). Non-empty = scope to docs in these roles. Open creation to
  // role-less users means we can no longer require ≥1 role.
  allowedRoleIds: z
    .array(z.string().min(1))
    .max(20, "最多关联 20 个角色")
    .default([]),
  // Audience scope. Defaults to public (org-wide, read-only join).
  visibility: z.enum(["public", "private"]).default("public"),
  config: meetingConfigSchema,
});

export type MeetingCreateInput = z.infer<typeof meetingCreateSchema>;

// PATCH /api/meeting/:id — change visibility and/or title after creation
// (including after the meeting has ended). All fields optional; the route
// rejects a body with no updatable field.
export const meetingUpdateSchema = z.object({
  title: z.string().trim().min(1, "请填写会议主题").max(120, "主题最多 120 字").optional(),
  visibility: z.enum(["public", "private"]).optional(),
});

export type MeetingUpdateInput = z.infer<typeof meetingUpdateSchema>;
