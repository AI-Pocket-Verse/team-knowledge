import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { useParams } from "react-router-dom";
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { toPng } from "html-to-image";
import type { WeeklyReportSnapshot, WeeklyReportUserRow, WeeklyReportTrendPoint } from "@team-knowledge/shared";
import { api } from "@/lib/api";
import { stripCnTz } from "@/lib/format";
import { DelayedLoader } from "@/components/DelayedLoader";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/BackButton";
import { toast } from "@/components/Toaster";
import { WEEKLY_REPORT_CSS } from "./weeklyReportCss";
import { buildStandaloneReportHtml } from "./weeklyReportHtml";
import { UserActivityDrawer, type UserActivityTarget } from "@/components/dashboard/UserActivityDrawer";
import { getAssistantName } from "@/lib/assistantName";
import { tr, useT, type MessageKey } from "@/i18n";

const PALETTE = ["#3370FF", "#00B42A", "#FF7D00", "#F53F3F", "#7B61FF", "#0FC6C2", "#165DFF", "#D91AD9", "#86909C", "#FFC53D"];
const LIVE_PAGE = 10;
// 「全部用户」折线/饼图最多展示的用户数(按贡献度倒序取前 N,避免线太多看不清)。
const MAX_USER_SERIES = 12;

type ChartRow = Record<string, number | string>;

// 趋势折线的系列(对应 trends 字段)。activeUsers 仅在「全部用户」视角有意义。
const TREND_SERIES = [
  { key: "docCreate", label: "admin.wr.s.docCreate", color: "#3370FF" },
  { key: "docEdit", label: "admin.wr.s.docEdit", color: "#00B42A" },
  { key: "chat", label: "admin.wr.s.chat", color: "#FF7D00" },
  { key: "comment", label: "admin.wr.s.comment", color: "#F53F3F" },
  { key: "like", label: "admin.wr.s.like", color: "#7B61FF" },
  { key: "view", label: "admin.wr.s.view", color: "#0FC6C2" },
  { key: "activeUsers", label: "admin.wr.s.activeUsers", color: "#86909C" },
] as const satisfies readonly { key: string; label: MessageKey; color: string }[];

// ISO → 北京时间显示(整份周报以北京时间口径)。
function fmtBeijing(iso: string, withDate = false): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3600000);
  const p = (n: number) => String(n).padStart(2, "0");
  const md = `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return withDate ? `${d.getUTCFullYear()}-${md}` : md;
}
function fmtHours(min: number): string {
  return tr("admin.wr.hours", { n: (min / 60).toFixed(1) });
}

// 用户明细里的环比小箭头:较上周增长 ↑(浅红)、下降 ↓(浅绿)。颜色刻意调淡,
// 仅作辅助提示。prev 缺失(无上周数据/首周/加载中)或持平则不渲染。
function Delta({ cur, prev }: { cur: number; prev: number | undefined }) {
  const t = useT();
  if (prev === undefined || cur === prev) return null;
  const up = cur > prev;
  const diff = Math.round(Math.abs(cur - prev) * 10) / 10;
  return (
    <span className={`wr-delta ${up ? "up" : "down"}`} title={t("admin.wr.delta", { sign: up ? "+" : "−", diff })}>
      {up ? "↑" : "↓"}
    </span>
  );
}

// 访问门控由路由层 RequireAdminPage(pageKey="weekly-report")负责:管理员,或该页已在
// 「页面可见性」放开给所有成员。不再自拦 isAdmin(否则放开后成员会被弹走)。
export function AdminWeeklyReportDetailPage() {
  return <Inner />;
}

function Inner() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [snapshot, setSnapshot] = useState<WeeklyReportSnapshot | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 图表「用户维度」筛选:"all" 或某个 userId。
  const [scope, setScope] = useState<string>("all");
  // 实时动态分页(0-based)。导出时只取第一页(见 liveSlice)。
  const [livePage, setLivePage] = useState(0);
  const [exporting, setExporting] = useState(false);
  // 导出长图(PNG)进行中:截图是异步的,期间禁用按钮并显示「导出图片中…」。
  const [capturing, setCapturing] = useState(false);
  // 点击用户名 → 打开与数据看板一致的用户活动抽屉(管理员页,无权限顾虑)。
  const [userTarget, setUserTarget] = useState<UserActivityTarget | null>(null);
  // 上一周用户明细(userId → row),供环比箭头。null=未加载;空 Map=无上周数据。
  const [prevUsers, setPrevUsers] = useState<Map<string, WeeklyReportUserRow> | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.admin.weeklyReport.get(id);
        if (!cancelled) { setSnapshot(r.snapshot); setGeneratedAt(r.generatedAt); }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // 加载「上一周」周报快照(按 weekStart 往前 7 天匹配),用于用户明细环比箭头。
  // 找不到上周 / 请求失败都安静降级为「无上周数据」(空 Map → 不显示箭头)。
  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    const prevStartMs = new Date(snapshot.weekStart).getTime() - 7 * 24 * 3600 * 1000;
    void (async () => {
      try {
        const list = await api.admin.weeklyReport.list();
        const prev = list.reports.find((r) => Math.abs(new Date(r.weekStart).getTime() - prevStartMs) < 1000);
        if (!prev) { if (!cancelled) setPrevUsers(new Map()); return; }
        const detail = await api.admin.weeklyReport.get(prev.id);
        if (!cancelled) setPrevUsers(new Map(detail.snapshot.users.map((u) => [u.userId, u])));
      } catch {
        if (!cancelled) setPrevUsers(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, [snapshot]);

  const userDims = useMemo(() => snapshot?.userDimensions ?? [], [snapshot]);

  // Self-contained HTML of the rendered report (charts are SVG → serialize as-is)
  // + embedded stylesheet.
  function buildStandaloneHtml(): string | null {
    const root = document.getElementById("wr-root");
    if (!root) return null;
    return buildStandaloneReportHtml(t("admin.wr.reportTitle", { week: stripCnTz(snapshot?.weekLabel ?? "") }), root.outerHTML);
  }

  // 进入「导出渲染态」跑一次导出:实时动态只渲第一页、隐藏分页器(见 liveSlice 与下方
  // 分页器的 !exporting 判断)。flushSync 强制导出态 DOM 同步提交后再序列化,然后还原。
  function withExportView(run: () => void) {
    flushSync(() => setExporting(true));
    try { run(); } finally { flushSync(() => setExporting(false)); }
  }

  function exportHtml() {
    withExportView(() => {
      const html = buildStandaloneHtml();
      if (!html) return;
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${t("admin.wr.fileName", { key: snapshot?.weekKey ?? "report" })}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  function exportPdf() {
    withExportView(() => {
      const html = buildStandaloneHtml();
      if (!html) return;
      const w = window.open("", "_blank");
      if (!w) { toast.error(t("admin.wr.allowPopup")); return; }
      w.document.open();
      w.document.write(html);
      w.document.close();
      // Give the new doc a beat to lay out the inlined SVG charts, then print.
      setTimeout(() => { try { w.focus(); w.print(); } catch { /* user closed it */ } }, 400);
    });
  }

  // 导出长图:把整份 #wr-root 截成一张竖向长图(PNG)。html-to-image 会把含 recharts
  // SVG 的 DOM 整体序列化进 canvas(优于 html2canvas 对 SVG 的处理);同 PDF/HTML,
  // 实时动态只截第一页(后面几页不进导出)。截图是异步的,故不走同步的 withExportView。
  async function exportImage() {
    if (capturing) return;
    const root = document.getElementById("wr-root");
    if (!root) return;
    flushSync(() => { setCapturing(true); setExporting(true); });
    try {
      // 超长报告(用户多)按 1x 截,规避浏览器 canvas 高度上限把整图渲成空白;常规
      // 长度用 2x 更清晰。scrollHeight 在导出态(实时动态仅第一页)下读。
      const pixelRatio = root.scrollHeight > 8000 ? 1 : 2;
      const dataUrl = await toPng(root, { pixelRatio, backgroundColor: "#ffffff", cacheBust: true });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `${t("admin.wr.fileName", { key: snapshot?.weekKey ?? "report" })}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      toast.error(t("admin.wr.exportImgFailed", { msg: (e as Error).message }));
    } finally {
      flushSync(() => setExporting(false));
      setCapturing(false);
    }
  }

  if (loading) return <DelayedLoader />;
  if (error) return <div className="text-rose-600 text-sm">⚠ {error}</div>;
  if (!snapshot) return <div className="text-sm text-muted">{t("admin.wr.notFound")}</div>;

  const s = snapshot;
  const o = s.overview;
  const cards = [
    { label: t("admin.wr.s.activeUsers"), value: o.activeUsers, hint: t("admin.wr.activeHint") },
    { label: t("admin.wr.colDuration"), value: fmtHours(o.totalDurationMin), hint: t("admin.wr.durationHint") },
    { label: t("admin.wr.s.docCreate"), value: o.docCreate },
    { label: t("admin.wr.s.docEdit"), value: o.docEdit },
    { label: t("admin.wr.askAssistant", { name: getAssistantName() }), value: o.chat },
    { label: t("admin.wr.s.comment"), value: o.comment },
    { label: t("admin.wr.s.like"), value: o.like },
    { label: t("admin.wr.viewDoc"), value: o.view, hint: t("admin.wr.dedup") },
  ];

  // 图表数据按用户维度切换。
  const activeDim = scope === "all" ? null : userDims.find((d) => d.userId === scope) ?? null;
  // 「全部用户」且有用户维度数据时:折线 = 每位用户一条(当日活动量),饼图 = 各用户
  // 活动占比;否则(选了具体用户 / 旧快照无用户维度)走原来的「指标维度」。
  const perUserMode = scope === "all" && userDims.length > 0;
  const userSeries = userDims.slice(0, MAX_USER_SERIES).map((d, i) => ({
    userId: d.userId, name: d.name, color: PALETTE[i % PALETTE.length], dim: d,
  }));
  // 单用户某日活动量 = 当日 6 类可追踪行为之和(收藏/上传/会议未计入每日趋势)。
  const dayTotal = (t: WeeklyReportTrendPoint | undefined) =>
    t ? t.docCreate + t.docEdit + t.comment + t.like + t.chat + t.view : 0;

  // 折线:数据 + 系列。
  let lineData: ChartRow[];
  let lineSeries: Array<{ key: string; label: string; color: string }>;
  if (perUserMode) {
    lineData = s.trends.map((pt, di) => {
      const row: ChartRow = { day: pt.day };
      for (const u of userSeries) row[u.userId] = dayTotal(u.dim.trends[di]);
      return row;
    });
    lineSeries = userSeries.map((u) => ({ key: u.userId, label: u.name, color: u.color }));
  } else {
    const src = activeDim ? activeDim.trends : s.trends;
    lineData = src.map((t) => ({
      day: t.day, docCreate: t.docCreate, docEdit: t.docEdit, comment: t.comment,
      like: t.like, chat: t.chat, view: t.view, activeUsers: t.activeUsers,
    }));
    lineSeries = (scope === "all" ? TREND_SERIES : TREND_SERIES.filter((x) => x.key !== "activeUsers"))
      .map((x) => ({ key: x.key, label: t(x.label), color: x.color }));
  }

  // 饼图:数据(带颜色)。
  const pieData: Array<{ key: string; label: string; count: number; color: string }> = perUserMode
    ? userSeries
        .map((u) => ({ key: u.userId, label: u.name, count: u.dim.trends.reduce((n, t) => n + dayTotal(t), 0), color: u.color }))
        .filter((x) => x.count > 0)
    : (activeDim ? activeDim.composition : s.composition).map((c, i) => ({ ...c, color: PALETTE[i % PALETTE.length] }));

  const lineTitle = perUserMode ? t("admin.wr.lineByUser") : activeDim ? t("admin.wr.lineOf", { name: activeDim.name }) : t("admin.wr.lineChart");
  const pieTitle = perUserMode ? t("admin.wr.pieByUser") : activeDim ? t("admin.wr.pieOf", { name: activeDim.name }) : t("admin.wr.pieChart");
  const truncatedUsers = perUserMode && userDims.length > MAX_USER_SERIES;

  // 实时动态分页。
  const liveAll = s.liveActivity;
  const livePages = Math.max(1, Math.ceil(liveAll.length / LIVE_PAGE));
  const page = Math.min(livePage, livePages - 1);
  // 导出仅保留实时动态「第一页」(后面几页不进导出);页面浏览时按当前页分页。
  const liveSlice = exporting
    ? liveAll.slice(0, LIVE_PAGE)
    : liveAll.slice(page * LIVE_PAGE, page * LIVE_PAGE + LIVE_PAGE);

  return (
    <div className="flex flex-col gap-4">
      <style>{WEEKLY_REPORT_CSS}</style>

      {/* Toolbar — NOT part of the exported #wr-root. */}
      <div className="flex items-center justify-between gap-3">
        <BackButton to="/admin/weekly-report" label={t("admin.wr.back")} />
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={exportImage} disabled={capturing}>
            {capturing ? t("admin.wr.exportingImg") : t("admin.wr.exportImg")}
          </Button>
          <Button variant="ghost" size="sm" onClick={exportPdf}>{t("admin.wr.exportPdf")}</Button>
          <Button variant="ghost" size="sm" onClick={exportHtml}>{t("admin.wr.exportHtml")}</Button>
        </div>
      </div>

      <div id="wr-root" className="wr-root rounded-xl border border-line">
        <h1 className="wr-h1">{t("admin.wr.h1", { week: stripCnTz(s.weekLabel) })}</h1>
        <p className="wr-sub">{t("admin.wr.generatedAt", { time: fmtBeijing(generatedAt, true) })}</p>
        {s.summary && <p className="wr-summary">{stripCnTz(s.summary)}</p>}

        {/* 概览 */}
        <div className="wr-section">
          <div className="wr-section-title">{t("admin.wr.overview")}</div>
          <div className="wr-cards">
            {cards.map((c) => (
              <div key={c.label} className="wr-card">
                <div className="wr-card-label">{c.label}</div>
                <div className="wr-card-value">{c.value}</div>
                {c.hint && <div className="wr-card-hint">{c.hint}</div>}
              </div>
            ))}
          </div>
        </div>

        {/* 趋势 + 构成(可按用户维度筛选)*/}
        <div className="wr-section">
          <div className="wr-section-head">
            <div className="wr-section-title">{t("admin.wr.trendAndMix")}</div>
            {userDims.length > 0 && (
              <label className="wr-userpick">
                {t("admin.wr.userDim")}
                <select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="all">{t("admin.wr.allUsers")}</option>
                  {userDims.map((d) => (
                    <option key={d.userId} value={d.userId}>{d.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="wr-charts">
            <div className="wr-chart-box">
              <div className="wr-chart-title">{lineTitle}</div>
              <div className="wr-chart">
                <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 460, height: 280 }}>
                  <LineChart data={lineData} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f2f3f5" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #eef1f5" }} />
                    {lineSeries.map((ser) => (
                      <Line key={ser.key} type="monotone" dataKey={ser.key} name={ser.label}
                        stroke={ser.color} strokeWidth={2} dot={false} isAnimationActive={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="wr-legend">
                {lineSeries.map((ser) => (
                  <span key={ser.key}><i style={{ background: ser.color }} />{ser.label}</span>
                ))}
              </div>
              {truncatedUsers && <div className="wr-chart-note">{t("admin.wr.topUsersNote", { n: MAX_USER_SERIES })}</div>}
            </div>

            <div className="wr-chart-box">
              <div className="wr-chart-title">{pieTitle}</div>
              {pieData.length > 0 ? (
                <>
                  <div className="wr-chart">
                    <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 460, height: 280 }}>
                      <PieChart>
                        <Pie data={pieData} dataKey="count" nameKey="label" innerRadius="50%" outerRadius="78%" paddingAngle={1} isAnimationActive={false}>
                          {pieData.map((d) => <Cell key={d.key} fill={d.color} />)}
                        </Pie>
                        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #eef1f5" }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="wr-legend">
                    {pieData.map((d) => (
                      <span key={d.key}><i style={{ background: d.color }} />{d.label} · {d.count}</span>
                    ))}
                  </div>
                </>
              ) : <div className="wr-empty">{t("admin.wr.emptyDim")}</div>}
            </div>
          </div>
        </div>

        {/* 贡献榜 */}
        <div className="wr-section">
          <div className="wr-section-title">{t("admin.wr.topContrib")}</div>
          <div className="wr-chart-box">
            {s.topContributors.length > 0 ? (
              <div className="wr-chart" style={{ height: Math.max(180, s.topContributors.length * 30 + 30) }}>
                <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 900, height: 320 }}>
                  <BarChart data={s.topContributors} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f2f3f5" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={96} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #eef1f5" }} />
                    <Bar dataKey="contribution" name={t("admin.wr.contribution")} fill="#3370FF" radius={[0, 4, 4, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : <div className="wr-empty">{t("admin.wr.emptyContrib")}</div>}
          </div>
        </div>

        {/* 用户明细 */}
        <div className="wr-section">
          <div className="wr-section-title">{t("admin.wr.userDetail")}</div>
          {s.users.length > 0 ? (
            <div className="wr-table-wrap">
              <table className="wr-table">
                <thead>
                  <tr>
                    <th className="wr-rank">#</th>
                    <th>{t("admin.wr.colUser")}</th>
                    <th>{t("admin.wr.contribution")}</th>
                    <th>{t("admin.wr.colOnline")}</th>
                    <th>{t("admin.wr.colDays")}</th>
                    <th>{t("admin.wr.colNew")}</th>
                    <th>{t("admin.wr.colEdit")}</th>
                    <th>{t("admin.wr.colAsk")}</th>
                    <th>{t("admin.wr.s.comment")}</th>
                    <th>{t("admin.wr.s.like")}</th>
                    <th>{t("admin.wr.s.view")}</th>
                    <th>{t("admin.wr.colOpCount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.users.map((u, i) => {
                    const p = prevUsers?.get(u.userId);
                    return (
                    <tr key={u.userId}>
                      <td className="wr-rank">{i + 1}</td>
                      <td className="wr-name">
                        <button type="button" className="wr-userlink" onClick={() => setUserTarget({ id: u.userId, displayName: u.name })}>{u.name}</button>
                      </td>
                      <td>{u.contribution}<Delta cur={u.contribution} prev={p?.contribution} /></td>
                      <td>{fmtHours(u.durationMin)}<Delta cur={u.durationMin} prev={p?.durationMin} /></td>
                      <td>{u.activeDays}<Delta cur={u.activeDays} prev={p?.activeDays} /></td>
                      <td>{u.docCreate}<Delta cur={u.docCreate} prev={p?.docCreate} /></td>
                      <td>{u.docEdit}<Delta cur={u.docEdit} prev={p?.docEdit} /></td>
                      <td>{u.chat}<Delta cur={u.chat} prev={p?.chat} /></td>
                      <td>{u.comment}<Delta cur={u.comment} prev={p?.comment} /></td>
                      <td>{u.like}<Delta cur={u.like} prev={p?.like} /></td>
                      <td>{u.view}<Delta cur={u.view} prev={p?.view} /></td>
                      <td>{u.ops}<Delta cur={u.ops} prev={p?.ops} /></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <div className="wr-empty">{t("admin.wr.emptyUsers")}</div>}
        </div>

        {/* 实时动态汇总(页面分页 10/页;导出只取第一页)*/}
        <div className="wr-section">
          <div className="wr-section-title">{t("admin.wr.live")}</div>
          {liveAll.length > 0 ? (
            <>
              <ul className="wr-live">
                {liveSlice.map((it, i) => {
                  // const 绑定让 TS 在 onClick 闭包内保留 narrow(userId 为可选,旧快照可能无)。
                  const uid = it.userId;
                  return (
                    <li key={`${page}-${i}`}>
                      <span className="t">{fmtBeijing(it.at)}</span>
                      <span className="who">{uid ? <button type="button" className="wr-userlink" onClick={() => setUserTarget({ id: uid, displayName: it.name })}>{it.name}</button> : it.name}</span>
                      <span className="wr-badge">{it.label}</span>
                      <span className="ttl">{it.title ?? ""}</span>
                    </li>
                  );
                })}
              </ul>
              {!exporting && livePages > 1 && (
                <div className="wr-pager">
                  <button disabled={page === 0} onClick={() => setLivePage((p) => Math.max(0, p - 1))}>{t("admin.wr.prev")}</button>
                  <span>{t("admin.wr.pageOf", { page: page + 1, total: livePages })}</span>
                  <button disabled={page >= livePages - 1} onClick={() => setLivePage((p) => Math.min(livePages - 1, p + 1))}>{t("admin.wr.next")}</button>
                </div>
              )}
            </>
          ) : <div className="wr-empty">{t("admin.wr.emptyLive")}</div>}
        </div>
      </div>

      {userTarget && <UserActivityDrawer user={userTarget} onClose={() => setUserTarget(null)} />}
    </div>
  );
}
