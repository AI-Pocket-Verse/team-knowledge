// Feishu interactive-card builder + doc deep link for engagement notifications.
import { env } from "../../env.js";

export type NotifType =
  | "article_like"
  | "article_favorite"
  | "article_comment"
  | "comment_reply"
  | "comment_mention"
  | "article_review_issue"
  | "article_review_reminder";

/** Absolute URL to a doc (clickable from a Feishu card), optional comment anchor. */
export function docDeepLink(articleId: string, commentId?: string): string {
  // 用 WEB_PUBLIC_URL（站点地址，部署在子路径时含路径前缀），而非 WEB_ORIGIN（CORS origin，无路径）。
  const base = env.WEB_PUBLIC_URL.replace(/\/$/, "");
  return `${base}/d/${articleId}${commentId ? `#comment-${commentId}` : ""}`;
}

/** Optionally wrap a URL in a Feishu applink so it opens inside Feishu's in-app
 *  browser (SSO carries) instead of the system browser. Off → plain URL. */
export function applinkWrap(url: string, useApplink: boolean): string {
  if (!useApplink) return url;
  return `https://applink.feishu.cn/client/web_url/open?url=${encodeURIComponent(url)}`;
}

/** 把要插进 lark_md 卡片的「短字段」(会议标题/角色名/文档标题/提交首行等用户可控
 *  文本)中的半角方括号换成全角 —— 阻断拼出可点击的 [文字](URL) 链接注入。只动
 *  方括号:其它 markdown 字符(* _ `)最多影响样式不构成链接,替换会歪曲原文;
 *  lark_md 对反斜杠转义支持不可靠,故用全角替换而非转义。 */
export function delinkLarkMd(s: string): string {
  return s.replace(/\[/g, "［").replace(/\]/g, "］");
}

const TITLE: Record<NotifType, (actor: string) => string> = {
  article_like: (a) => `${a} 赞了你的文档`,
  article_favorite: (a) => `${a} 收藏了你的文档`,
  article_comment: (a) => `${a} 评论了文档`,
  comment_reply: (a) => `${a} 回复了你的评论`,
  comment_mention: (a) => `${a} 在评论中提到了你`,
  article_review_issue: () => "文档待优化",
  article_review_reminder: () => "文档待优化 · 每日提醒",
};

export interface NotificationCardInput {
  type: NotifType;
  actorName: string;
  articleTitle: string;
  articleId: string;
  commentId?: string;
  excerpt?: string;
}

/** Build the Feishu interactive card payload for a notification. */
export function buildNotificationCard(p: NotificationCardInput): unknown {
  // 每日提醒是「聚合多篇」的汇总标题(如「你有 3 篇文档待优化」),不套书名号《》;其余是单篇。
  // 标题是用户可控文本,进 lark_md 前先去掉能拼成链接的方括号。
  const title = delinkLarkMd(p.articleTitle);
  const heading = p.type === "article_review_reminder" ? `**${title}**` : `**《${title}》**`;
  const elements: unknown[] = [
    { tag: "div", text: { tag: "lark_md", content: heading } },
  ];
  if (p.excerpt && p.excerpt.trim()) {
    // plain_text (NOT lark_md): the excerpt is another user's comment body —
    // rendering it as markdown would let a commenter inject links / formatting
    // into the recipient's bot card (phishing). plain_text shows it verbatim.
    elements.push({ tag: "div", text: { tag: "plain_text", content: p.excerpt.slice(0, 120) } });
  }
  elements.push({
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "查看文档" },
        type: "primary",
        url: applinkWrap(docDeepLink(p.articleId, p.commentId), env.FEISHU_CARD_USE_APPLINK),
      },
    ],
  });
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: TITLE[p.type](p.actorName) } },
    elements,
  };
}
