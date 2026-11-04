// 管理后台「页面可见性」:按白名单页面配置 仅管理员 / 所有成员可看(放开=完全可用)。
// 默认全部仅管理员。只这几个页面可配置;其余 admin 页永久仅管理员。
// 能进白名单的前提:该页所有 API 都能用 requireAdminOrOpenPage(pageKey) 守卫、且不依赖
// 仅管理员的敏感数据(如「专家设定」要拉 /admin/roles,故暂不可放开)。
import type { FastifyRequest, FastifyReply } from "fastify";
import { getSetting, setSetting } from "../settings.js";
import { requireUser } from "../../utils/guards.js";
import { L, appLang, type Lang } from "../../utils/lang.js";

export type PageVisibility = "admin" | "all";
export interface EligiblePage { key: string; label: string; }

export const ELIGIBLE_PAGES: EligiblePage[] = [
  { key: "article-review", label: "文档校验" },
  { key: "group-qa", label: "群答疑记录" },
  { key: "weekly-report", label: "周报" },
  { key: "web-notify", label: "Web 通知" },
];
const ELIGIBLE_LABELS_EN: Record<string, string> = {
  "article-review": "Doc check",
  "group-qa": "Group Q&A log",
  "weekly-report": "Weekly report",
  "web-notify": "Web notifications",
};
/** 按语言返回可放开页面清单(中文即 ELIGIBLE_PAGES 原样)。 */
export function eligiblePages(lang: Lang = appLang()): EligiblePage[] {
  return lang === "en" ? ELIGIBLE_PAGES.map((p) => ({ ...p, label: ELIGIBLE_LABELS_EN[p.key] ?? p.label })) : ELIGIBLE_PAGES;
}
const ELIGIBLE_KEYS = new Set(ELIGIBLE_PAGES.map((p) => p.key));
const KEY = "admin.page-visibility";

/** 全量可见性(白名单补齐缺省 admin;脏值按 admin)。 */
export async function getVisibilityMap(): Promise<Record<string, PageVisibility>> {
  const raw = await getSetting<Record<string, unknown>>(KEY, {});
  const out: Record<string, PageVisibility> = {};
  for (const { key } of ELIGIBLE_PAGES) out[key] = raw[key] === "all" ? "all" : "admin";
  return out;
}

export async function isOpenToAll(pageKey: string): Promise<boolean> {
  if (!ELIGIBLE_KEYS.has(pageKey)) return false;
  return (await getVisibilityMap())[pageKey] === "all";
}

/** 已放开给所有成员的白名单 key(按 ELIGIBLE_PAGES 顺序)。 */
export async function openPageKeys(): Promise<string[]> {
  const map = await getVisibilityMap();
  return ELIGIBLE_PAGES.filter((p) => map[p.key] === "all").map((p) => p.key);
}

/** 写单页可见性(仅白名单 key;非法 key 抛错)。返回更新后的全量 map。 */
export async function setPageVisibility(pageKey: string, value: PageVisibility, by: string): Promise<Record<string, PageVisibility>> {
  if (!ELIGIBLE_KEYS.has(pageKey)) throw new Error(`page not eligible: ${pageKey}`);
  const raw = await getSetting<Record<string, unknown>>(KEY, {});
  raw[pageKey] = value === "all" ? "all" : "admin";
  await setSetting(KEY, raw, by);
  return getVisibilityMap();
}

/** 守卫:管理员放行;否则该页必须是白名单且已放开。返回 user 或 null(已 reply 403)。 */
export async function requireAdminOrOpenPage(req: FastifyRequest, reply: FastifyReply, pageKey: string) {
  const user = await requireUser(req, reply);
  if (!user) return null;
  if (user.isAdmin) return user;
  if (await isOpenToAll(pageKey)) return user;
  reply.code(403).send({ error: "forbidden", message: L(req, "无权访问该页面", "You do not have access to this page") });
  return null;
}
