// POST /api/articles/import-feishu — import a Feishu docx/wiki document as a
// new article. Orchestrates: URL parse → (wiki→docx resolve) → fetch
// meta+blocks via the feishu-sso gateway → normalize → convert (md+html, with the
// unsupported-mode toggle) → rehost images → create the article (same path as
// the .md import). The Feishu SDK / token stays in feishu-sso; this route only
// talks to the gateway over HTTP, forwarding the user's sso_session cookie.
import { L, requestLang } from "../utils/lang.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import { getUserRoleIds } from "../utils/permissions.js";
import { syncArticleLinks } from "../utils/articleLinks.js";
import { markRoleSkillStale } from "../services/role-skill/stale.js";
import { uniqueArticleId } from "../utils/shortId.js";
import { parseFeishuUrl } from "../utils/feishuUrl.js";
import { normalizeBlocks } from "../utils/feishuNormalize.js";
import { convertDoc, buildGfmTable } from "../utils/feishuDoc.js";
import { bitableToRows, sheetToRows, extractMermaid } from "../utils/feishuEmbedTable.js";
import { storeImageBuffer, storeFileBuffer } from "../utils/storeImage.js";
import { feishuGateway, FeishuGatewayError } from "../utils/feishuGateway.js";

const bodySchema = z.object({
  roleId: z.string().min(1),
  folderId: z.string().min(1).nullable(),
  url: z.string().min(1),
  unsupportedMode: z.enum(["placeholder", "drop"]),
});

const UNTITLED = "未命名文档";
// Cap rows when rendering a bitable as a static GFM table — a doc with a huge
// linked base shouldn't pull thousands of rows into the markdown.
const MAX_TABLE_ROWS = 200;
// Per-import resource budget — a doc with hundreds of embeds/images must not
// fan out into hundreds of downloads. Excess degrade to placeholders + warnings.
const MAX_IMPORT_IMAGES = 100;
const MAX_IMPORT_EMBEDS = 50;
const MAX_IMPORT_BYTES = 100 * 1024 * 1024; // 100 MB total rehosted per import

export async function feishuImportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/articles/import-feishu", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    const { roleId, folderId, url, unsupportedMode } = parsed.data;

    const link = parseFeishuUrl(url);
    if (!link) return reply.code(400).send({ error: "invalid_input", message: L(req, "仅支持飞书 docx / wiki 文档链接", "Only Feishu docx / wiki document links are supported") });

    // Target permission — identical to create / import-md.
    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) return reply.code(404).send({ error: "not_found", message: L(req, "角色不存在", "Role not found") });
    if (folderId) {
      const fold = await prisma.folder.findUnique({ where: { id: folderId } });
      if (!fold || fold.deletedAt != null) return reply.code(404).send({ error: "not_found", message: L(req, "目录不存在", "Folder not found") });
      if (fold.roleId !== roleId) return reply.code(400).send({ error: "invalid_input", message: L(req, "目录不属于指定角色", "The folder does not belong to the specified role") });
    }
    const userRoleIds = await getUserRoleIds(user.id);
    if (!(user.isAdmin || userRoleIds.has(roleId))) {
      return reply.code(403).send({ error: "forbidden", message: L(req, "无权在该角色下创建文档", "No permission to create documents under this role") });
    }

    const cookie = req.headers.cookie ?? "";
    try {
      // wiki link → resolve to its underlying docx.
      let documentId = link.token;
      if (link.kind === "wiki") {
        const node = await feishuGateway.resolveWikiNode(cookie, link.token);
        if (node.objType !== "docx") {
          return reply.code(400).send({ error: "invalid_input", message: L(req, `暂不支持该 wiki 节点类型(${node.objType || "未知"})`, `Unsupported wiki node type (${node.objType || "unknown"})`) });
        }
        documentId = node.objToken;
      }

      const [meta, blocksRes] = await Promise.all([
        feishuGateway.getDocxMeta(cookie, documentId),
        feishuGateway.listDocxBlocks(cookie, documentId),
      ]);

      const nodes = normalizeBlocks(blocksRes.blocks, requestLang(req));
      // Per-import budget (closed over by the resolvers). Exceeding any cap
      // returns null → the converter degrades that block to a placeholder +
      // warning, so the cap is never silent.
      const budget = { images: 0, embeds: 0, bytes: 0 };
      const overBudget = () => budget.bytes >= MAX_IMPORT_BYTES;
      const { markdown, report } = await convertDoc(nodes, {
        lang: requestLang(req),
        unsupportedMode,
        sourceUrl: url,
        resolveImage: async (fileToken) => {
          if (++budget.images > MAX_IMPORT_IMAGES || overBudget()) return null;
          try {
            const { bytes } = await feishuGateway.downloadMedia(cookie, fileToken);
            budget.bytes += bytes.length;
            return await storeImageBuffer(user.id, bytes);
          } catch {
            return null;
          }
        },
        resolveEmbed: async (embed) => {
          if (++budget.embeds > MAX_IMPORT_EMBEDS) return null;
          try {
            // 画板 → 优先提取 mermaid 源码(可编辑、可渲染);否则渲染成图片落本地
            if (embed.kind === "whiteboard") {
              try {
                const { nodes } = await feishuGateway.getWhiteboardNodes(cookie, embed.token);
                const mermaid = extractMermaid(nodes);
                if (mermaid) return "```mermaid\n" + mermaid + "\n```";
              } catch {
                // 取节点失败 → 退回图片
              }
              if (overBudget()) return null;
              const { bytes } = await feishuGateway.downloadWhiteboardImage(cookie, embed.token);
              budget.bytes += bytes.length;
              const u = await storeImageBuffer(user.id, bytes);
              return u ? L(req, `![白板](${u})`, `![Whiteboard](${u})`) : null;
            }
            // 文件附件 → 下载并落本地 uploads,渲染成链接
            if (embed.kind === "file") {
              if (overBudget()) return null;
              const { bytes } = await feishuGateway.downloadMedia(cookie, embed.token);
              budget.bytes += bytes.length;
              const u = await storeFileBuffer(user.id, bytes, embed.name);
              return u ? `[📎 ${embed.name}](${u})` : null;
            }
            // 多维表格 → 读字段+记录 → GFM 表格(行数封顶,超出加提示)
            if (embed.kind === "bitable") {
              const [fields, recs] = await Promise.all([
                feishuGateway.listBitableFields(cookie, embed.appToken, embed.tableId),
                feishuGateway.listBitableRecords(cookie, embed.appToken, embed.tableId),
              ]);
              if (!fields.fields.length) return null;
              const { rows, truncated } = bitableToRows(fields.fields, recs.records, MAX_TABLE_ROWS);
              let md = buildGfmTable(rows);
              if (truncated) md += L(req, `\n\n> 📌 多维表格记录较多,仅展示部分(顺序可能与原表不同) · [查看原表](${url})`, `\n\n> 📌 This Base table has many records; only some are shown (order may differ from the original) · [View original](${url})`);
              return md;
            }
            // 电子表格 → 读区域 → GFM 表格
            if (embed.kind === "sheet") {
              const { values } = await feishuGateway.readSheetRange(cookie, embed.sheetToken, embed.sheetId);
              const rows = sheetToRows(values);
              if (!rows.length) return null;
              let md = buildGfmTable(rows);
              // readSheetRange caps at A1:Z200 — flag possible truncation.
              if (rows.length >= 200 || rows.some((r) => r.length >= 26)) {
                md += L(req, `\n\n> 📌 电子表格内容较大,可能仅展示部分 · [查看原文](${url})`, `\n\n> 📌 This spreadsheet is large; only part may be shown · [View original](${url})`);
              }
              return md;
            }
            return null;
          } catch (e) {
            // A dead token / app-scope-disabled must fail the whole import
            // loudly (proper 401/403) — not silently degrade every embed to a
            // placeholder, which would look like a successful-but-empty import.
            if (e instanceof FeishuGatewayError && (e.code === "need_relogin" || e.code === "feishu_scope_disabled")) {
              throw e;
            }
            return null;
          }
        },
      });
      const title = (meta.title?.trim() || UNTITLED).slice(0, 255);

      const sortAgg = await prisma.article.aggregate({
        where: folderId ? { folderId } : { folderId: null, roleId },
        _max: { sortOrder: true },
      });
      const newId = await uniqueArticleId();
      const created = await prisma.$transaction(async (tx) => {
        const c = await tx.article.create({
          data: {
            id: newId,
            title,
            contentMarkdown: markdown,
            roleId,
            folderId,
            sortOrder: (sortAgg._max.sortOrder ?? 0) + 1,
            createdById: user.id,
          },
          select: { id: true, title: true, folderId: true, roleId: true, sortOrder: true, createdAt: true, updatedAt: true },
        });
        await syncArticleLinks(tx, c.id, markdown);
        return c;
      });
      markRoleSkillStale(roleId);

      reply.code(201);
      return {
        article: { ...created, createdAt: created.createdAt.toISOString(), updatedAt: created.updatedAt.toISOString() },
        report,
      };
    } catch (e) {
      if (e instanceof FeishuGatewayError) {
        if (e.code === "feishu_scope_disabled")
          return reply.code(403).send({
            error: "feishu_scope_disabled",
            message: L(req, "飞书应用尚未开通所需文档权限(或版本未发布生效)。请在飞书开放平台为应用开通并发布 docx / wiki / drive 读取权限后重试。", "The Feishu app lacks the required document permissions (or the version is not published). Enable and publish docx / wiki / drive read permissions on the Feishu Open Platform, then try again."),
          });
        if (e.code === "feishu_permission")
          return reply.code(403).send({ error: "feishu_permission", message: L(req, "你没有该飞书文档的查看权限(或该文档不在应用所属企业内)。", "You do not have permission to view this Feishu document (or it is outside the app's organization).") });
        if (e.code === "feishu_need_reauth")
          return reply.code(403).send({ error: "feishu_need_reauth", message: L(req, "飞书授权未包含文档读取权限,请退出后重新登录并在授权页同意云文档权限。", "Your Feishu authorization does not include document read access. Sign out, sign in again and grant the Docs permission on the consent page.") });
        if (e.code === "need_relogin")
          return reply.code(401).send({ error: "need_relogin", message: L(req, "飞书登录已过期,请重新登录", "Your Feishu session has expired. Sign in again") });
        return reply.code(502).send({ error: "feishu_upstream", message: L(req, "拉取飞书文档失败,请稍后再试", "Failed to fetch the Feishu document. Try again later") });
      }
      app.log.error({ err: e }, "feishu import failed");
      return reply.code(500).send({ error: "internal", message: L(req, "导入失败", "Import failed") });
    }
  });
}
