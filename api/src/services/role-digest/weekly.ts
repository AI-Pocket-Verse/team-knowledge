// 本周(北京自然周,周一 00:00 起)各角色的知识库变动统计 + 研发改动汇总,
// 用于周五的飞书群周报。纯计算 + 纯卡片组装(便于单测),发送在 scripts 里做。
//
// 数据口径(均排除回收站 deletedAt != null):
//   - created:   本周新建的文档(Article.createdAt 落在本周)
//   - updated:   本周有内容版本（edit / restore / import / ai-fix）的旧文档（createdAt 在本周之前）；
//                不看 Article.updatedAt —— 拖动排序、移动目录也会让它变，但内容没改
// (去状态后不再有「发布」口径 —— 文档新建即可见。)
import { prisma } from "../../db.js";
import { startOfBeijingWeek, beijingWeekOf, beijingWorkWeekLabel, stripCnTz } from "../../utils/beijingWeek.js";
import { delinkLarkMd } from "../../utils/notify/card.js";
import { L, appLang, type Lang } from "../../utils/lang.js";

// 算作「更新」的版本类型，与动态流 / 周报里的文档修改事件同源（ArticleVersion）。
const UPDATE_VERSION_KINDS = ["edit", "restore", "import", "ai-fix"];

const TITLE_CAP = 6; // 每个角色每类最多列几个标题,避免卡片过长

export interface RoleDigest {
  roleId: string;
  roleName: string;
  created: string[];
  updated: string[];
}

export interface WeeklyDigest {
  weekLabel: string;
  weekStart: Date;
  generatedAt: Date;
  roles: RoleDigest[]; // 仅含本周有变动的角色,按总变动量降序
  totals: { created: number; updated: number };
}

function pushTitle(map: Map<string, RoleDigest>, roleId: string, roleName: string, bucket: keyof Pick<RoleDigest, "created" | "updated">, title: string) {
  let d = map.get(roleId);
  if (!d) {
    d = { roleId, roleName, created: [], updated: [] };
    map.set(roleId, d);
  }
  d[bucket].push(title || L(appLang(), "（未命名）", "(Untitled)"));
}

/** 计算本周(含至 now)的角色知识库变动。now 默认当前时刻(由调用方传入便于测试)。 */
export async function computeWeeklyRoleDigest(now: Date): Promise<WeeklyDigest> {
  const weekStart = startOfBeijingWeek(now);
  const window = { gte: weekStart, lte: now };

  const [created, updated] = await Promise.all([
    prisma.article.findMany({
      where: { deletedAt: null, createdAt: window },
      select: { roleId: true, title: true, role: { select: { name: true } } },
    }),
    prisma.article.findMany({
      where: {
        deletedAt: null,
        createdAt: { lt: weekStart },
        versions: { some: { createdAt: window, kind: { in: UPDATE_VERSION_KINDS } } },
      },
      select: { roleId: true, title: true, role: { select: { name: true } } },
    }),
  ]);

  const map = new Map<string, RoleDigest>();
  for (const a of created) pushTitle(map, a.roleId, a.role?.name ?? L(appLang(), "(未知角色)", "(Unknown role)"), "created", a.title);
  for (const a of updated) pushTitle(map, a.roleId, a.role?.name ?? L(appLang(), "(未知角色)", "(Unknown role)"), "updated", a.title);

  const roles = [...map.values()].sort(
    (a, b) => b.created.length + b.updated.length - (a.created.length + a.updated.length),
  );
  const totals = {
    created: created.length,
    updated: updated.length,
  };

  return { weekLabel: beijingWorkWeekLabel(beijingWeekOf(now)), weekStart, generatedAt: now, roles, totals };
}

function titlesLine(prefix: string, titles: string[]): string | null {
  if (titles.length === 0) return null;
  // 文档标题是用户可控文本,过 delinkLarkMd 防止拼出可点击链接。
  const lang = appLang();
  const shown = titles.slice(0, TITLE_CAP).map((t) => L(lang, `「${delinkLarkMd(t)}」`, `"${delinkLarkMd(t)}"`)).join(L(lang, "、", ", "));
  const more = titles.length > TITLE_CAP ? L(lang, ` 等 ${titles.length} 篇`, ` and ${titles.length - TITLE_CAP} more`) : "";
  return L(lang, `${prefix}${titles.length}:${shown}${more}`, `${prefix}${titles.length}: ${shown}${more}`);
}

// 研发改动:来自管理后台配置的 GitHub 仓库(不含本仓库)。
export interface RepoChange {
  label: string;
  count: number; // 本周提交数
  subjects: string[]; // 提交首行(已去重)
  error?: string; // 该仓库拉取失败时单独标注,不影响其它仓库与知识库段
  /** true 时提交数 ≥500,数据不完整,卡片上会标注。 */
  truncated?: boolean;
}
export interface ResearchDigest {
  repos: RepoChange[];
  review?: string | null; // LLM 简评(可空,失败/无内容时省略 —— 对应"没有可以不说")
}

const SUBJECT_SHOW = 8;

/**
 * 组装飞书互动卡片(纯函数)。digest = 知识库统计;research = GitHub 仓库的本周
 * 改动 + LLM 简评。两段均可省略;都为空时返回一张「本周暂无」卡片(仍发,作为
 * 存在性信号)。键限定 config/header/elements 以通过 feishu-sso 端 validCard 校验。
 */
export function buildWeeklyDigestCard(digest: WeeklyDigest, research: ResearchDigest): unknown {
  const lang = appLang();
  const elements: unknown[] = [];
  const hasKb = digest.roles.length > 0;
  const hasRepos = research.repos.length > 0;
  const review = research.review?.trim();
  const hasResearch = hasRepos || !!review;

  if (hasKb) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: L(lang, `**📚 知识库内容更新**\n本周合计:新增 ${digest.totals.created} 篇、更新 ${digest.totals.updated} 篇`, `**📚 Knowledge base updates**\nThis week: ${digest.totals.created} added, ${digest.totals.updated} updated`),
      },
    });
    for (const r of digest.roles) {
      const lines = [titlesLine(L(lang, "新增 ", "Added "), r.created), titlesLine(L(lang, "更新 ", "Updated "), r.updated)].filter(Boolean);
      elements.push({ tag: "div", text: { tag: "lark_md", content: `**${r.roleName}**\n${lines.join("\n")}` } });
    }
  }

  if (hasResearch) {
    if (hasKb) elements.push({ tag: "hr" });
    elements.push({ tag: "div", text: { tag: "lark_md", content: L(lang, "**🛠 研发改动**", "**🛠 Engineering changes**") } });
    for (const r of research.repos) {
      if (r.error) {
        elements.push({ tag: "div", text: { tag: "lark_md", content: L(lang, `**${r.label}**:拉取失败(${r.error})`, `**${r.label}**: fetch failed (${r.error})`) } });
        continue;
      }
      const shown = r.subjects.slice(0, SUBJECT_SHOW).map((s) => `· ${delinkLarkMd(s)}`).join("\n");
      const more = r.subjects.length > SUBJECT_SHOW ? L(lang, `\n…等 ${r.subjects.length} 条`, `\n… ${r.subjects.length} in total`) : "";
      const truncNote = r.truncated ? L(lang, `(≥500 提交，可能不完整)`, ` (500+ commits, may be incomplete)`) : "";
      const body = r.count === 0 ? L(lang, "本周无提交", "No commits this week") : L(lang, `本周 ${r.count} 个提交`, `${r.count} ${r.count === 1 ? "commit" : "commits"} this week`) + `${truncNote}${shown ? `\n${shown}${more}` : ""}`;
      elements.push({ tag: "div", text: { tag: "lark_md", content: `**${r.label}**\n${body}` } });
    }
    if (review) elements.push({ tag: "div", text: { tag: "lark_md", content: L(lang, `**本周小结**\n${review}`, `**Summary**\n${review}`) } });
  }

  if (!hasKb && !hasResearch) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: L(lang, "本周暂无可量化的知识库或研发更新。", "No measurable knowledge base or engineering updates this week.") } });
  }

  // 标题去掉 weekLabel 里的「（北京时间）」(历史 digest 可能仍带括注)。
  const weekRange = stripCnTz(digest.weekLabel);
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: L(lang, `📊 本周周报 · ${weekRange}`, `📊 Weekly digest · ${weekRange}`) }, template: "blue" },
    elements,
  };
}

/** 提交首行去重(保序),用于把单个仓库的提交整理成卡片条目。纯函数,便于单测。 */
export function dedupeSubjects(subjects: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of subjects) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
