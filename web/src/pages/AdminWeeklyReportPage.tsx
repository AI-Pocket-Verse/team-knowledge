import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { WeeklyReportListItem } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { stripCnTz } from "@/lib/format";
import { DelayedLoader } from "@/components/DelayedLoader";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/Toaster";
import { useAdminAccess } from "@/lib/adminAccess";

// 访问门控由路由层 RequireAdminPage(pageKey="weekly-report")负责:管理员,或该页已在
// 「页面可见性」放开给所有成员。不再自拦 isAdmin(否则放开后成员会被弹走)。
export function AdminWeeklyReportPage() {
  return <AdminWeeklyReportPageInner />;
}

function fmtHours(min: number): string {
  return `${(min / 60).toFixed(1)} 小时`;
}

// 周报口径统一北京时间(UTC+8),生成时间也按北京显示(避免浏览器本地时区不一致)。
function fmtBeijingFull(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3600000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function AdminWeeklyReportPageInner() {
  const navigate = useNavigate();
  const [reports, setReports] = useState<WeeklyReportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  // 页面可放开给成员只读;生成 / 刷新接口仅管理员可用,成员不显示按钮与相关提示。
  const { isAdmin } = useAdminAccess();

  const refetch = useCallback(async () => {
    try {
      const r = await api.admin.weeklyReport.list();
      setReports(r.reports);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.admin.weeklyReport.list();
        if (!cancelled) setReports(r.reports);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function onGenerate() {
    setGenerating(true);
    try {
      const r = await api.admin.weeklyReport.generate();
      toast.success(r.created ? "已生成本周周报" : "已刷新本周周报");
      await refetch();
    } catch (err) {
      toast.error(`生成失败：${(err as Error).message}`);
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return <DelayedLoader />;
  if (error) return <div className="text-rose-600 text-sm">⚠ {error}</div>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs text-muted">
            按北京时间自然周(周一 00:00 – 周日 24:00)统计。{isAdmin ? "点「刷新本周周报」随时生成 / 更新「本周(进行中)」实时数据;" : ""}每周一 00:00 自动把上一个完整周定稿归档。点「查看」打开图文报告并可导出 PDF / HTML。
          </p>
        </div>
        {isAdmin && (
          <Button onClick={onGenerate} disabled={generating} className="shrink-0 whitespace-nowrap">
            {generating ? "生成中…" : "生成/刷新本周周报"}
          </Button>
        )}
      </div>

      {reports.length === 0 ? (
        <div className="rounded-xl border border-line bg-white px-8 py-12 text-center text-sm text-muted">
          {isAdmin ? "还没有周报。点右上角「生成/刷新本周周报」生成第一份。" : "还没有周报，每周一会自动生成上一周的周报。"}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-white shadow-glass">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">周区间</th>
                <th className="px-4 py-2 font-medium">活跃用户</th>
                <th className="px-4 py-2 font-medium">总操作</th>
                <th className="px-4 py-2 font-medium">在线总时长</th>
                <th className="px-4 py-2 font-medium">生成时间</th>
                <th className="px-4 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer border-t border-line align-middle transition hover:bg-surface"
                  onClick={() => navigate(`/admin/weekly-report/${r.id}`)}
                >
                  <td className="px-4 py-2 font-medium">
                    <span className="inline-flex items-center gap-2">
                      {stripCnTz(r.weekLabel)}
                      {!r.finalized && (
                        <span
                          className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-normal text-primary"
                          title="本周尚未结束,数据会随刷新增长;每周一 00:00 自动定稿归档"
                        >
                          本周
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2 tabular-nums">{r.activeUsers}</td>
                  <td className="px-4 py-2 tabular-nums">{r.totalOps}</td>
                  <td className="px-4 py-2 tabular-nums text-muted">{fmtHours(r.totalDurationMin)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-muted">{fmtBeijingFull(r.generatedAt)}</td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); navigate(`/admin/weekly-report/${r.id}`); }}
                    >
                      查看
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
