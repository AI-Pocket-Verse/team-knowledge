import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { AnalyticsComposition } from "@team-knowledge/shared";

const PALETTE = ["#3370FF", "#00B42A", "#FF7D00", "#F53F3F", "#7B61FF", "#0FC6C2", "#165DFF", "#D91AD9", "#86909C", "#FFC53D"];

const INTERACTION_LABEL: Record<string, string> = { like: "点赞", comment: "评论", bookmark: "收藏" };
const UPLOAD_LABEL: Record<string, string> = { image: "图片", document: "文档", other: "其他" };

interface Slice { name: string; value: number }

function Donut({ title, data }: { title: string; data: Slice[] }) {
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
        <div className="flex h-36 items-center justify-center text-xs text-muted">暂无数据</div>
      )}
    </div>
  );
}

export function CompositionPies({ composition }: { composition: AnalyticsComposition }) {
  const byRole: Slice[] = composition.byRole.map((r) => ({ name: r.roleName, value: r.count }));
  const byInteraction: Slice[] = composition.byInteraction.map((s) => ({ name: INTERACTION_LABEL[s.key] ?? s.key, value: s.count }));
  const byUpload: Slice[] = composition.byUpload.map((s) => ({ name: UPLOAD_LABEL[s.key] ?? s.key, value: s.count }));

  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Donut title="各角色文档占比" data={byRole} />
      <Donut title="互动类型占比" data={byInteraction} />
      <Donut title="上传类型占比" data={byUpload} />
    </section>
  );
}
