// 专家地基:对话/列表/升级回流的 HTTP 接口。
//   GET  /api/agents                         专家列表(浏览页 / @ 选择)
//   POST /api/agents/chat                     发问 → 编排(分诊/多专家/汇总)→ 落库 → 返回答案+trace
//   POST /api/agents/escalations/:id/resolve  站内回流(负责人在待办里拍板)
//   GET  /api/me/escalations                  我作为负责人的待办升级单
// 注:编排非流式(orchestrate 全程 await),故 chat 走 JSON(非 SSE);token 级流式留作后续细化。
import { L } from "../utils/lang.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../utils/guards.js";
import { getUserRoleIds } from "../utils/permissions.js";
import { getExpertsByRoleIds } from "../services/experts/config.js";
import { orchestrate, callGeneralLlm } from "../services/experts/orchestrator.js";
import { callExpertLlm } from "../services/experts/expert.js";
import { generateImages } from "../services/llm/image-gen.js";
import { resolveEscalation, forwardEscalation } from "../services/experts/escalation.js";
import { resolveMentions, loadActiveArticle, trimConversation } from "../services/chat/runChatTurn.js";
import { createConversation, getOwnedConversation, touchConversation, deriveTitle } from "../services/chat/conversations.js";
import { maybeRefreshSummary } from "../services/chat/summarize.js";
import { publishChatUpdate } from "../services/chat/chat-events.js";
import { emitSelfNotification } from "../utils/notify/self.js";
import { resolveChatImages } from "../services/uploads/image-store.js";
import { runExclusive } from "../utils/concurrency.js";
import { openSse } from "../utils/sse.js";
import { ASSISTANT_NAME } from "../utils/assistant.js";

// 通用 LLM 调用(分诊用):走 claude,不放开联网工具。
const genericLlm = (sys: string, user: string) => callExpertLlm(sys, user, { webTools: false });
// 汇总:同上,但透传 onToken 以支持打字机流式。
const summaryLlm = (sys: string, user: string, onToken?: (t: string) => void) =>
  callExpertLlm(sys, user, { webTools: false }, onToken ? { onToken } : undefined);

export async function expertsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/agents", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const roles = await prisma.role.findMany({ select: { id: true, name: true, color: true }, orderBy: { name: "asc" } });
    const cfgs = await getExpertsByRoleIds(roles.map((r) => r.id)); // 批量,避免按角色 N+1
    const myRoleIds = user.isAdmin ? null : await getUserRoleIds(user.id); // canEdit:管理员或本角色成员
    const experts: Array<{ roleId: string; name: string; color: string | null; instruction: string; avatarUrl: string | null; webSearch: boolean; canEdit: boolean }> = [];
    for (const r of roles) {
      const cfg = cfgs.get(r.id)!;
      if (!cfg.enabled) continue;
      experts.push({ roleId: r.id, name: r.name, color: r.color, instruction: cfg.instruction.slice(0, 160), avatarUrl: cfg.avatarUrl, webSearch: cfg.sources.webSearch, canEdit: user.isAdmin || !!myRoleIds?.has(r.id) });
    }
    return { experts };
  });

  // SSE 流式:过程事件(event: step)+ 打字机(event: token)实时推送,最后 event: done 给权威结果
  //(answer/trace/citations/conversationId/escalationId)。前端用 token 做预览、done.answer 为终稿。
  // 限流:专家对话比普通聊天更重(分诊 + 多专家并行 + 汇总 + 可能的请教/定稿),给更紧的每用户配额,
  // 防单用户打满 LLM 并发(chatSemaphore)拖垮全站。镜像 /api/chat/message 的做法,配额更小。
  app.post("/api/agents/chat", {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
        keyGenerator: (req: { user?: { id?: string } | null; ip: string }) => req.user?.id ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = z.object({
      // 文字可空 —— 允许「只发图片」;但「空文字 + 无图」仍拒(见 refine)。
      message: z.string().trim().max(4000).optional(),
      targetRoleIds: z.array(z.string()).max(5).optional(),
      mentions: z.array(z.object({ type: z.enum(["doc", "folder", "role", "skill"]), id: z.string().min(1) })).max(20).optional(),
      images: z.array(z.string().regex(/^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/)).max(3).optional(),
      articleId: z.string().min(1).optional(),
      conversationId: z.string().min(1).optional(),
    }).refine((d) => (d.message?.length ?? 0) > 0 || (d.images?.length ?? 0) > 0, { message: L(req, "消息不能为空", "Message cannot be empty"), path: ["message"] })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? L(req, "参数错误", "Invalid parameters") });
    // 只发图片(message 为空)→ 给模型一句兜底指令看图作答;持久化的 content 仍保持原样(空),
    // 这样气泡只显示图片、不夹一句机器味文案。标题也用「[图片]」兜底。
    const message = parsed.data.message ?? "";
    const hasImages = (parsed.data.images?.length ?? 0) > 0;
    const promptText = message || (hasImages ? L(req, "(我发了图片,请查看图片内容并回应。)", "(I sent an image. Please look at it and respond.)") : message);

    // 图片归属校验(必须是该用户自己的上传、且确为图片)→ 绝对路径。失败按输入错误回(SSE 未开)。
    let chatImages: { urls: string[]; absPaths: string[] };
    try {
      chatImages = await resolveChatImages(user.id, parsed.data.images ?? []);
    } catch (e) {
      return reply.code(400).send({ error: "invalid_input", message: (e as Error).message });
    }

    // 会话解析:带 conversationId 且归属本人 → 用之;否则惰性新建(首发即落库),标题取首条消息。
    const ownedConv = parsed.data.conversationId ? await getOwnedConversation(user.id, parsed.data.conversationId) : null;
    const conv = ownedConv ?? await createConversation(user.id, deriveTitle(message || (hasImages ? L(req, "[图片]", "[Image]") : "")));

    // 整轮置于每会话互斥锁内:既然与首页助手共享同一条会话(roleId=""),就必须与
    // runChatTurn 走同一把 runExclusive(conv.id) 锁,否则两端并发轮次会交错读写历史/摘要、
    // 重复落库、trimConversation 互踩。锁键同 runChatTurn → 跨端真正串行化。
    await runExclusive(conv.id, async () => {
      const userRoleIds = await getUserRoleIds(user.id);
      const resolved = await resolveMentions(parsed.data.mentions ?? [], { id: user.id, isAdmin: user.isAdmin }, userRoleIds, message);
      // 文档内问答:把当前文档当作一条 @doc 引用置顶并入检索。
      if (parsed.data.articleId) {
        const active = await loadActiveArticle(parsed.data.articleId, { id: user.id, isAdmin: user.isAdmin }, userRoleIds);
        if (active && !resolved.hits.some((h) => h.articleId === active.articleId)) {
          resolved.hits.unshift(active);
          resolved.snapshot.unshift({ type: "doc", id: active.articleId, label: active.title });
        }
      }
      // 用户消息先落库(含 mentions/images 快照):即便后续编排抛错,提问也不会从历史里消失。
      const justInserted = await prisma.chatMessage.create({
        data: {
          conversationId: conv.id, role: "user", content: message, source: "web",
          mentions: resolved.snapshot.length > 0 ? JSON.stringify(resolved.snapshot) : null,
          images: chatImages.urls.length > 0 ? JSON.stringify(chatImages.urls) : null,
        },
      });
      // 连续记忆:加载最近历史(排除刚插入的)+ 滚动摘要。
      const historyCap = conv.summary ? 4 : 8;
      const recent = await prisma.chatMessage.findMany({
        where: { conversationId: conv.id, NOT: { id: justInserted.id } },
        orderBy: { createdAt: "desc" }, take: historyCap,
      });
      // 生图轮 content 为空、叙述存 thinking → 历史回放用 content || thinking,
      // 否则下一轮模型看不到「上轮画了什么」,「把图改宽点」会丢上下文。
      const history = recent.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content || m.thinking || "" }));

      const sse = openSse(reply); // 校验已过,从此走 SSE
      // 先把会话 id 透给前端:新对话据此立刻落定 id、标记「生成中」、把 URL 换成 /c/:id,
      // 这样回复中切走再切回也能识别为同一会话并显示「正在回复」(而非 done 时才知道 id)。
      sse.send("meta", { conversationId: conv.id });
      // 全程 SSE 心跳:codex 是【非流式】provider(总结完才一次性吐出,期间一个字节都不发),
      // 生图也有长时间无 token 的窗口;两段静默叠加可达数分钟。每 15s 发一条注释保活,
      // 否则反代(nginx 等)idle 超时会掐断整条流 → 后端明明算完了、前端却「没有下文」。
      const hb = setInterval(() => sse.comment("alive"), 15_000);
      try {
        const result = await orchestrate({
          question: promptText,
          targetRoleIds: parsed.data.targetRoleIds,
          conversationId: conv.id,
          requestingUserId: user.id,   // 升级单初始指派给提问者
          mentions: resolved, images: chatImages.absPaths, history,
          summary: conv.summary ?? undefined, chatPreference: user.chatPreference ?? undefined,
          runExpertLlm: callExpertLlm,
          runTriageLlm: genericLlm,
          runSummaryLlm: summaryLlm,
          runGeneralLlm: callGeneralLlm,
          // 文生图(落盘归属到本用户)。生图期间的静默由上面的全程心跳覆盖,这里不再单独起心跳。
          runImageGen: async (prompt) => generateImages(prompt, user.id),
          onEvent: (e) => sse.send("step", e),
          onToken: (t) => sse.send("token", { text: t }),
          onThinking: (t) => sse.send("thinking", { text: t }), // 思考过程逐字推给前端「思考过程」区
          onThinkingEnd: () => sse.send("thinking_end", {}),    // 思考结束 → 前端收起脉冲
        });
        // 持久化 doc 出处的 articleId(去重),刷新后由 /chat/conversation 解析回 citedRefs
        // → 前端重建出处芯片(web/meeting/group-qa 出处无对应列,仅当轮存在)。
        const citedDocIds = Array.from(new Set(result.citations.filter((c) => c.source === "doc").map((c) => c.ref)));
        const assistantMsg = await prisma.chatMessage.create({ data: { conversationId: conv.id, role: "assistant", content: result.answer, source: "web", citedArticleIds: citedDocIds.length > 0 ? JSON.stringify(citedDocIds) : null, images: result.images?.length ? JSON.stringify(result.images) : null, thinking: result.thinking || null } });
        // Web 通知(站内铃铛 + 浏览器桌面):助手生图完成时提醒本人。桌面弹窗仅在标签页
        // 不在前台时由前端弹出(用户正看着就不打扰),铃铛始终留一条记录。fire-and-forget。
        if (result.images?.length) {
          void emitSelfNotification({
            userId: user.id,
            type: "image_gen",
            title: L(req, `${ASSISTANT_NAME} 已生成图片`, `${ASSISTANT_NAME} generated an image`),
            body: L(req, "点击查看生成的图片", "Tap to view the generated image"),
            link: `/c/${conv.id}`,
            dedupeKey: `image:${assistantMsg.id}`,
          });
        }
        void trimConversation(conv.id).catch(() => { /* 软失败 */ });
        // 触达会话:推进 lastMessageAt(列表「最近活跃」排序)。runChatTurn 落消息时也做同样的事;
        // 首页助手走的是本编排路径,不补这一步会话列表就永远按 createdAt 排,新消息不置顶。
        void touchConversation(conv.id);
        // 滚动摘要推进:与 runChatTurn 一致,每轮 assistant 落库后触发(节流 + 去重在内部);
        // 否则经专家端口驱动的长会话摘要锚点会一直停在首页端最后一次刷新处。
        void maybeRefreshSummary(conv.id, { log: req.log });
        // 实时提醒该用户的其它打开页(另一标签页 / 浮窗气泡)刷新会话列表与消息。
        // 发起页自己靠 store 的 suppressNextUpdate 跳过这次重拉(保住刚渲染的 trace,见 useChatUpdates)。
        publishChatUpdate(user.id, { source: "web" });
        sse.send("done", { answer: result.answer, thinking: result.thinking, trace: result.trace, citations: result.citations, images: result.images, conversationId: conv.id, escalationId: result.escalationId, escalation: result.escalation });
      } catch (e) {
        // 不把原始异常文本透给前端(可能含 SQL/路径/二进制名);详情记服务端日志。
        req.log.error({ err: e }, "[agents/chat] orchestrate failed");
        sse.send("error", { message: L(req, "对话失败,请稍后再试", "Chat failed. Try again later") });
      } finally {
        clearInterval(hb); // 停掉全程心跳
      }
      sse.end();
    });
  });

  app.post<{ Params: { id: string } }>("/api/agents/escalations/:id/resolve", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = z.object({ resolution: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: L(req, "缺少结论", "Missing conclusion") });
    // 授权:只有该升级单的负责人(assignee)或管理员能拍板,防止任意登录用户凭 id 替别人决策。
    const row = await prisma.escalation.findUnique({ where: { id: req.params.id }, select: { assigneeUserId: true } });
    if (!row) return reply.code(404).send({ error: "not_found", message: L(req, "升级单不存在", "Escalation not found") });
    if (!user.isAdmin && row.assigneeUserId !== user.id) {
      return reply.code(403).send({ error: "forbidden", message: L(req, "只有该升级单的负责人可以拍板", "Only the owner of this escalation can decide") });
    }
    const esc = await resolveEscalation(req.params.id, { resolution: parsed.data.resolution, by: user.id });
    return { id: esc.id, status: esc.status, resolution: esc.resolution };
  });

  // 转交:当前 assignee 或管理员把升级单改派给他人(改 assignee + 给新人发飞书卡片)。链式允许。
  app.post<{ Params: { id: string } }>("/api/agents/escalations/:id/forward", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = z.object({ toUserId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: L(req, "缺少转交对象", "Missing transfer target") });
    const row = await prisma.escalation.findUnique({ where: { id: req.params.id }, select: { assigneeUserId: true, roleId: true } });
    if (!row) return reply.code(404).send({ error: "not_found", message: L(req, "升级单不存在", "Escalation not found") });
    if (!user.isAdmin && row.assigneeUserId !== user.id) return reply.code(403).send({ error: "forbidden", message: L(req, "只有当前负责人可以转交", "Only the current owner can transfer") });
    const role = await prisma.role.findUnique({ where: { id: row.roleId }, select: { name: true } });
    const res = await forwardEscalation(req.params.id, { toUserId: parsed.data.toUserId, byUserId: user.id, roleName: role?.name ?? "" });
    if (!res.ok) return reply.code(400).send({ error: "invalid_input", message: res.reason === "bad-target" ? L(req, "转交对象不存在或已停用", "Transfer target not found or deactivated") : L(req, "该升级单已处理", "This escalation has already been handled") });
    return { ok: true, cardSent: res.cardSent ?? false };
  });

  app.get("/api/me/escalations", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const rows = await prisma.escalation.findMany({
      where: { assigneeUserId: user.id, status: "pending" },
      orderBy: { createdAt: "desc" },
      take: 200, // 兜底上限:待办本应不多,避免极端情况下无界返回
    });
    return {
      items: rows.map((r) => ({
        id: r.id, roleId: r.roleId, background: r.background, question: r.question,
        options: ((): string[] => { try { return JSON.parse(r.options); } catch { return []; } })(),
        createdAt: r.createdAt.toISOString(),
        canForward: true, // 当前 assignee 总可转交
      })),
    };
  });
}
