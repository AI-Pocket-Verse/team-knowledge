// Best-effort Feishu heads-up to admins when a brand-new user first logs in.
//
// Deliberately decoupled from the article-engagement pipeline (service.ts):
// that one is built around an article + a recipient derived from it, and writes
// to the Notification outbox. This is a much simpler "someone new joined — go
// give them a role" alert pushed straight to every admin's Feishu via the same
// bot gateway. Fire-and-forget: the caller (requireUser) wraps it in
// trackBestEffort so it never blocks or fails the login path.
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { feishuGateway } from "../feishuGateway.js";
import { stripCnTz } from "../beijingWeek.js";
import { applinkWrap } from "./card.js";

interface NewUser {
  id: string;
  displayName: string;
  email: string | null;
}

// Feishu interactive card announcing the newcomer. User-supplied fields
// (displayName / email) go in plain_text — never lark_md — so a crafted display
// name can't inject links/markdown into an admin's bot card (same hardening the
// comment-excerpt card uses).
function buildNewUserCard(u: NewUser): unknown {
  const usersUrl = `${env.WEB_PUBLIC_URL.replace(/\/$/, "")}/admin/users`;
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "新用户加入" } },
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: `${u.displayName}${u.email ? `（${u.email}）` : ""} 首次登录，暂无角色。`,
        },
      },
      { tag: "div", text: { tag: "plain_text", content: "请在「系统管理 → 用户」中为 TA 分配角色。" } },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "去分配角色" },
            type: "primary",
            url: applinkWrap(usersUrl, env.FEISHU_CARD_USE_APPLINK),
          },
        ],
      },
    ],
  };
}

/**
 * Push the "new user joined" card to every active admin. Skips:
 *   - the newcomer themselves (a fresh bootstrap admin shouldn't self-alert),
 *   - admins who never logged in (no User row → nothing to target),
 *   - admins whose ssoId isn't a Feishu open_id (ou_*) — the gateway only
 *     delivers by open_id, so there's nowhere to push.
 * Best-effort per admin (allSettled): one failed push never drops the rest, and
 * the whole thing is swallowed by the caller's trackBestEffort.
 */
export async function notifyAdminsOfNewUser(newUser: NewUser): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { isAdmin: true, isActive: true },
    select: { id: true, ssoId: true },
  });
  const targets = admins.filter(
    (a) => a.id !== newUser.id && !!a.ssoId && a.ssoId.startsWith("ou_"),
  );
  if (targets.length === 0) return;
  const card = buildNewUserCard(newUser);
  await Promise.allSettled(targets.map((a) => feishuGateway.notify(a.ssoId as string, card)));
}

interface WeeklyReportAlert {
  id: string;
  weekLabel: string;
  summary: string; // 后端生成的概览文字(纯文本,plain_text 安全)
}

// 周报生成完成的飞书卡片:标题 + 概览文字 + 跳转按钮(知识库周报详情链接)。
function buildWeeklyReportCard(r: WeeklyReportAlert): unknown {
  const url = `${env.WEB_PUBLIC_URL.replace(/\/$/, "")}/admin/weekly-report/${r.id}`;
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: `知识库周报 · ${stripCnTz(r.weekLabel)}` } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: stripCnTz(r.summary) } },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "查看完整周报" },
            type: "primary",
            url: applinkWrap(url, env.FEISHU_CARD_USE_APPLINK),
          },
        ],
      },
    ],
  };
}

/**
 * 周报生成完成后,给每位活跃管理员推送一张飞书卡片(附详情链接 + 概览)。
 * 与 notifyAdminsOfNewUser 同套机制:仅按 Feishu open_id(ou_*)投递,逐个
 * best-effort(allSettled),单个失败不影响其余。
 */
export async function notifyAdminsOfWeeklyReport(r: WeeklyReportAlert): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { isAdmin: true, isActive: true },
    select: { ssoId: true },
  });
  const targets = admins.filter((a) => !!a.ssoId && a.ssoId.startsWith("ou_"));
  if (targets.length === 0) return;
  const card = buildWeeklyReportCard(r);
  await Promise.allSettled(targets.map((a) => feishuGateway.notify(a.ssoId as string, card)));
}
