// Web(浏览器桌面)通知的「管理后台全局开关」。每类「事件完成」通知(自动化 /
// 会议纪要 /助手生图)可由管理员统一开关;master 关掉则全部不发。
// 全局开关决定「是否写这条通知(站内铃铛 + 桌面弹窗)」;每用户的接收/静音与浏览器
// 授权是另一层(见 NotificationPref + 前端 WebNotifier)。存 Setting KV 单行 JSON。
import { getSetting, setSetting } from "../../services/settings.js";

export type WebNotifKind = "automation" | "meeting" | "image";

export interface WebNotifySettings {
  /** 总开关:关掉则三类都不发。 */
  enabled: boolean;
  automation: boolean; // 自动化任务运行完成
  meeting: boolean;    // 会议纪要生成完成
  image: boolean;      //助手生图完成
}

const KEY = "webnotify.settings";
const DEFAULTS: WebNotifySettings = { enabled: true, automation: true, meeting: true, image: true };

function normalize(raw: Partial<WebNotifySettings> | null | undefined): WebNotifySettings {
  const b = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    enabled: b(raw?.enabled, DEFAULTS.enabled),
    automation: b(raw?.automation, DEFAULTS.automation),
    meeting: b(raw?.meeting, DEFAULTS.meeting),
    image: b(raw?.image, DEFAULTS.image),
  };
}

export async function getWebNotifySettings(): Promise<WebNotifySettings> {
  return normalize(await getSetting<Partial<WebNotifySettings> | null>(KEY, null));
}

export async function setWebNotifySettings(patch: Partial<WebNotifySettings>, updatedBy: string): Promise<WebNotifySettings> {
  const current = await getWebNotifySettings();
  const next = normalize({ ...current, ...patch });
  await setSetting(KEY, next, updatedBy);
  return next;
}

/** 该类事件此刻是否允许发 Web 通知(总开关 + 该类开关)。 */
export function isKindEnabled(s: WebNotifySettings, kind: WebNotifKind): boolean {
  return s.enabled && s[kind];
}
