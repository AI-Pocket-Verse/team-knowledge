import { L, requestLang } from "../utils/lang.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../utils/guards.js";
import {
  getLlmProvider, setLlmProvider, codexAllowed,
  getVolcSttCreds, setVolcSttCreds,
  getVolcTtsCreds, setVolcTtsCreds,
  getLlmBinPaths, setLlmBinPath,
  getLlmModels, setLlmModel,
} from "../services/settings.js";
import { activeModel, envDefaultModel, isValidModelId } from "../services/llm/model-choice.js";
import { verifyCliBinary } from "../services/llm/verify-bin.js";
import { invalidateProviderCache, probeAll } from "../services/llm/registry.js";
import { getModelDisplayAdmin, setModelDisplayConfig } from "../services/llm/model-display.js";
import { getReviewSettings, setReviewSettings } from "../services/article-review/config.js";
import { getDocAuditTuning, setDocAuditTuning } from "../services/doc-audit/config.js";
import { getWebNotifySettings, setWebNotifySettings } from "../utils/notify/webNotifySettings.js";
import { ELIGIBLE_PAGES, eligiblePages, getVisibilityMap, setPageVisibility, requireAdminOrOpenPage } from "../services/admin-visibility/index.js";
import { maskSecret, isMaskedSecret } from "../services/volcAuth.js";
import { invalidateSttProviderCache } from "../services/stt/registry.js";
import { invalidateTtsProviderCache } from "../services/tts/registry.js";

const patchSchema = z.object({
  provider: z.enum(["claude", "codex"]),
});

// 鉴权二选一：apiKey(新版控制台)，或 appId + accessToken(旧版控制台)。
// 密钥字段：不传或回传 GET 返回的掩码(****xxxx) = 保持不变；传空串/null = 清除。
const secretField = z.string().nullable().optional();
const volcSttSchema = z.object({
  apiKey: secretField,
  appId: z.string().optional().nullable(),
  accessToken: secretField,
  endpoint: z.string().min(1).optional().nullable(),
  resourceId: z.string().min(1).optional().nullable(),
  model: z.string().min(1).optional().nullable(),
  boostingTableId: z.string().min(1).optional().nullable(),
});

const volcTtsSchema = z.object({
  apiKey: secretField,
  appId: z.string().optional().nullable(),
  accessToken: secretField,
  voice: z.string().min(1).optional().nullable(),
  endpoint: z.string().min(1).optional().nullable(),
});

// CLI 可执行文件路径。每个字段:undefined=不改动,null/空串=清除(回退 env/PATH),
// 非空字符串=设为该绝对路径(绝对路径校验在 handler 里做,便于给中文报错)。
const binPathSchema = z.object({
  claudePath: z.string().trim().max(512).optional().nullable(),
  codexPath: z.string().trim().max(512).optional().nullable(),
});

// 各引擎使用的模型 ID。每个字段:undefined=不改动,null/空串=清除(回退 .env / CLI 默认),
// 非空字符串=设为该模型(格式校验在 handler 里做,便于给中文报错)。
const llmModelSchema = z.object({
  claude: z.string().trim().max(100).optional().nullable(),
  codex: z.string().trim().max(100).optional().nullable(),
});

async function llmModelStatus() {
  const configured = await getLlmModels();
  return {
    ...configured,
    envDefault: { claude: envDefaultModel("claude"), codex: envDefaultModel("codex") },
    active: { claude: activeModel("claude") ?? null, codex: activeModel("codex") ?? null },
  };
}

// 对外显示的「模型型号」curated 三段(每 provider 一组)+ 群卡片显示开关。
const modelFieldsSchema = z.object({
  model: z.string().trim().max(60),
  version: z.string().trim().max(60),
  level: z.string().trim().max(60),
});
const modelDisplaySchema = z.object({
  claude: modelFieldsSchema.optional(),
  codex: modelFieldsSchema.optional(),
  showInGroupCard: z.boolean().optional(),
});

// 密钥字段的更新语义：undefined 或掩码 = 沿用旧值；空串/null = 清除；其他 = 新值。
function resolveSecret(incoming: string | null | undefined, previous: string | undefined): string | undefined {
  if (incoming === undefined) return previous;
  const v = incoming?.trim() ?? "";
  if (v === "") return undefined;
  if (isMaskedSecret(v)) return previous;
  return v;
}

export async function adminSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/settings/llm-provider", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });

    const current = await getLlmProvider();
    const available = await probeAll();
    return { current, available, codexAllowed: codexAllowed() };
  });

  app.patch("/api/admin/settings/llm-provider", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "无效的 provider", "Invalid provider") });
    }
    const target = parsed.data.provider;

    if (target === "codex" && !codexAllowed()) {
      return reply.code(409).send({
        error: "codex_not_allowed",
        message: L(req, "已启用登录的多人部署只能使用 claude 引擎：codex 带 shell 工具，无法限制它读取服务器文件。", "Multi-user deployments with login enabled can only use the claude engine: codex has shell tools and cannot be restricted from reading server files."),
      });
    }

    const probes = await probeAll();
    if (!probes[target].ok) {
      return reply.code(412).send({ error: "provider_unavailable", message: probes[target].reason ?? L(req, "目标 provider 不可用", "Target provider unavailable") });
    }

    await setLlmProvider(target, user.id);
    invalidateProviderCache();
    req.log.info(
      { event: "llm.provider_switched", to: target, by: user.id },
      "llm provider switched",
    );
    return { current: target, available: probes, codexAllowed: codexAllowed() };
  });

  // ─── 对外显示的模型型号(手填 curated + 探测核对)──────────
  // GET 返回每 provider 的三段 curated + 群卡片开关 + 「实际检测到」探测值。
  app.get("/api/admin/settings/model-display", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });
    return getModelDisplayAdmin();
  });

  app.put("/api/admin/settings/model-display", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });
    const parsed = modelDisplaySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    await setModelDisplayConfig(parsed.data, user.id);
    req.log.info({ event: "llm.model_display_updated", by: user.id }, "model display updated");
    return getModelDisplayAdmin();
  });

  // ─── LLM CLI 可执行文件路径(claude / codex)──────────
  // GET 返回当前配置的绝对路径(可为 null)+ 实时探测结果,UI 据此显示 ✓/✗。
  // PUT 写入/清除路径,写后立即重新探测,使红色 ✗ 在保存后即刻变绿。
  app.get("/api/admin/settings/llm-binaries", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });

    const paths = await getLlmBinPaths();
    const available = await probeAll();
    return { ...paths, available };
  });

  app.put("/api/admin/settings/llm-binaries", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });

    const parsed = binPathSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "无效的参数", "Invalid parameters") });
    }
    for (const which of ["claude", "codex"] as const) {
      const raw = which === "claude" ? parsed.data.claudePath : parsed.data.codexPath;
      if (raw === undefined) continue;          // 未提供该字段 → 保持不变
      const val = (raw ?? "").trim();
      if (val && !val.startsWith("/")) {
        return reply.code(400).send({ error: "invalid_input", message: L(req, `${which} 路径需为绝对路径（以 / 开头）`, `${which} path must be absolute (starting with /)`) });
      }
      if (val) {
        const check = await verifyCliBinary(which, val, requestLang(req));
        if (!check.ok) {
          req.log.warn({ event: "llm.binaries_rejected", which, path: val, by: user.id, reason: check.error }, "llm cli path rejected");
          return reply.code(400).send({ error: check.error, message: check.message });
        }
      }
    }
    for (const which of ["claude", "codex"] as const) {
      const raw = which === "claude" ? parsed.data.claudePath : parsed.data.codexPath;
      if (raw === undefined) continue;
      await setLlmBinPath(which, raw?.trim() || null, user.id);  // 空串 → 清除
    }
    invalidateProviderCache();
    req.log.info({ event: "llm.binaries_updated", by: user.id }, "llm cli binaries updated");
    const paths = await getLlmBinPaths();
    const available = await probeAll();
    return { ...paths, available };
  });

  // ─── 各引擎使用的模型(claude / codex)──────────
  // GET 返回后台设置值、.env 默认值与当前生效值;PUT 写入/清除，对新发起的调用立即生效。
  app.get("/api/admin/settings/llm-models", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });
    return llmModelStatus();
  });

  app.put("/api/admin/settings/llm-models", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });

    const parsed = llmModelSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "无效的参数", "Invalid parameters") });
    }
    // 先整体校验再写入，避免一个字段写成功、另一个字段报错的半截状态。
    for (const which of ["claude", "codex"] as const) {
      const val = parsed.data[which]?.trim();
      if (val && !isValidModelId(val)) {
        return reply.code(400).send({
          error: "invalid_model_id",
          message: L(
            req,
            `${which === "claude" ? "Claude Code" : "Codex"} 模型 ID 只能包含字母、数字和 . _ - : / [ ]，且以字母或数字开头`,
            `${which === "claude" ? "Claude Code" : "Codex"} model ID may only contain letters, digits and . _ - : / [ ], and must start with a letter or digit`,
          ),
        });
      }
    }
    for (const which of ["claude", "codex"] as const) {
      const raw = parsed.data[which];
      if (raw === undefined) continue;          // 未提供该字段 → 保持不变
      await setLlmModel(which, raw?.trim() || null, user.id);  // 空串 → 清除
    }
    req.log.info({ event: "llm.models_updated", by: user.id, ...(await getLlmModels()) }, "llm models updated");
    return llmModelStatus();
  });

  // ─── 火山 STT credentials ────────────────────────
  // GET returns whether creds are configured + a masked echo of
  // the accessToken so the admin can verify which key is active
  // without exposing the secret. PUT writes/updates the DB row,
  // DELETE clears it (the env vars become the fallback again).
  app.get("/api/admin/settings/volc-stt", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });

    const creds = await getVolcSttCreds();
    return {
      configured: !!creds,
      appId: creds?.appId ?? null,
      accessToken: maskSecret(creds?.accessToken),
      apiKey: maskSecret(creds?.apiKey),
      endpoint: creds?.endpoint ?? null,
      resourceId: creds?.resourceId ?? null,
      model: creds?.model ?? null,
      boostingTableId: creds?.boostingTableId ?? null,
    };
  });

  app.put("/api/admin/settings/volc-stt", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });

    const parsed = volcSttSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "无效的参数", "Invalid parameters") });
    }
    const prevStt = await getVolcSttCreds();
    const nextStt = {
      appId: parsed.data.appId?.trim() || undefined,
      accessToken: resolveSecret(parsed.data.accessToken, prevStt?.accessToken),
      apiKey: resolveSecret(parsed.data.apiKey, prevStt?.apiKey),
    };
    if (!nextStt.apiKey && (!nextStt.appId || !nextStt.accessToken)) {
      return reply.code(400).send({ error: "invalid_input", message: L(req, "请填写 API Key，或同时填写 App ID 与 Access Token", "Enter an API Key, or both App ID and Access Token") });
    }
    await setVolcSttCreds({
      ...nextStt,
      endpoint: parsed.data.endpoint ?? undefined,
      resourceId: parsed.data.resourceId ?? undefined,
      model: parsed.data.model ?? undefined,
      boostingTableId: parsed.data.boostingTableId ?? undefined,
    }, user.id);
    invalidateSttProviderCache();
    req.log.info({ event: "volc.stt.creds_updated", by: user.id }, "volc stt creds updated");
    return { ok: true };
  });

  app.delete("/api/admin/settings/volc-stt", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });
    await setVolcSttCreds(null, user.id);
    invalidateSttProviderCache();
    req.log.info({ event: "volc.stt.creds_cleared", by: user.id }, "volc stt creds cleared");
    return { ok: true };
  });

  // ─── 火山 TTS credentials ────────────────────────
  app.get("/api/admin/settings/volc-tts", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });

    const creds = await getVolcTtsCreds();
    return {
      configured: !!creds,
      appId: creds?.appId ?? null,
      accessToken: maskSecret(creds?.accessToken),
      apiKey: maskSecret(creds?.apiKey),
      voice: creds?.voice ?? null,
      endpoint: creds?.endpoint ?? null,
    };
  });

  app.put("/api/admin/settings/volc-tts", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });

    const parsed = volcTtsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "无效的参数", "Invalid parameters") });
    }
    const prevTts = await getVolcTtsCreds();
    const nextTts = {
      appId: parsed.data.appId?.trim() || undefined,
      accessToken: resolveSecret(parsed.data.accessToken, prevTts?.accessToken),
      apiKey: resolveSecret(parsed.data.apiKey, prevTts?.apiKey),
    };
    if (!nextTts.apiKey && (!nextTts.appId || !nextTts.accessToken)) {
      return reply.code(400).send({ error: "invalid_input", message: L(req, "请填写 API Key，或同时填写 App ID 与 Access Token", "Enter an API Key, or both App ID and Access Token") });
    }
    await setVolcTtsCreds({
      ...nextTts,
      voice: parsed.data.voice ?? undefined,
      endpoint: parsed.data.endpoint ?? undefined,
    }, user.id);
    invalidateTtsProviderCache();
    req.log.info({ event: "volc.tts.creds_updated", by: user.id }, "volc tts creds updated");
    return { ok: true };
  });

  app.delete("/api/admin/settings/volc-tts", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });
    await setVolcTtsCreds(null, user.id);
    invalidateTtsProviderCache();
    req.log.info({ event: "volc.tts.creds_cleared", by: user.id }, "volc tts creds cleared");
    return { ok: true };
  });

  // ─── 单篇 AI 入库前置校验(article-review)运行参数 ───────────
  // 总开关 + 扫描间隔(秒)+ 静置阈值(分钟)。数值越界由 service 层夹紧。
  app.get("/api/admin/settings/article-review", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });
    return getReviewSettings();
  });

  app.patch("/api/admin/settings/article-review", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });
    const parsed = z.object({
      enabled: z.boolean().optional(),
      scanIntervalSec: z.number().int().optional(),
      idleMinutes: z.number().int().optional(),
      minSeverity: z.enum(["low", "med", "high"]).optional(),
      reminderEnabled: z.boolean().optional(),
      reminderHour: z.number().int().optional(),
      reminderMinute: z.number().int().optional(),
      reminderWeekdays: z.array(z.number().int()).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    const next = await setReviewSettings(parsed.data, user.id);
    req.log.info({ event: "article_review.settings_updated", ...next, by: user.id }, "article-review settings updated");
    return next;
  });

  // ─── 知识库「文档体检」(doc-audit)检测参数(仅管理员)──────────
  // 检测强度评级(1-10)+ 每种类型最多显示条数(≥1,无硬上限)。越界由 service 层夹紧。
  app.get("/api/admin/settings/doc-audit-tuning", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });
    return getDocAuditTuning();
  });

  app.put("/api/admin/settings/doc-audit-tuning", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });
    const parsed = z.object({
      strength: z.number().int().min(1).max(10).optional(),
      maxPerCategory: z.number().int().min(1).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    const next = await setDocAuditTuning(parsed.data, user.id);
    req.log.info({ event: "doc_audit.tuning_updated", ...next, by: user.id }, "doc-audit tuning updated");
    return next;
  });

  // ─── Web(浏览器桌面)通知全局开关(仅管理员)──────────────────
  // 三类「事件完成」通知(自动化 / 会议纪要 /助手生图)的组织级总开关。每用户的
  // 接收/静音 + 浏览器授权是另一层(见 /api/notifications/prefs)。
  app.get("/api/admin/settings/web-notify", async (req, reply) => {
    // 「Web 通知」页可在「页面可见性」放开给所有成员;放开后成员也能读该配置。
    const user = await requireAdminOrOpenPage(req, reply, "web-notify");
    if (!user) return;
    return getWebNotifySettings();
  });

  // 全站总开关：页面放开给成员后成员只能查看，修改仍只有管理员能做。
  app.patch("/api/admin/settings/web-notify", async (req, reply) => {
    const user = await requireAdminOrOpenPage(req, reply, "web-notify");
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "admin_only", message: L(req, "仅管理员可用", "Admins only") });
    const parsed = z.object({
      enabled: z.boolean().optional(),
      automation: z.boolean().optional(),
      meeting: z.boolean().optional(),
      image: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    const next = await setWebNotifySettings(parsed.data, user.id);
    req.log.info({ event: "web_notify.settings_updated", ...next, by: user.id }, "web-notify settings updated");
    return next;
  });

  // ─── 管理后台页面可见性(仅管理员)──────────────────────────
  app.get("/api/admin/page-visibility", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });
    const map = await getVisibilityMap();
    return { pages: eligiblePages(requestLang(req)).map((p) => ({ key: p.key, label: p.label, visibility: map[p.key] })) };
  });

  app.patch("/api/admin/page-visibility", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: "forbidden", message: L(req, "仅管理员可用", "Admins only") });
    const parsed = z.object({
      // key 白名单从 ELIGIBLE_PAGES 派生,避免新增可配置页时忘了同步这里(web-notify 就漏过)。
      key: z.enum(ELIGIBLE_PAGES.map((p) => p.key) as [string, ...string[]]),
      visibility: z.enum(["admin", "all"]),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: L(req, "参数错误(key 必须是可配置页面)", "Invalid parameters (key must be a configurable page)") });
    const map = await setPageVisibility(parsed.data.key, parsed.data.visibility, user.id);
    req.log.info({ event: "admin.page_visibility_updated", ...parsed.data, by: user.id }, "page visibility updated");
    return { pages: eligiblePages(requestLang(req)).map((p) => ({ key: p.key, label: p.label, visibility: map[p.key] })) };
  });
}
