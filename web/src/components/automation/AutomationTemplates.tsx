import type { AutomationTemplate } from "@/lib/api";

// 模板图标(按 template.icon key 映射;未知 key 回退通用图标)。
function TemplateIcon({ icon }: { icon: string }) {
  const paths: Record<string, React.ReactNode> = {
    news: <><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" /><path d="M18 14h-8M15 18h-5M10 6h8v4h-8V6Z" /></>,
    report: <><path d="M8 2v4M16 2v4M3 10h18" /><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" /></>,
    word: <><path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6" /></>,
    why: <><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" /></>,
    history: <><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l4 2" /></>,
    meeting: <><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" /></>,
  };
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-muted">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        {paths[icon] ?? <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 9h6v6H9z" /></>}
      </svg>
    </span>
  );
}

interface Props {
  templates: AutomationTemplate[];
  onPick: (t: AutomationTemplate) => void;
}

// 在弹窗内展示的模板网格(标题/关闭由外层 Dialog 提供)。点选后预填「添加」表单。
export function AutomationTemplates({ templates, onPick }: Props) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {templates.map((t) => (
        <button key={t.key} type="button" onClick={() => onPick(t)}
          className="flex items-start gap-3 rounded-xl border border-line bg-white p-4 text-left transition hover:border-primary/40 hover:shadow-glass">
          <TemplateIcon icon={t.icon} />
          <div className="min-w-0">
            <div className="font-semibold text-fg">{t.title}</div>
            <div className="mt-0.5 line-clamp-2 text-xs text-muted">{t.description}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
