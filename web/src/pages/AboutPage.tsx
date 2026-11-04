import { CHANGELOG, CURRENT_VERSION, type ChangelogKind } from "@/lib/changelog";

// 关于 page — shows the product, current version, and the changelog.
// Reached from the user-avatar menu (entry sits above 退出登录).

const KIND_BADGE: Record<ChangelogKind, { label: string; cls: string }> = {
  major: { label: "大版本", cls: "bg-accent-soft text-primary" },
  minor: { label: "功能", cls: "bg-emerald-50 text-emerald-700" },
  patch: { label: "修复", cls: "bg-surface text-muted" },
};

export function AboutPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-blue-600 text-2xl font-bold text-white shadow-glass">
          A
        </div>
        <div>
          <h1 className="text-xl font-semibold text-fg">团队知识库</h1>
          <p className="mt-0.5 text-sm text-muted">
            当前版本 <span className="font-medium text-fg">v{CURRENT_VERSION}</span>
          </p>
        </div>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted">更新日志</h2>
        <ol className="relative flex flex-col gap-4 border-l border-line pl-5">
          {CHANGELOG.map((entry) => {
            const badge = KIND_BADGE[entry.kind];
            return (
              <li key={entry.version} className="relative">
                {/* Centered ON the ol's border-l line: -left-5 puts the dot
                    at the padding-left origin (where the line sits), then
                    -translate-x-1/2 centers the 10px dot over it. */}
                <span className="absolute -left-5 top-1.5 h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 border-white bg-primary" />
                <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-fg">v{entry.version}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${badge.cls}`}>{badge.label}</span>
                    {entry.date && <span className="ml-auto text-xs text-muted">{entry.date}</span>}
                  </div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg/80">
                    {entry.items.map((it, i) => (
                      <li key={i}>{it}</li>
                    ))}
                  </ul>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
