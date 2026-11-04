import { z } from "zod";

export const chatMessageCreateSchema = z
  .object({
    // 带图时允许只发图不发文字(content 可为空串);纯文本仍要求非空 —— 由
    // 末尾的 superRefine 统一校验「文字与图片至少有一样」。
    content: z.string().max(4096, "消息过长"),
    // 随消息附带的图片:本服务的 /uploads/<file> 视图(先经 /api/uploads/image
    // 上传)。服务端另在 runChatTurn 校验归属(必须是发送者自己上传的图片)。
    images: z
      .array(z.string().regex(/^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/, "图片地址不合法"))
      .max(3, "一条消息最多 3 张图片")
      .optional(),
    // When the user opens the AI panel while reading an article, the
    // frontend sends that article's id so the route can prepend it to
    // the retrieved-corpus list (subject to the user's view perms) —
    // turning the chat into a per-doc Q&A surface instead of a generic
    // knowledge-base search. Optional / nullable so the existing
    // "ask anywhere" entry point keeps working unchanged.
    articleId: z.string().min(1).optional().nullable(),
    // 目标会话;缺省 = 新建一条普通会话(惰性建,首发即落库)。
    conversationId: z.string().min(1).optional(),
    // Structured @-mentions attached to the turn via the chip selector.
    // Server resolves the label from the database (defeats client-side
    // tampering with the displayed text) and uses the {type, id}s to
    // BOOST retrieval — mentioned docs / folder-docs / role-docs are
    // prepended to the retrieved list before FTS hits. Capped at 10
    // per turn so retrieval doesn't blow past the LLM token budget.
    mentions: z
      .array(
        z.object({
          // "skill" = use a role's AI-generated skill.md (id is the roleId);
          // "role" is kept for back-compat with older persisted turns.
          type: z.enum(["doc", "folder", "role", "skill"]),
          id: z.string().min(1),
        }),
      )
      .max(10, "@ 引用过多")
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.content.trim().length === 0 && (v.images?.length ?? 0) === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "消息不能为空", path: ["content"] });
    }
  });
