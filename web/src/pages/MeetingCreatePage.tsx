import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { FolderVisibility, MeetingConfig } from "@team-knowledge/shared";
import { api, ApiError } from "@/lib/api";
import { useMeetingBadge } from "@/stores/meetingBadge";
import { toast } from "@/components/Toaster";
import { DelayedLoader } from "@/components/DelayedLoader";
import { BackButton } from "@/components/ui/BackButton";
import { cn } from "@/lib/cn";
import { resolveRoleColor } from "@/lib/roleColors";
import { getAssistantName } from "@/lib/assistantName";
import { useT } from "@/i18n";

// Open to any logged-in user (incl. role-less). Visibility (public/private)
// controls who can see the meeting, not who can create it. assistant's retrieval
// scope (roles) is optional — empty = public docs only.
//
// On successful create:
//   1. write the joinable link to clipboard (best-effort — failures
//      are silent, the navigate still happens),
//   2. navigate to /meeting/<id> (live room),
//   3. show a toast confirming the clipboard copy.
//
// The form's config defaults are the product defaults — adjustable
// inline once the live room exists.
export function MeetingCreatePage() {
  const t = useT();
  const navigate = useNavigate();

  const [roles, setRoles] = useState<{ id: string; name: string; color: string | null }[] | null>(null);
  const [rolesError, setRolesError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<FolderVisibility>("public");
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set());
  const [config, setConfig] = useState<MeetingConfig>({
    tts: true,
    recording: true,
    // Default 1 msg / 5 min matches the pre-wheel behavior. Admins
    // can relax via the linked-wheel picker in the form below.
    freqLimitMinutes: 5,
    freqLimitMessages: 1,
    triggerSilence: true,
    triggerKeyword: true,
    triggerProactive: true,
    durationHintHours: 4,
    style: "neutral",
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.workspace.listRoles();
        if (!alive) return;
        setRoles(r.roles);
        // Default: every visible role checked. assistant usually wants the full
        // corpus the asker can see; opting out is the rarer choice. A role-less
        // host's retrieval collapses to public docs regardless of what's checked.
        setSelectedRoles(new Set(r.roles.map((x) => x.id)));
      } catch (e) {
        if (alive) setRolesError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, []);

  function toggleRole(id: string) {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function patchConfig(p: Partial<MeetingConfig>) {
    setConfig((prev) => ({ ...prev, ...p }));
  }

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed) {
      toast.error(t("meeting.create.needTitle"));
      return;
    }
    setSubmitting(true);
    try {
      const r = await api.meeting.create({
        title: trimmed,
        allowedRoleIds: Array.from(selectedRoles),
        visibility,
        config,
      });
      const sessionId = r.session.id;
      // Light the left rail's active-meeting dot immediately (don't wait 90s).
      useMeetingBadge.getState().refresh();
      const url = `${window.location.origin}/meeting/${sessionId}`;
      // Best-effort clipboard copy. Some browsers reject clipboard
      // writes outside user-gesture stacks even though we ARE in one;
      // we ignore the error so navigation still happens.
      try { await navigator.clipboard.writeText(url); toast.success(t("meeting.create.linkCopied")); } catch { /* ignore */ }
      navigate(`/meeting/${sessionId}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error(e.message);
      } else {
        toast.error((e as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="rounded-xl border border-line bg-white p-6 shadow-glass">
        {/* 返回图标放标题左侧(与自动化二级页面统一) */}
        <div className="flex items-center gap-3">
          <BackButton to="/meeting" label={t("meeting.create.back")} />
          <h1 className="text-lg font-semibold text-fg">{t("meeting.create.title")}</h1>
        </div>

        <div className="mt-5 flex flex-col gap-5">
          <Field label={t("meeting.create.topic")} required>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder={t("meeting.create.topicPlaceholder")}
              className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-fg outline-none focus:border-primary"
            />
          </Field>

          <Field label={t("meeting.create.visibility")}>
            <div className="flex flex-col gap-2">
              {([
                { v: "public" as const, label: t("meeting.create.public"), desc: t("meeting.create.publicDesc") },
                { v: "private" as const, label: t("meeting.create.private"), desc: t("meeting.create.privateDesc") },
              ]).map((o) => (
                <label key={o.v} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition hover:bg-surface">
                  <input
                    type="radio"
                    name="visibility"
                    checked={visibility === o.v}
                    onChange={() => setVisibility(o.v)}
                    className="mt-0.5 h-4 w-4 accent-primary"
                  />
                  <span><span className="font-medium">{o.label}</span><span className="ml-2 text-xs text-muted">{o.desc}</span></span>
                </label>
              ))}
            </div>
          </Field>

          <Field label={t("meeting.create.scope", { name: getAssistantName() })}>
            {rolesError && <div className="text-sm text-rose-600">{rolesError}</div>}
            {!roles && !rolesError && <DelayedLoader />}
            {roles && roles.length === 0 && (
              <div className="text-sm text-muted">{t("meeting.create.noRoles")}</div>
            )}
            {roles && roles.length > 0 && (
              <ul className="flex flex-col gap-1">
                {roles.map((r) => (
                  <li key={r.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition hover:bg-surface">
                      <input
                        type="checkbox"
                        checked={selectedRoles.has(r.id)}
                        onChange={() => toggleRole(r.id)}
                        className="h-4 w-4 accent-primary"
                      />
                      {/* r.color from the API is a palette KEY
                          (e.g. "violet" / "rose" / "amber"), not a
                          CSS color. Feeding it directly into
                          backgroundColor used to silently render no
                          dot for any key that wasn't also a valid
                          CSS keyword — roles like "运营" (rose) lost
                          their swatch entirely. Resolve through the
                          palette so every role gets its actual hex. */}
                      <span
                        aria-hidden
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: resolveRoleColor(r.color).from }}
                      />
                      <span>{r.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-xs text-muted">
              {t("meeting.create.scopeHint1", { name: getAssistantName() })}
              {t("meeting.create.scopeHint2")}
            </p>
          </Field>

          <div className="rounded-lg border border-line bg-surface px-4 py-3">
            <div className="mb-2 text-sm font-medium text-fg">{t("meeting.create.options")}</div>
            <ul className="flex flex-col gap-2 text-sm">
              <li>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={config.recording}
                    onChange={(e) => patchConfig({ recording: e.target.checked })}
                    className="h-4 w-4 accent-primary"
                  />
                  <span>{t("meeting.create.optRecording")}</span>
                </label>
              </li>
              <li>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={config.tts}
                    onChange={(e) => patchConfig({ tts: e.target.checked })}
                    className="h-4 w-4 accent-primary"
                  />
                  <span>{t("meeting.create.optTts", { name: getAssistantName() })}</span>
                </label>
              </li>
              <li>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={config.triggerKeyword}
                    onChange={(e) => patchConfig({ triggerKeyword: e.target.checked })}
                    className="h-4 w-4 accent-primary"
                  />
                  <span>{t("meeting.create.optKeyword")}</span>
                </label>
              </li>
              <li>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={config.triggerSilence}
                    onChange={(e) => patchConfig({ triggerSilence: e.target.checked })}
                    className="h-4 w-4 accent-primary"
                  />
                  <span>{t("meeting.create.optSilence")}</span>
                </label>
              </li>
              <li>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={config.triggerProactive}
                    onChange={(e) => patchConfig({ triggerProactive: e.target.checked })}
                    className="h-4 w-4 accent-primary"
                  />
                  <span>{t("meeting.create.optProactive")}</span>
                </label>
              </li>
              <li className="flex flex-col gap-2">
                <span>{t("meeting.create.freq")}</span>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted">{t("meeting.create.freqEvery")}</span>
                  <Wheel
                    ariaLabel={t("meeting.create.freqMinutes")}
                    items={MINUTE_OPTIONS}
                    value={config.freqLimitMinutes}
                    onChange={(v) => patchConfig({ freqLimitMinutes: v })}
                  />
                  <span className="text-sm text-muted">{t("meeting.create.freqAtMost")}</span>
                  <Wheel
                    ariaLabel={t("meeting.create.freqCount")}
                    items={MESSAGE_OPTIONS}
                    value={config.freqLimitMessages}
                    onChange={(v) => patchConfig({ freqLimitMessages: v })}
                  />
                  <span className="text-sm text-muted">{t("meeting.create.freqUnit")}</span>
                </div>
              </li>
              <li className="flex items-center gap-2">
                <span>{t("meeting.create.duration")}</span>
                <select
                  value={config.durationHintHours}
                  onChange={(e) => patchConfig({ durationHintHours: Number(e.target.value) })}
                  className="rounded-lg border border-line bg-white px-2 py-1 text-sm text-fg outline-none focus:border-primary"
                >
                  {[1, 2, 4, 8].map((n) => (
                    <option key={n} value={n}>{t("meeting.create.durationOption", { n })}</option>
                  ))}
                </select>
              </li>
            </ul>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Link
              to="/meeting"
              className="rounded-lg border border-line bg-white px-4 py-2 text-sm text-fg transition hover:bg-surface"
            >
              {t("common.cancel")}
            </Link>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting || title.trim().length === 0}
              className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-medium text-white shadow-glass transition enabled:hover:bg-rose-500/90 enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? t("meeting.create.creating") : t("meeting.create.start")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-fg">
        {label}
        {required && <span className="ml-1 text-rose-500">*</span>}
      </label>
      {children}
    </div>
  );
}

// ─── Frequency-limit wheels ─────────────────────────────────
// iOS-style snap-scroll picker. Item height is fixed so we can map
// scrollTop → selected index in O(1). 3 rows visible — center row
// is the selected one, the other two are the previous/next neighbors
// peeking above and below. Top/bottom padding equals one item height
// so the first and last entries can still scroll into the center band.
const WHEEL_ITEM_H = 36;
const WHEEL_VISIBLE = 3;
const WHEEL_PAD = ((WHEEL_VISIBLE - 1) / 2) * WHEEL_ITEM_H;
const MINUTE_OPTIONS = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60] as const;
const MESSAGE_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10] as const;

function Wheel({
  items, value, onChange, ariaLabel,
}: {
  items: readonly number[];
  value: number;
  onChange: (v: number) => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<number | null>(null);

  // Sync scroll position whenever the external value changes — incl.
  // the initial mount. useLayoutEffect (not useEffect) so the snap
  // happens BEFORE paint, otherwise the wheel briefly shows row 0
  // and jumps to the right value on the next frame.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const idx = items.indexOf(value);
    if (idx < 0) return;
    el.scrollTop = idx * WHEEL_ITEM_H;
  }, [value, items]);

  function onScroll() {
    // Debounce so rapid scroll events (and the smooth-scroll
    // animation we kick off below) don't recursively trigger
    // onChange. We commit the selection ~120ms after the user stops
    // moving the wheel — feels responsive, doesn't fight inertia.
    if (settleTimer.current !== null) {
      window.clearTimeout(settleTimer.current);
    }
    settleTimer.current = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const idx = Math.round(el.scrollTop / WHEEL_ITEM_H);
      const clamped = Math.max(0, Math.min(items.length - 1, idx));
      const next = items[clamped]!;
      // Snap-precise even if the user released between two rows.
      const targetTop = clamped * WHEEL_ITEM_H;
      if (Math.abs(el.scrollTop - targetTop) > 1) {
        el.scrollTo({ top: targetTop, behavior: "smooth" });
      }
      if (next !== value) onChange(next);
    }, 120);
  }

  return (
    <div className="relative">
      {/* Selection band — fixed in the middle of the viewport so
          the highlighted item is always visually anchored even as
          rows scroll behind it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 z-10 border-y border-primary/40 bg-primary/5"
        style={{ top: WHEEL_PAD, height: WHEEL_ITEM_H }}
      />
      <div
        ref={ref}
        role="listbox"
        aria-label={ariaLabel}
        onScroll={onScroll}
        className="w-[64px] overflow-y-auto rounded-md border border-line bg-white text-sm [&::-webkit-scrollbar]:hidden [scrollbar-width:none] snap-y snap-mandatory"
        style={{ height: WHEEL_VISIBLE * WHEEL_ITEM_H }}
      >
        <div style={{ height: WHEEL_PAD }} />
        {items.map((it) => (
          <button
            key={it}
            type="button"
            role="option"
            aria-selected={it === value}
            onClick={() => onChange(it)}
            className={cn(
              "flex w-full snap-center items-center justify-center transition-colors",
              it === value ? "font-semibold text-primary" : "text-fg/50",
            )}
            style={{ height: WHEEL_ITEM_H }}
          >
            {it}
          </button>
        ))}
        <div style={{ height: WHEEL_PAD }} />
      </div>
    </div>
  );
}
