// 「面向本人的事件完成」通知:自动化运行完成 / 会议纪要生成完成 /助手生图完成。
// 与文章互动通知(service.ts,通知的是【别人】的动作)不同,这里 recipient = 发起人自己,
// 无 actor/article。行照样落 Notification 表 → 站内铃铛可见;前端 WebNotifier 轮询到新行后
// 弹一条浏览器桌面通知(见 web/components/shell/WebNotifier.tsx)。
//
// 双层开关:① 管理后台全局(getWebNotifySettings)② 每用户静音(NotificationPref.mute*)。
// Web-only:feishuState 恒 "skipped",不进飞书出站通道。fire-and-forget:任何失败只吞掉,
// 绝不影响触发它的主流程。
import { prisma } from "../../db.js";
import { getWebNotifySettings, isKindEnabled, type WebNotifKind } from "./webNotifySettings.js";

export type WebNotifType = "automation_run" | "meeting_minutes" | "image_gen";

const KIND_OF: Record<WebNotifType, WebNotifKind> = {
  automation_run: "automation",
  meeting_minutes: "meeting",
  image_gen: "image",
};

const MUTE_FIELD: Record<WebNotifType, "muteAutomation" | "muteMeeting" | "muteImage"> = {
  automation_run: "muteAutomation",
  meeting_minutes: "muteMeeting",
  image_gen: "muteImage",
};

export interface SelfNotifyInput {
  userId: string;
  type: WebNotifType;
  title: string;
  body?: string;
  link?: string;      // 站内路径:/automation、/meeting/:id、/c/:id
  dedupeKey: string;  // 幂等键(automation:<runId> / meeting:<sessionId> / image:<msgId>)
}

/** 写一条本人事件完成通知(站内铃铛 + 前端浏览器桌面通知)。失败静默,绝不抛。 */
export async function emitSelfNotification(input: SelfNotifyInput): Promise<void> {
  try {
    const settings = await getWebNotifySettings();
    if (!isKindEnabled(settings, KIND_OF[input.type])) return; // 管理后台该类已关
    const pref = await prisma.notificationPref.findUnique({ where: { userId: input.userId } });
    if (pref?.[MUTE_FIELD[input.type]]) return;                // 用户静音该类 → 连铃铛都不写
    // 幂等:同 dedupeKey 已存在(纪要重生成 / 自动化重试 / 断线重放)→ 不重复写。
    const dup = await prisma.notification.findFirst({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
    if (dup) return;
    await prisma.notification.create({
      data: {
        recipientId: input.userId,
        actorId: null,
        type: input.type,
        payload: JSON.stringify({
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          ...(input.link ? { link: input.link } : {}),
        }),
        dedupeKey: input.dedupeKey,
        feishuState: "skipped", // web-only,不走飞书出站
      },
    });
  } catch {
    /* fire-and-forget:通知失败绝不影响主流程 */
  }
}
