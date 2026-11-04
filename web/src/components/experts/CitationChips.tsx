import { Link } from "react-router-dom";
import type { ExpertCitation } from "@/lib/api";
import { safeUrl } from "@/components/chat/ChatMarkdown";
import { useT } from "@/i18n";

// 出处标签:按来源给出可点击跳转。
//   doc       → /d/:articleId   知识库文档
//   meeting   → /meeting/:id    会议室
//   web       → 外链(新开页)
//   group-qa  → 无独立页 → 纯文本展示
// 同一 (source+ref) 去重,避免多专家返回的重复出处堆叠。
export function CitationChips({ citations }: { citations: ExpertCitation[] }) {
  const t = useT();
  const seen = new Set<string>();
  const uniq = citations.filter((c) => {
    const k = `${c.source}:${c.ref}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (uniq.length === 0) return null;

  const cls = "rounded bg-white px-2 py-1 text-primary ring-1 ring-line hover:bg-accent-soft";
  return (
    <div className="flex flex-wrap gap-2 text-[11px]">
      {uniq.map((c, j) => {
        const title = c.title || t("experts.untitled");
        if (c.source === "web") {
          // 第二层防线:服务端已只收 http(s),这里再核一次,不合格的只显示文字。
          const href = /^https?:\/\//i.test(c.ref) ? safeUrl(c.ref) : null;
          if (!href) return <span key={j} className="rounded bg-white px-2 py-1 text-muted ring-1 ring-line">{t("experts.cite.web", { title })}</span>;
          return <a key={j} href={href} target="_blank" rel="noreferrer" className={`${cls} underline decoration-dotted`}>{t("experts.cite.web", { title })}</a>;
        }
        if (c.source === "doc") {
          return <Link key={j} to={`/d/${c.ref}`} className={cls}>{t("experts.cite.doc", { title })}</Link>;
        }
        if (c.source === "meeting") {
          return <Link key={j} to={`/meeting/${c.ref}`} className={cls}>{t("experts.cite.meeting", { title })}</Link>;
        }
        return <span key={j} className="rounded bg-white px-2 py-1 text-muted ring-1 ring-line">{t("experts.cite.groupQa", { title })}</span>;
      })}
    </div>
  );
}
