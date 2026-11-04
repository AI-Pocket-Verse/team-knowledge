import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { AnalyticsComposition } from "@team-knowledge/shared";
import { useT, type MessageKey } from "@/i18n";

const PALETTE = ["#3370FF", "#00B42A", "#FF7D00", "#F53F3F", "#7B61FF", "#0FC6C2", "#165DFF", "#D91AD9", "#86909C", "#FFC53D"];

const INTERACTION_KEY: Record<string, MessageKey> = { like: "dashboard.interaction.like", comment: "dashboard.interaction.comment", bookmark: "dashboard.interaction.bookmark" };
const UPLOAD_KEY: Record<string, MessageKey> = { image: "dashboard.upload.image", document: "dashboard.upload.document", other: "dashboard.upload.other" };

interface Slice { name: string; value: number }

function Donut({ title, data }: { title: string; data: Slice[] }) {
  const t = useT();
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-glass">
      <div className="mb-2 text-xs font-semibold text-muted">{title}</div>
      {total > 0 ? (
        <>
          <div className="h-36 w-full">
            {/* initialDimension avoids recharts' "width(-1) height(-1)" warning +
                blank first paint; ResizeObserver corrects to the real size after. */}
            <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 240, height: 144 }}>
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="55%"
                  outerRadius="80%"
                  paddingAngle={1}
                  isAnimationActive={false}
                >
                  {data.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #dee0e3" }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-2 space-y-1">
            {data.map((d, i) => (
              <li key={d.name} className="flex items-center gap-1.5 text-xs text-fg/80">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
                <span className="truncate">{d.name}</span>
                <span className="ml-auto tabular-nums text-muted">{d.value}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="flex h-36 items-center justify-center text-xs text-muted">{t("dashboard.empty")}</div>
      )}
    </div>
  );
}

export function CompositionPies({ composition }: { composition: AnalyticsComposition }) {
  const t = useT();
  const byRole: Slice[] = composition.byRole.map((r) => ({ name: r.roleName, value: r.count }));
  const byInteraction: Slice[] = composition.byInteraction.map((s) => ({ name: INTERACTION_KEY[s.key] ? t(INTERACTION_KEY[s.key]) : s.key, value: s.count }));
  const byUpload: Slice[] = composition.byUpload.map((s) => ({ name: UPLOAD_KEY[s.key] ? t(UPLOAD_KEY[s.key]) : s.key, value: s.count }));

  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Donut title={t("dashboard.pie.byRole")} data={byRole} />
      <Donut title={t("dashboard.pie.byInteraction")} data={byInteraction} />
      <Donut title={t("dashboard.pie.byUpload")} data={byUpload} />
    </section>
  );
}
