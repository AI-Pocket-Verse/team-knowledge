import { useEffect, useMemo, useRef, useState } from "react";
import { uploadSrc, type ExpertSummary } from "@/lib/api";
import { CollapseChevron } from "@/components/ui/CollapseChevron";
import { useT } from "@/i18n";

// 马卡龙色系(柔和底 + 同色深字 + 同色描边),按角色稳定取色,各角色头像颜色不同。
const MACARON: { bg: string; fg: string; bd: string }[] = [
  { bg: "#FDE7EC", fg: "#D26A86", bd: "#F3B6C5" }, // 莓粉
  { bg: "#FFF3DA", fg: "#C28A36", bd: "#EFD49A" }, // 焦糖
  { bg: "#E6F4E6", fg: "#5AA15F", bd: "#BCDFBC" }, // 抹茶
  { bg: "#E2EEFB", fg: "#5283C0", bd: "#B6D2EF" }, // 海盐蓝
  { bg: "#F0E7FB", fg: "#8A66C0", bd: "#D4C0ED" }, // 香芋
  { bg: "#FFEAD9", fg: "#CF7B43", bd: "#F3C9A3" }, // 蜜桃
  { bg: "#DEF3F1", fg: "#3FA199", bd: "#AFDCD7" }, // 薄荷
  { bg: "#FBE6F3", fg: "#C065A0", bd: "#EEBEDD" }, // 樱花
];
function macaronOf(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return MACARON[h % MACARON.length]!;
}

// 头像:有上传图就用图;否则角色名首字 + 马卡龙底色 + 同色字 + 同色描边。
function Avatar({ name, keyId, avatarUrl, size = 26 }: { name: string; keyId: string; avatarUrl?: string | null; size?: number }) {
  if (avatarUrl) {
    return <img src={uploadSrc(avatarUrl)} alt={name} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  const m = macaronOf(keyId);
  const initial = name.trim().slice(0, 1) || "?";
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: m.bg, color: m.fg, border: `1.5px solid ${m.bd}` }}
    >
      {initial}
    </span>
  );
}

// 描述取自该专家「设定(instruction)」前 10 字(各角色不同);未设则不显示(不再用统一占位文案)。
function descOf(e: ExpertSummary): string {
  const s = e.instruction?.trim();
  if (!s) return "";
  return s.length > 10 ? s.slice(0, 10) : s;
}

// 选择条(WorkBuddy 视觉):已选专家以「头像 + 名称 + 描述」胶囊回显在输入框左下角,
// 尾部为项目通用的展开/收起 chevron(点击向上弹选择面板)。单选:不选=总台自答;
// 选一位=直接问该专家(面板里点别的替换,点已选取消)。
export function ExpertSelectorBar({ experts, value, onChange }: {
  experts: ExpertSummary[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 点选区域外关闭下拉。
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const byId = useMemo(() => new Map(experts.map((e) => [e.roleId, e])), [experts]);
  const filtered = q.trim() ? experts.filter((e) => e.name.includes(q.trim())) : experts;

  // 单选:点已选 → 取消;点别的 → 只选它(替换);选定后收起面板。
  function select(roleId: string) {
    onChange(value.includes(roleId) ? [] : [roleId]);
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative flex flex-wrap items-center gap-1.5">
      {/* 已选专家胶囊(单选 → 至多一个);尾部 chevron 点击重开选择面板 */}
      {value.map((id) => {
        const e = byId.get(id);
        if (!e) return null;
        const desc = descOf(e);
        return (
          <span key={id} className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-full border border-primary/40 bg-white pl-1 pr-1">
            <Avatar name={e.name} keyId={e.roleId} avatarUrl={e.avatarUrl} size={26} />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[12px] font-semibold text-fg">{t("chat.expertBar.suffix", { name: e.name })}</span>
              {desc && <span className="truncate text-[10px] text-muted">{desc}</span>}
            </span>
            <button
              type="button"
              aria-label={t("chat.expertBar.pick")}
              onClick={() => setOpen((v) => !v)}
              className="flex h-5 w-5 shrink-0 items-center justify-center self-center rounded text-muted hover:text-fg"
            >
              <CollapseChevron open={open} />
            </button>
          </span>
        );
      })}

      {/* 无选时的触发按钮 */}
      {value.length === 0 && (
        <button
          type="button"
          aria-label={t("chat.expertBar.pick")}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-8 items-center gap-1 rounded-full border border-primary bg-accent-soft px-3 text-xs text-primary transition hover:opacity-90"
        >
          {t("chat.expertBar.pickButton")} <CollapseChevron open={open} className="h-3.5 w-3.5" />
        </button>
      )}

      {/* 选择面板:向上弹,头像 + 名称 + 描述 + 勾选 */}
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-56 rounded-xl border border-line bg-white p-1.5 shadow-glassLg">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("chat.expertBar.searchPlaceholder")}
            className="mb-1.5 w-full rounded-lg border border-line px-2.5 py-1.5 text-xs outline-none focus:border-primary"
          />
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted">{t("chat.expertBar.empty")}</p>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {filtered.map((e) => {
                const on = value.includes(e.roleId);
                const desc = descOf(e);
                return (
                  <button
                    key={e.roleId}
                    type="button"
                    onClick={() => select(e.roleId)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${on ? "bg-accent-soft" : "hover:bg-surface"}`}
                  >
                    <Avatar name={e.name} keyId={e.roleId} avatarUrl={e.avatarUrl} size={32} />
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate text-sm font-medium text-fg">{t("chat.expertBar.suffix", { name: e.name })}</span>
                      {desc && <span className="truncate text-[11px] text-muted">{desc}</span>}
                    </span>
                    <span className={`ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[11px] ${on ? "bg-primary text-white" : "border border-line text-transparent"}`}>✓</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
