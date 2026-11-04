// 内部接口(仅 feishu-sso 飞书边缘调用,x-internal-token 鉴权):接收一条飞书私聊
// 文本,映射 open_id→User,跑共享聊天内核 runChatTurn,以 SSE 流式返回答案。feishu-sso
// 侧负责把这条 SSE 节流刷成飞书卡片。team-knowledge 不碰飞书 SDK。
//
// 图片链路:feishu-sso 先把飞书消息里的图片字节 POST 到 /api/internal/feishu/image
// (octet-stream)落盘成 /uploads/<file>,再带着这些 URL 调 /chat —— 与网页端
// 上传后发消息完全同构,LLM 经 provider 视觉通道真实读图。
import { L } from "../utils/lang.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { internalTokenOk } from "../utils/internalToken.js";
import { isRestoring } from "../services/backup.js";
import { openSse, abortOnClientClose } from "../utils/sse.js";
import { runChatTurn, ChatBusyError } from "../services/chat/runChatTurn.js";
import { getOrCreateFeishuConversation } from "../services/chat/conversations.js";
import { runGroupChatTurn } from "../services/chat/runGroupChatTurn.js";
import { resolveUserByOpenId } from "../services/chat/resolveUserByOpenId.js";
import { isExclusiveBusy } from "../utils/concurrency.js";
import { storeImageBuffer, resolveChatImages, ImageStoreError, MAX_IMAGE_BYTES } from "../services/uploads/image-store.js";
import { observeGroupMessage } from "../services/group-qa/observe.js";
import { registerDownvote, registerUpvote } from "../services/group-qa/store.js";
import { prisma } from "../db.js";
import { resolveEscalation } from "../services/experts/escalation.js";
import { ASSISTANT_NAME } from "../utils/assistant.js";

// 专家升级单飞书卡片回流:feishu-sso 收到 card.action.trigger(value.kind=expert_escalation)后转发。
const escalationResolveSchema = z.object({
  escalationId: z.string().min(1).max(64),
  resolution: z.string().trim().min(1).max(2000),
  operatorOpenId: z.string().startsWith("ou_"),
});

// 群聊智能答疑:feishu-sso 转发群里「非 @ 文本消息」的载荷。
const observeSchema = z.object({
  chatId: z.string().startsWith("oc_"),
  messageId: z.string().startsWith("om_"),
  openId: z.string().startsWith("ou_"),
  senderName: z.string().max(64).default(""),
  text: z.string().max(4000).default(""),
});
const feedbackSchema = z.object({ hash: z.string().min(1).max(32), helpful: z.boolean().optional().default(false) });

const makeBodySchema = (req: FastifyRequest) => z.object({
  openId: z.string().startsWith("ou_"),
  // 带图时允许无文字(飞书纯图片消息没有 text)。
  text: z.string().max(4000).default(""),
  // p2p = 1:1 私聊(有状态,共享会话);group = 群里 @机器人(无状态,只用公开知识)。
  scope: z.enum(["p2p", "group"]).default("p2p"),
  // 先经 /api/internal/feishu/image 落盘得到的 /uploads/<file> 视图。
  images: z
    .array(z.string().regex(/^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/))
    .max(3)
    .optional(),
}).refine((v) => v.text.trim().length > 0 || (v.images?.length ?? 0) > 0, { message: L(req, "text 与 images 至少一项", "Provide at least one of text and images") });

export async function internalFeishuRoutes(app: FastifyInstance): Promise<void> {
  // 飞书入站图片落盘:feishu-sso 下载消息资源后把原始字节 POST 过来(octet-stream,
  // ≤20MB),按 openId 归属到对应 User(校验/配额/魔数与网页上传同一内核),
  // 返回 /uploads/<file> 视图供随后的 /chat 调用引用。
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_IMAGE_BYTES + 1024 }, (_req, body, done) => {
    done(null, body);
  });
  app.post("/api/internal/feishu/image", { bodyLimit: MAX_IMAGE_BYTES + 1024 }, async (req, reply) => {
    if (!internalTokenOk(req.headers["x-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (isRestoring()) {
      return reply.code(503).send({ error: "restoring", message: L(req, "维护中，请稍后再试", "Under maintenance. Try again later") });
    }
    const openId = req.headers["x-open-id"];
    if (typeof openId !== "string" || !openId.startsWith("ou_")) {
      return reply.code(400).send({ error: "invalid_input", message: L(req, "缺少 x-open-id", "Missing x-open-id") });
    }
    if (!Buffer.isBuffer(req.body)) {
      return reply.code(415).send({ error: "unsupported_media_type", message: L(req, "请以 application/octet-stream 上传图片字节", "Upload image bytes as application/octet-stream") });
    }
    const user = await resolveUserByOpenId(openId);
    if (!user) return reply.code(404).send({ error: "not_found", message: L(req, "非知识库成员", "Not a knowledge base member") });
    try {
      const stored = await storeImageBuffer(req.body, user.id);
      reply.code(201);
      return { url: stored.url, bytes: stored.bytes, mimeType: stored.mimeType };
    } catch (e) {
      if (e instanceof ImageStoreError) {
        const status = e.code === "unsupported_media_type" ? 415 : 413;
        return reply.code(status).send({ error: e.code, message: e.message });
      }
      throw e;
    }
  });

  app.post("/api/internal/feishu/chat", async (req, reply) => {
    if (!internalTokenOk(req.headers["x-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    // 还原热替换库期间不碰 DB(与维护期 503 一致)。
    if (isRestoring()) {
      return reply.code(503).send({ error: "restoring", message: L(req, "维护中，请稍后再试", "Under maintenance. Try again later") });
    }
    const parsed = makeBodySchema(req).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }

    const user = await resolveUserByOpenId(parsed.data.openId);
    if (!user) {
      // 非成员:一条 SSE，让 feishu-sso 桥用引导卡片回给用户(对应「仅已登录成员」)。
      const sse = openSse(reply);
      sse.send("need_login", { message: L(req, "你还没有知识库账号，请先用飞书登录网页版开通后再来私聊我～", "You do not have a knowledge base account yet. Sign in to the web app with Feishu first, then message me again~") });
      sse.send("done", { ok: true });
      sse.end();
      return;
    }

    const ac = new AbortController();
    abortOnClientClose(reply, ac);
    // 内部链路始终以 SSE 返回(feishu-sso 桥消费)。飞书不展示思考/引用,故只转发
    // token/done/error。
    const sse = openSse(reply);
    const onChunk = (c: { type: string; text?: string; message?: string }) => {
      if (c.type === "token") sse.send("token", { text: c.text });
      else if (c.type === "done") sse.send("done", { ok: true });
      else if (c.type === "error") sse.send("error", { message: c.message });
    };
    try {
      if (parsed.data.scope === "group") {
        // 群聊:无状态单轮,只用公开知识(runGroupChatTurn 不碰会话/历史/私有)。
        // 成员校验仍然走 resolveUserByOpenId(上面已 gate),但不按个人维度召回。
        // 图片在此解析为绝对路径(校验归属:必须是该 openId 用户刚落盘的上传)。
        let groupImages: string[] = [];
        if ((parsed.data.images?.length ?? 0) > 0) {
          try {
            groupImages = (await resolveChatImages(user.id, parsed.data.images!)).absPaths;
          } catch (e) {
            sse.send("error", { message: (e as Error).message });
            sse.end();
            return;
          }
        }
        await runGroupChatTurn({ text: parsed.data.text, images: groupImages, signal: ac.signal, log: req.log, onChunk });
      } else {
        // 排队提示:同一会话的上一轮(网页端或飞书端发起)还在生成时,这一轮
        // 会在会话锁上排队。先发 queued 事件让 feishu-sso 桥把「思考中」卡片换成
        // 排队文案;真正开始流式后卡片照常被 token 更新覆盖。
        const conv = await getOrCreateFeishuConversation(user.id);
        if (isExclusiveBusy(conv.id)) {
          sse.send("queued", { message: L(req, `上一条回答还在生成，已为你排队，${ASSISTANT_NAME} 会按顺序回答…`, `The previous answer is still being generated. You are queued and ${ASSISTANT_NAME} will answer in order...`) });
        }
        await runChatTurn({ user, conversationId: conv.id, text: parsed.data.text, images: parsed.data.images ?? [], scope: "feishu", signal: ac.signal, log: req.log, onChunk });
      }
    } catch (e) {
      // 唯一会抛出的是 ChatBusyError(信号量超时);SSE 已开,转成 error 事件。
      const message = e instanceof ChatBusyError ? e.message : (e as Error).message;
      sse.send("error", { message });
    }
    sse.end();
  });

  // 群聊智能答疑:feishu-sso 把群里「非 @ 文本消息」转发到这里。立即 200,实际「判定 + 作答 +
  // 引用回复」在 setImmediate 里跑(LLM 可能慢,不阻塞 feishu-sso 的 fire-and-forget 调用)。
  app.post("/api/internal/feishu/group-observe", async (req, reply) => {
    if (!internalTokenOk(req.headers["x-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (isRestoring()) return reply.code(503).send({ error: "restoring" });
    const parsed = observeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    const { chatId, messageId, openId, senderName, text } = parsed.data;
    const log = req.log;
    setImmediate(() => {
      void observeGroupMessage({ chatId, messageId, openId, senderName, text, now: Date.now(), log }).catch(() => { /* silent */ });
    });
    return reply.send({ ok: true });
  });

  // 群答疑反馈:helpful=true(👍)给统计 +1;否则(👎)记入反对降权集(TTL 内同问题不再答)。
  app.post("/api/internal/group-qa/feedback", async (req, reply) => {
    if (!internalTokenOk(req.headers["x-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    if (parsed.data.helpful) await registerUpvote(parsed.data.hash, Date.now());
    else await registerDownvote(parsed.data.hash, Date.now());
    return reply.send({ ok: true });
  });

  // 专家升级单回流:负责人在飞书卡片上点候选/回复 → feishu-sso 转发到这里拍板。
  // 授权:点按钮的人(operatorOpenId→User)必须是该升级单的 assignee 或管理员;否则 403(不改单)。
  // 幂等:resolveEscalation 仅 pending→resolved,重复点按钮无副作用。
  app.post("/api/internal/expert-escalation/resolve", async (req, reply) => {
    if (!internalTokenOk(req.headers["x-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (isRestoring()) return reply.code(503).send({ error: "restoring" });
    const parsed = escalationResolveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    }
    const user = await resolveUserByOpenId(parsed.data.operatorOpenId);
    if (!user) return reply.code(404).send({ error: "not_found", message: L(req, "非知识库成员", "Not a knowledge base member") });
    const esc = await prisma.escalation.findUnique({ where: { id: parsed.data.escalationId }, select: { assigneeUserId: true } });
    if (!esc) return reply.code(404).send({ error: "not_found", message: L(req, "升级单不存在", "Escalation not found") });
    if (!user.isAdmin && esc.assigneeUserId !== user.id) {
      return reply.code(403).send({ error: "forbidden", message: L(req, "只有该升级单的负责人可以拍板", "Only the owner of this escalation can decide") });
    }
    const resolved = await resolveEscalation(parsed.data.escalationId, { resolution: parsed.data.resolution, by: user.id });
    return reply.send({ id: resolved.id, status: resolved.status });
  });
}
