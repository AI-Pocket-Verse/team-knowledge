import Fastify, { type FastifyInstance, type FastifyReply, type FastifyBaseLogger } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { join, resolve } from "node:path";
import { STATUS_CODES } from "node:http";
import { mkdirSync, existsSync, renameSync, readdirSync, writeFileSync, createReadStream } from "node:fs";
import authPlugin from "@team-knowledge/auth-client-api";
import { env } from "./env.js";
import { meRoutes } from "./routes/me.js";
import { usersRoutes } from "./routes/users.js";
import { adminUserRoutes } from "./routes/admin-users.js";
import { adminDashboardRoutes } from "./routes/admin-dashboard.js";
import { adminAnalyticsRoutes } from "./routes/admin-analytics.js";
import { adminDashboardStreamRoutes } from "./routes/admin-dashboard-stream.js";
import { adminRoleRoutes } from "./routes/admin-roles.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { automationRoutes } from "./routes/automations.js";
import { folderRoutes } from "./routes/folders.js";
import { articleRoutes } from "./routes/articles.js";
import { feishuImportRoutes } from "./routes/feishu-import.js";
import { articleEditorRoutes } from "./routes/article-editors.js";
import { bookmarkRoutes } from "./routes/bookmarks.js";
import { uploadRoutes } from "./routes/uploads.js";
import { socialRoutes } from "./routes/social.js";
import { notificationRoutes } from "./routes/notifications.js";
import { roleSkillRoutes } from "./routes/role-skill.js";
import { chatRoutes } from "./routes/chat.js";
import { expertsRoutes } from "./routes/experts.js";
import { adminExpertsRoutes } from "./routes/admin-experts.js";
import { rolesRoutes } from "./routes/roles.js";
import { internalFeishuRoutes } from "./routes/internal-feishu.js";
import { internalDocAuditRoutes } from "./routes/internal-doc-audit.js";
import { adminAssistantNotifyRoutes } from "./routes/admin-assistant-notify.js";
import { adminSettingsRoutes } from "./routes/admin-settings.js";
import { adminGithubRoutes } from "./routes/admin-github.js";
import { adminNotifyTestRoutes } from "./routes/admin-notify-test.js";
import { adminGroupQaRoutes } from "./routes/admin-group-qa.js";
import { isAllowedOrigin } from "./utils/origin.js";
import { adminAssistantFilterRoutes } from "./routes/admin-assistant-filter.js";
import { adminArticleReviewRoutes } from "./routes/admin-article-review.js";
import { meetingRoutes } from "./routes/meeting.js";
import { meetingWsRoutes } from "./routes/meeting-ws.js";
import { recycleBinRoutes } from "./routes/recycle-bin.js";
import { adminBackupRoutes } from "./routes/admin-backup.js";
import { adminWeeklyReportRoutes } from "./routes/admin-weekly-report.js";
import { isRestoring } from "./services/backup.js";
import { requireUser } from "./utils/guards.js";
import { prisma } from "./db.js";
import { extractUploadFilenames } from "./utils/uploadBinding.js";
import {
  getArticlePermissions,
  getUserRoleIds,
  isArticleCollaborator,
  getEffectiveFolderPermissions,
} from "./utils/permissions.js";

export async function buildServer(
  opts: {
    logger?: FastifyBaseLogger | boolean;
    // SSO auth wiring for @team-knowledge/auth-client-api. Tests inject a
    // mocked fetchImpl + a throwaway whoamiUrl so whoami never hits the
    // network; the real server (index.ts) passes env.WHOAMI_URL.
    auth?: { whoamiUrl?: string; fetchImpl?: typeof fetch };
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    // Tests call buildServer() with no logger → quiet (VITEST). The real server
    // (index.ts) passes a platform pino logger (@team-knowledge/logger) INSTANCE.
    //
    // fastify 5:传 logger【实例】必须用 `loggerInstance`;`logger` 只接受
    // 布尔 / 配置对象,传实例会在构造时抛 FST_ERR_LOG_INVALID_LOGGER(v4 里
    // `logger: <实例>` 合法,v5 改名了)。故按类型分流。测试不传 → 走布尔分支。
    ...(opts.logger && typeof opts.logger === "object"
      ? { loggerInstance: opts.logger }
      : { logger: (opts.logger as boolean | undefined) ?? (process.env.VITEST ? false : true) }),
    trustProxy: env.TRUST_PROXY,
    // Article saves can be up to ~20MB of markdown (zod-enforced). JSON wrapping
    // + overhead means the HTTP body can be a few MB larger, so cap at 30MB.
    bodyLimit: 30 * 1024 * 1024,
  });

  // 统一的 5xx 处理：不把 Prisma/SQLite 等内部错误原文返回给用户，日志里保留完整错误。
  // 必须在注册任何路由之前设置——Fastify 子插件创建时就固定了错误处理器，后设的不会回溯。
  // 4xx 保持 Fastify 默认的响应形状。
  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err, url: req.url }, "unhandled error");
      return reply.code(status).send({ error: "internal_error", message: "服务器内部错误" });
    }
    return reply.code(status).send({ statusCode: status, error: STATUS_CODES[status] ?? "Error", message: e.message ?? "" });
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
  });

  // 本地单用户模式(未配置 WHOAMI_URL)没有登录，防 DNS 重绑定：攻击页面把自己的域名解析到
  // 127.0.0.1 后，浏览器带的 Origin 与 Host 都是攻击域名，下面的 CSRF 同源判断拦不住。
  // 所以只接受 localhost / 回环地址和 WEB_ORIGIN、WEB_PUBLIC_URL 里的主机名作为 Host。
  // 用原始 Host 头，不用可被 X-Forwarded-Host 改写的 req.host。
  if (!(opts.auth?.whoamiUrl ?? env.WHOAMI_URL)) {
    const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    for (const u of [env.WEB_ORIGIN, env.WEB_PUBLIC_URL]) {
      try { allowedHosts.add(new URL(u).hostname.toLowerCase()); } catch { /* 配置非法时忽略，由其他校验报错 */ }
    }
    app.addHook("onRequest", async (req, reply) => {
      const raw = (req.headers.host ?? "").toString().toLowerCase();
      const hostname = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0]!;
      if (!allowedHosts.has(hostname)) {
        return reply.code(421).send({
          error: "host_not_allowed",
          message: "本地模式只接受 localhost 或 WEB_ORIGIN / WEB_PUBLIC_URL 中配置的主机名访问",
        });
      }
    });
  }

  // Allowed browser-facing origins for state-changing requests. WEB_ORIGIN is
  // the same value @fastify/cors trusts (dev http://localhost:5030; prod the
  // public site origin). Behind a reverse proxy the upstream req.host is
  // 127.0.0.1:<port>, NOT the public origin the browser used — so we derive
  // the origin from the proxy's X-Forwarded-Host/Proto when present (nginx sets
  // these), falling back to req.host for direct (un-proxied) calls.
  // Trusting X-Forwarded-* is safe for CSRF here: a browser cannot attach
  // those headers to a cross-site request (they aren't CORS-safelisted, so a
  // forged value triggers a preflight the attacker can't satisfy), the
  // proxy overwrites them, and the origin port isn't publicly reachable.
  app.addHook("onRequest", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    // CSRF: cross-site form posts can't set a forged Origin header. If a
    // browser sent an Origin and it matches neither the configured WEB_ORIGIN
    // nor this request's own origin, it's cross-site — reject. Absent Origin
    // (non-browser clients, server-to-server, health probes) falls through to
    // the content-type checks below so we don't hard-reject legitimate traffic.
    const origin = (req.headers["origin"] ?? "").toString();
    if (origin) {
      if (!isAllowedOrigin(origin, req)) {
        return reply.code(403).send({ error: "csrf", message: "跨站请求被拒绝" });
      }
    }
    const ct = (req.headers["content-type"] ?? "").toString();
    // No content-type means no body — DELETE, logout-style POSTs, etc.
    // These cannot carry a CSRF form payload, so allow them through.
    if (ct === "") return;
    // Allow JSON fetch and multipart uploads. Pure form submissions (which is
    // what cross-site CSRF attacks can trigger from browsers) won't have either.
    if (ct.startsWith("application/json") || ct.startsWith("multipart/form-data")) return;
    // Raw bytes (octet-stream) are equally CSRF-safe: HTML forms can only emit
    // urlencoded/multipart/text-plain, and cross-site fetch with this type
    // triggers a CORS preflight. Used by the internal Feishu image relay.
    if (ct.startsWith("application/octet-stream")) return;
    // Custom XHR/fetch header also passes.
    if (req.headers["x-requested-with"]) return;
    reply.code(403).send({ error: "csrf", message: "Missing CSRF protection" });
  });

  // While a DB restore swaps the SQLite file underneath us, briefly reject
  // everything except the backup namespace + platform health probes so no write
  // lands mid-swap. The window is ~1s (see services/backup.ts restoreBackup).
  app.addHook("onRequest", async (req, reply) => {
    if (!isRestoring()) return;
    const url = req.url;
    if (url.startsWith("/api/admin/backup") || url.startsWith("/healthz") || url.startsWith("/readyz")) return;
    return reply.code(503).send({ error: "maintenance", message: "正在还原数据库，请稍候…" });
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    // 接口返回的都是因人而异的数据(文档、会话、通知)，不允许浏览器或中间代理缓存；
    // 路由自己设置过 Cache-Control 的(如 SSE)保持不变。
    if (req.url.startsWith("/api/") && !reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    reply.header("Referrer-Policy", "no-referrer");
  });

  // Platform SSO: validates the sso_session cookie against the whoami URL
  // and populates req.user (the Feishu-derived identity — no roles).
  // Registered AFTER cors and BEFORE the route registrations so every
  // route sees a populated (or null) req.user. team-knowledge's own
  // authorization (isAdmin / roles / ACL) lives in guards.ts + routes.
  await app.register(authPlugin, {
    whoamiUrl: opts.auth?.whoamiUrl ?? env.WHOAMI_URL,
    fetchImpl: opts.auth?.fetchImpl,
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
  });

  // Global multipart limit must be the MAX of any
  // route's accepted size — @fastify/multipart's per-request `limits`
  // override only narrows down, and the busboy stream still fires
  // 'limit' at the plugin-level fileSize. /api/uploads/file accepts up
  // to 30MB; the image route does its own tighter 20MB check after
  // `toBuffer` so this loosening doesn't widen the image surface.
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024 } });

  // @fastify/static requires an absolute path; resolve relative DATA_DIR
  // against the process cwd (api/ in dev).
  const uploadsDir = resolve(env.DATA_DIR, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  // One-time migration: prior versions wrote to ./uploads (process.cwd() relative).
  // If that dir exists but the new one is empty, move its contents so existing
  // image URLs keep resolving without manual intervention.
  const legacyUploadsDir = join(process.cwd(), "uploads");
  if (
    legacyUploadsDir !== uploadsDir &&
    existsSync(legacyUploadsDir) &&
    !existsSync(join(uploadsDir, ".migrated"))
  ) {
    try {
      for (const name of readdirSync(legacyUploadsDir)) {
        renameSync(join(legacyUploadsDir, name), join(uploadsDir, name));
      }
      writeFileSync(join(uploadsDir, ".migrated"), `from ${legacyUploadsDir}\n`);
      app.log.info?.(`[migration] moved uploads from ${legacyUploadsDir} → ${uploadsDir}`);
    } catch (err) {
      app.log.warn?.(`[migration] uploads move failed: ${(err as Error).message}`);
    }
  }
  // serve: false — don't auto-mount; we register a hand-written auth-gated route below.
  await app.register(fastifyStatic, {
    root: uploadsDir,
    serve: false,
    decorateReply: true,
  });

  // Browsers preview these inline; anything else gets
  // Content-Disposition: attachment with the original filename so
  // downloads keep the user's name rather than the storage hash.
  function isInlinePreview(mime: string | null): boolean {
    if (!mime) return false;
    // Only allowlist specific text subtypes — broad
    // text/* would let a user-supplied Content-Type of `text/html` be
    // served inline. CSP `script-src 'self'` + `X-Content-Type-Options:
    // nosniff` already block execution, but keeping the allowlist
    // narrow removes one defense-in-depth layer's load.
    return (
      mime.startsWith("image/") ||
      mime.startsWith("video/") ||
      mime.startsWith("audio/") ||
      mime === "text/plain" ||
      mime === "text/csv" ||
      mime === "application/pdf"
    );
  }

  // 文本类扩展名:点击附件时在新标签页「内联预览」为纯文本,而不是下载。
  // 这些是纯文本、无可靠 magic bytes,上传时多被存成 application/octet-stream,
  // 故这里按【扩展名】判定(老文件也覆盖),并强制以 text/plain 提供 ——
  // 浏览器对 text/plain 一律直接显示且【绝不执行】(叠加 nosniff + CSP),
  // 所以即便文件里是 HTML 源码也只当文本展示,无 XSS。刻意不含 html/svg。
  const TEXT_PREVIEW_EXT = new Set([
    "md", "markdown", "txt", "text", "log",
    "csv", "tsv", "json", "yaml", "yml", "xml",
    "ini", "conf", "toml",
  ]);

  function extOf(name: string): string {
    const m = /\.([a-z0-9]+)$/i.exec(name);
    return m ? m[1]!.toLowerCase() : "";
  }

  async function sendUpload(reply: FastifyReply, up: { filename: string; mimeType: string; originalName: string | null }) {
    // 文本类:强制 text/plain 内联展示(点开即在浏览器里可读)。自己流式发送而
    // 不用 sendFile,是为了不被 @fastify/static 依据扩展名(如 .md → text/markdown,
    // 浏览器会当未知类型下载)覆盖成会触发下载的 Content-Type。用 createReadStream
    // 流式,避免把整份文件(上限 30MB)读进内存;文件缺失则回 404(与主分支一致)。
    if (TEXT_PREVIEW_EXT.has(extOf(up.filename))) {
      const filePath = join(uploadsDir, up.filename);
      if (!existsSync(filePath)) {
        return reply.code(404).send({ error: "not_found", message: "文件不存在" });
      }
      return reply.type("text/plain; charset=utf-8").send(createReadStream(filePath));
    }
    // Content-Type 一律由服务端决定，不交给 sendFile 按扩展名推断：否则「图片魔数 + .shtml 扩展名」
    // 这类文件会以 text/html 内联返回，在本站同源执行脚本。内联预览用上传时按字节检测出的类型，
    // 其余一律 octet-stream + attachment。
    if (!isInlinePreview(up.mimeType)) {
      const fallback = up.filename.replace(/[^A-Za-z0-9._-]/g, "_");
      const utf8 = encodeURIComponent(up.originalName ?? up.filename);
      // RFC 5987: provide both filename= (ASCII fallback) and filename*= (UTF-8).
      reply.header("Content-Disposition", `attachment; filename="${fallback}"; filename*=UTF-8''${utf8}`);
      reply.type("application/octet-stream");
    } else {
      reply.type(up.mimeType);
    }
    // contentType:false = 不让 @fastify/send 按扩展名覆盖上面设置的类型。
    return reply.sendFile(up.filename, { contentType: false });
  }

  app.get<{ Params: { filename: string } }>("/uploads/:filename", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    // Safe filename: cuid stem + 1-8 char alphanumeric ext (any type).
    // The /api/uploads/file endpoint enforces a blocklist of executable
    // extensions before writing, so what we serve here is already vetted.
    if (!/^[a-z0-9]{20,32}\.[a-z0-9]{1,8}$/.test(req.params.filename)) {
      return reply.code(404).send({ error: "not_found", message: "文件不存在" });
    }
    // Permission gate: the upload row carries the owning user and (after
    // the file is embedded in an article) the article it belongs to.
    // Without a matching Upload row we treat the file as unknown —
    // legacy files predating this table will 404 for non-admins, which
    // is intentional.
    const up = await prisma.upload.findUnique({ where: { filename: req.params.filename } });
    if (!up) {
      if (user.isAdmin) return reply.sendFile(req.params.filename);
      return reply.code(404).send({ error: "not_found", message: "文件不存在" });
    }
    if (user.isAdmin || up.uploadedById === user.id) {
      return sendUpload(reply, up);
    }

    // 专家头像:任何登录成员都要能看到(专家选择栏、对话气泡),不论谁上传。
    // 只放行 RoleExpert.avatarUrl 精确指向该文件的情形。
    const avatarOwner = await prisma.roleExpert.findFirst({
      where: { avatarUrl: `/uploads/${up.filename}` },
      select: { roleId: true },
    });
    if (avatarOwner) return sendUpload(reply, up);

    const userRoleIds = await getUserRoleIds(user.id);
    // Does this user have canView on the given embedding article? Mirrors
    // the article detail gate: folder/role permission, with a per-article
    // collaborator override (collaborators can fetch an article's uploads
    // even when the folder role doesn't grant view).
    type ViewableArticle = { id: string; roleId: string; createdById: string | null; folder: { roleId: string; visibility: string } | null };
    async function canViewArticle(article: ViewableArticle): Promise<boolean> {
      const mp = getEffectiveFolderPermissions({
        user: { id: user!.id, isAdmin: user!.isAdmin },
        userRoleIds,
        article: { roleId: article.roleId, folder: article.folder },
      });
      const isCollaborator = await isArticleCollaborator(user!.id, article.id);
      const perms = getArticlePermissions({
        folderPermissions: mp,
        article: { createdById: article.createdById },
        userId: user!.id,
        isAdmin: user!.isAdmin,
        isCollaborator,
      });
      return perms.canView;
    }

    // Bound-article path: if the upload is bound to an article the viewer
    // can see, serve it. We DON'T 404 a missing/unviewable bound article
    // outright — fall through to the reference scan below, because the
    // bound article may have been permanently purged (FK SetNull blanked
    // articleId on a sibling) while another LIVE article still embeds the
    // image. The reference scan is what makes serving correct in that case.
    if (up.articleId) {
      const article = await prisma.article.findUnique({
        where: { id: up.articleId },
        select: { id: true, roleId: true, createdById: true, folder: { select: { roleId: true, visibility: true } } },
      });
      if (article && await canViewArticle(article)) {
        return sendUpload(reply, up);
      }
    }

    // Reference-aware fallback: serve the file if ANY live (deletedAt:null)
    // article that the viewer can access embeds this `/uploads/<filename>`
    // URL in its body. Covers (a) an upload whose first-bind article was
    // purged but is still embedded elsewhere, and (b) an as-yet-unbound
    // upload already embedded in a viewable published article. The
    // published-content body-permission model treats such uploads as
    // viewable to anyone who can read the embedding article.
    //
    // The SQL `contains` is only a cheap candidate pre-filter — it would
    // also match a doc that merely QUOTES the URL inside a ```code fence```.
    // "Referenced" MUST mean the same thing here as in uploadBinding /
    // uploadCleanup: a genuine embed, fences stripped. So we re-check each
    // candidate with extractUploadFilenames (which strips fenced + inline
    // code) and only treat it as a real reference if the filename survives.
    // Without this, a private upload could be served to anyone who can read
    // a published doc that merely fenced its URL.
    const liveArticles = await prisma.article.findMany({
      where: { deletedAt: null, contentMarkdown: { contains: `/uploads/${up.filename}` } },
      select: { id: true, roleId: true, createdById: true, contentMarkdown: true, folder: { select: { roleId: true, visibility: true } } },
    });
    for (const article of liveArticles) {
      if (!extractUploadFilenames(article.contentMarkdown).includes(up.filename)) continue;
      if (await canViewArticle(article)) {
        return sendUpload(reply, up);
      }
    }

    return reply.code(403).send({ error: "forbidden", message: "无权访问该文件" });
  });

  // Product probe (used by deploy/smoke.mjs). The platform /healthz + /readyz
  // come from @team-knowledge/api-kit, registered
  // in index.ts (real server only) so per-test buildServer() calls don't spin
  // up api-kit's pino-pretty transport.
  app.get("/api/health", async () => ({ ok: true }));

  // WebSocket plugin — used by the assistant meeting audio stream
  // (api/src/routes/meeting-ws.ts). Registered AFTER the auth plugin
  // so the upgrade handler's onRequest hook has already populated req.user
  // from the sso_session cookie. Lifts maxPayload above the 1 MiB default so
  // a brief network burp doesn't drop the connection on a chunky 500ms Opus blob.
  await app.register(fastifyWebsocket, { options: { maxPayload: 2 * 1024 * 1024 } });

  await app.register(meRoutes);
  await app.register(usersRoutes);
  await app.register(adminUserRoutes);
  await app.register(adminDashboardRoutes);
  await app.register(adminAnalyticsRoutes);
  await app.register(adminDashboardStreamRoutes);
  await app.register(adminRoleRoutes);
  await app.register(workspaceRoutes);
  await app.register(automationRoutes);
  await app.register(folderRoutes);
  await app.register(articleRoutes);
  await app.register(feishuImportRoutes);
  await app.register(articleEditorRoutes);
  await app.register(bookmarkRoutes);
  await app.register(uploadRoutes);
  await app.register(socialRoutes);
  await app.register(notificationRoutes);
  await app.register(roleSkillRoutes);
  await app.register(chatRoutes);
  await app.register(expertsRoutes);
  await app.register(adminExpertsRoutes);
  await app.register(rolesRoutes);
  await app.register(internalFeishuRoutes);
  await app.register(internalDocAuditRoutes);
  await app.register(adminAssistantNotifyRoutes);
  await app.register(adminSettingsRoutes);
  await app.register(adminGithubRoutes);
  await app.register(adminNotifyTestRoutes);
  await app.register(adminGroupQaRoutes);
  await app.register(adminAssistantFilterRoutes);
  await app.register(adminArticleReviewRoutes);
  await app.register(adminBackupRoutes);
  await app.register(adminWeeklyReportRoutes);
  await app.register(meetingRoutes);
  await app.register(meetingWsRoutes);
  await app.register(recycleBinRoutes);

  return app;
}
