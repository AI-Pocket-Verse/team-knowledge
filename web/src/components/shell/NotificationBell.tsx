import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, Settings, Zap, FileText, ImageIcon } from "lucide-react";
import { api, type NotificationItem, type NotificationPrefs } from "@/lib/api";
import { useNotifyBadge } from "@/stores/notifyBadge";
import { formatTimestamp } from "@/lib/format";
import { notifySupported, notifyPermission, requestNotifyPermission } from "@/lib/webNotify";
import { toast } from "@/components/Toaster";
import { tr, useT } from "@/i18n";

// Header bell: polls the unread count, and on open lazily loads the list.
// Clicking an item jumps to the doc (with a #comment anchor when relevant) and
// marks it read. Mirrors UserMenu's outside-click / Esc dismissal.
const VERB: Record<string, string> = {
  get article_like() { return tr("shell.bell.verb.article_like"); },
  get article_favorite() { return tr("shell.bell.verb.article_favorite"); },
  get article_comment() { return tr("shell.bell.verb.article_comment"); },
  get comment_reply() { return tr("shell.bell.verb.comment_reply"); },
  get comment_mention() { return tr("shell.bell.verb.comment_mention"); },
  get article_review_issue() { return tr("shell.bell.verb.article_review_issue"); },
};

// Web(事件完成)通知类:自带 title/body/link,渲染成「图标 + 标题 + 正文」而非
// 「头像 + 谁 + 动作 + 《文档》」。图标按类型区分。
const WEB_ICON: Record<string, typeof Zap> = {
  automation_run: Zap,
  meeting_minutes: FileText,
  image_gen: ImageIcon,
};
function isWebNotif(n: NotificationItem): boolean {
  return n.type in WEB_ICON;
}

export function NotificationBell() {
  const t = useT();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 页面侧最近一次权威推送的时间戳:比它更早发起的轮询结果作废,防止
  // 在途的旧 count 把刚清掉的红点闪回来(打开文章清红点 vs 30s 轮询竞态)。
  const lastPushAtRef = useRef(0);
  const refreshCount = useCallback(() => {
    const startedAt = Date.now();
    api.notifications.unreadCount().then((r) => {
      if (startedAt < lastPushAtRef.current) return;
      setUnread(r.count);
    }).catch(() => {});
  }, []);

  // Poll the unread badge (cheap count query). 30s cadence.
  useEffect(() => {
    refreshCount();
    const t = window.setInterval(refreshCount, 30_000);
    return () => window.clearInterval(t);
  }, [refreshCount]);

  // 页面侧推来的权威未读数(如文章详情页打开后把该文章的通知标记已读)
  // —— 红点立即同步,不等上面的 30s 轮询。
  const pushedNonce = useNotifyBadge((s) => s.nonce);
  const pushedUnread = useNotifyBadge((s) => s.unread);
  useEffect(() => {
    if (pushedUnread !== null) {
      lastPushAtRef.current = Date.now();
      setUnread(pushedUnread);
    }
  }, [pushedNonce, pushedUnread]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setLoading(true);
      try {
        const r = await api.notifications.list();
        setItems(r.notifications);
      } catch {
        /* keep whatever we had; the bell still closes/opens */
      } finally {
        setLoading(false);
      }
    }
  }

  function openItem(n: NotificationItem) {
    setOpen(false);
    if (!n.readAt) {
      api.notifications.markRead([n.id]).then((r) => setUnread(r.unread)).catch(() => {});
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
    }
    // Web 通知带站内跳转链接(/automation、/meeting/:id、/c/:id);文章互动跳文档 + 评论锚点。
    if (n.link) nav(n.link);
    else if (n.articleId) nav(`/d/${n.articleId}${n.commentId ? `#comment-${n.commentId}` : ""}`);
  }

  function markAll() {
    // Reconcile the badge from the server if the mark-read call fails, so the
    // optimistic patch below can't leave the count permanently out of sync.
    api.notifications.markRead().then((r) => setUnread(r.unread)).catch(() => refreshCount());
    setItems((prev) => prev.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })));
  }

  function togglePrefs() {
    const next = !showPrefs;
    setShowPrefs(next);
    if (next && !prefs) api.notifications.getPrefs().then(setPrefs).catch(() => {});
  }
  function updatePref(patch: Partial<NotificationPrefs>) {
    setPrefs((p) => (p ? { ...p, ...patch } : p));
    api.notifications.setPrefs(patch).then(setPrefs).catch(() => {});
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={t("shell.bell.title")}
        title={t("shell.bell.title")}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-primary"
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute right-0.5 top-0.5 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-medium leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-line bg-white py-2 shadow-glassLg">
          <div className="flex items-center justify-between px-4 pb-2 pt-1">
            <span className="text-sm font-semibold text-fg">{showPrefs ? t("shell.bell.settings") : t("shell.bell.title")}</span>
            <div className="flex items-center gap-2">
              {!showPrefs && unread > 0 && (
                <button type="button" onClick={markAll} className="text-xs text-muted transition hover:text-primary">
                  {t("shell.bell.markAll")}
                </button>
              )}
              <button
                type="button"
                onClick={togglePrefs}
                aria-label={t("shell.bell.settings")}
                title={t("shell.bell.settings")}
                className={`flex h-6 w-6 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-primary ${showPrefs ? "bg-accent-soft text-primary" : ""}`}
              >
                <Settings className="h-[14px] w-[14px]" />
              </button>
            </div>
          </div>
          {showPrefs ? (
            <PrefsPanel prefs={prefs} onChange={updatePref} />
          ) : (
          <div className="max-h-[60vh] overflow-auto">
            {loading ? (
              <div className="px-4 py-6 text-center text-sm text-muted">{t("common.loading")}</div>
            ) : items.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted">{t("shell.bell.empty")}</div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openItem(n)}
                  className={`flex w-full gap-2.5 px-4 py-2.5 text-left transition hover:bg-surface ${n.readAt ? "" : "bg-accent-soft"}`}
                >
                  {isWebNotif(n) ? <WebNotifIcon type={n.type} /> : <Avatar name={n.actorName} url={n.actorAvatarUrl} />}
                  <span className="min-w-0 flex-1">
                    {isWebNotif(n) ? (
                      <>
                        <span className="block text-sm font-medium text-fg">{n.title ?? t("shell.bell.newActivity")}</span>
                        {n.body && <span className="block truncate text-xs text-muted">{n.body}</span>}
                      </>
                    ) : (
                      <>
                        <span className="block text-sm text-fg">
                          <span className="font-medium">{n.actorName}</span> {VERB[n.type] ?? t("shell.bell.newActivity")}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {t("shell.bell.docRef", { title: n.articleTitle })}{n.excerpt ? ` ${n.excerpt}` : ""}
                        </span>
                      </>
                    )}
                    <span className="mt-0.5 block text-[11px] text-muted/80">{formatTimestamp(n.createdAt)}</span>
                  </span>
                  {!n.readAt && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-rose-500" />}
                </button>
              ))
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
}

function PrefsPanel({
  prefs,
  onChange,
}: {
  prefs: NotificationPrefs | null;
  onChange: (patch: Partial<NotificationPrefs>) => void;
}) {
  const t = useT();
  if (!prefs) return <div className="px-4 py-6 text-center text-sm text-muted">{t("common.loading")}</div>;
  // mute* store the INVERSE of "receive" — present each as a "接收" switch.
  const rows: Array<{ label: string; checked: boolean; toggle: (on: boolean) => Partial<NotificationPrefs> }> = [
    { label: t("shell.bell.pref.comments"), checked: !prefs.muteComments, toggle: (on) => ({ muteComments: !on }) },
    { label: t("shell.bell.pref.likes"), checked: !prefs.muteLikes, toggle: (on) => ({ muteLikes: !on }) },
    { label: t("shell.bell.pref.favorites"), checked: !prefs.muteFavorites, toggle: (on) => ({ muteFavorites: !on }) },
    { label: t("shell.bell.pref.feishu"), checked: prefs.feishuEnabled, toggle: (on) => ({ feishuEnabled: on }) },
  ];
  // 事件完成类(Web 通知):自动化 / 会议纪要 / 生图。同样以「接收」开关呈现(存的是 mute 反值)。
  const webRows: Array<{ label: string; checked: boolean; toggle: (on: boolean) => Partial<NotificationPrefs> }> = [
    { label: t("shell.bell.pref.automation"), checked: !prefs.muteAutomation, toggle: (on) => ({ muteAutomation: !on }) },
    { label: t("shell.bell.pref.meeting"), checked: !prefs.muteMeeting, toggle: (on) => ({ muteMeeting: !on }) },
    { label: t("shell.bell.pref.image"), checked: !prefs.muteImage, toggle: (on) => ({ muteImage: !on }) },
  ];

  // 打开「浏览器桌面通知」总开关时主动申请授权;被系统拒绝则给出指引。
  async function onToggleWeb(on: boolean) {
    onChange({ webEnabled: on });
    if (on && notifySupported()) {
      const perm = await requestNotifyPermission();
      if (perm === "denied") toast.error(t("shell.bell.blocked"));
    }
  }
  const perm = notifyPermission();

  return (
    <div className="px-2 py-1">
      {rows.map((r) => (
        <label key={r.label} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm hover:bg-surface">
          <span className="text-fg">{r.label}</span>
          <input
            type="checkbox"
            checked={r.checked}
            onChange={(e) => onChange(r.toggle(e.target.checked))}
            className="accent-primary"
          />
        </label>
      ))}

      {/* 浏览器桌面通知 */}
      <div className="mt-1 border-t border-line pt-1">
        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm hover:bg-surface">
          <span className="text-fg">{t("shell.bell.pref.desktop")}</span>
          <input
            type="checkbox"
            checked={prefs.webEnabled}
            onChange={(e) => void onToggleWeb(e.target.checked)}
            className="accent-primary"
          />
        </label>
        {prefs.webEnabled && webRows.map((r) => (
          <label key={r.label} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2 pl-4 text-sm hover:bg-surface">
            <span className="text-muted">{r.label}</span>
            <input
              type="checkbox"
              checked={r.checked}
              onChange={(e) => onChange(r.toggle(e.target.checked))}
              className="accent-primary"
            />
          </label>
        ))}
        {prefs.webEnabled && notifySupported() && perm !== "granted" && (
          <button
            type="button"
            onClick={() => void requestNotifyPermission().then((p) => { if (p === "denied") toast.error(t("shell.bell.blocked")); })}
            className="mx-2 mt-1 block text-[11px] text-primary underline"
          >
            {perm === "denied" ? t("shell.bell.deniedHow") : t("shell.bell.allow")}
          </button>
        )}
      </div>

      <p className="px-2 pb-1 pt-1.5 text-[11px] text-muted">
        {t("shell.bell.prefsHelp")}
      </p>
    </div>
  );
}

function WebNotifIcon({ type }: { type: string }) {
  const Icon = WEB_ICON[type] ?? Bell;
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-primary">
      <Icon className="h-[15px] w-[15px]" />
    </div>
  );
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  if (url) return <img src={url} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />;
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-primary">
      {name.slice(0, 1)}
    </div>
  );
}
