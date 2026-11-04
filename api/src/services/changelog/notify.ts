// 版本播报:助手知识库的更新日志(CHANGELOG)新增版本后,自动向飞书群推送
// 一张「更新内容摘要」卡片,点按钮跳到关于页(/about)。
//
// 触发方式:更新日志随代码部署,所以在【服务启动时】对比 CHANGELOG[0].version 与
// 上次已播报的版本(存 Setting:changelog.lastNotifiedVersion):
//   - 有新版本 → 把「比基线新的一个或多个版本」打包成一张卡片发群,并推进基线;
//   - 无基线(首次上线本功能)→ 只播最新一个版本(不回放整个历史);
//   - 版本未变(常见:dev 下 tsx watch 频繁重启)→ 直接返回,绝不重复播。
// 基线在「确认开关开着且有目标群」之后、发送之前推进:同一版本只播一次,发送
// 失败不重播(best-effort,下个版本随下次部署再播);开关关着时不消耗基线,
// 之后开启 + 重启会把积压版本合并补播。目标群与开关由管理后台「飞书群通知」
// 配置(notify-config)。
import { CHANGELOG, type ChangelogEntry, type ChangelogKind } from "@team-knowledge/shared";
import { env } from "../../env.js";
import { feishuGateway } from "../../utils/feishuGateway.js";
import { applinkWrap } from "../../utils/notify/card.js";
import { getSetting, setSetting } from "../settings.js";
import { targetsIfEnabled } from "../notify-config/index.js";

const SETTING_KEY = "changelog.lastNotifiedVersion";
const MAX_VERSIONS = 5; // 一张卡片最多列几个版本,防止积压太多时卡片过长

const KIND_LABEL: Record<ChangelogKind, string> = { major: "大版本", minor: "功能", patch: "修复" };

/** 取「比上次播报新」的版本条目(changelog 新在前)。无基线/基线不在表中 → 只取
 *  最新 1 条(不回放历史);基线即最新 → 空数组。纯函数,便于单测。 */
export function pickNewEntries(changelog: ChangelogEntry[], lastNotified: string | null): ChangelogEntry[] {
  if (changelog.length === 0) return [];
  if (!lastNotified) return changelog.slice(0, 1);
  const idx = changelog.findIndex((e) => e.version === lastNotified);
  if (idx === -1) return changelog.slice(0, 1);
  return changelog.slice(0, idx);
}

/** 组装「知识库已更新」卡片:逐版本列出内容摘要 + 「查看更新日志」按钮(→ /about)。
 *  键限定 config/header/elements 以通过 feishu-sso 端 validCard 校验。 */
export function buildChangelogCard(entries: ChangelogEntry[]): unknown {
  const shown = entries.slice(0, MAX_VERSIONS);
  const elements: unknown[] = [];
  shown.forEach((e, i) => {
    if (i > 0) elements.push({ tag: "hr" });
    const head = `**v${e.version}（${KIND_LABEL[e.kind]}）**${e.date ? `　${e.date}` : ""}`;
    const items = e.items.map((it) => `· ${it}`).join("\n");
    elements.push({ tag: "div", text: { tag: "lark_md", content: `${head}\n${items}` } });
  });
  if (entries.length > shown.length) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: `…另有 ${entries.length - shown.length} 个版本,详见更新日志` } });
  }
  elements.push({
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "查看更新日志" },
        type: "primary",
        url: applinkWrap(`${env.WEB_PUBLIC_URL.replace(/\/$/, "")}/about`, env.FEISHU_CARD_USE_APPLINK),
      },
    ],
  });
  // entries 为空在线上路径不可达(调用方已 guard),但兜底别渲染出悬空的「· v」。
  const title = shown[0] ? `🚀 团队知识库已更新 · v${shown[0].version}` : `🚀 团队知识库已更新`;
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: title }, template: "blue" },
    elements,
  };
}

interface NotifyLog {
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  error?: (...a: unknown[]) => void;
}

/** 依赖均可注入(便于单测不读 DB / 不发真请求)。 */
export interface ChangelogNotifyDeps {
  getLast?: () => Promise<string | null>;
  setLast?: (version: string) => Promise<void>;
  getTargets?: () => Promise<string[]>;
  send?: (chatId: string, card: unknown) => Promise<unknown>;
}

export async function checkAndNotifyChangelog(
  log?: NotifyLog,
  deps: ChangelogNotifyDeps = {},
): Promise<{ sent: boolean; reason: string }> {
  const getLast = deps.getLast ?? (() => getSetting<string | null>(SETTING_KEY, null));
  const setLast = deps.setLast ?? ((v: string) => setSetting(SETTING_KEY, v, "system-boot"));
  const getTargets = deps.getTargets ?? (() => targetsIfEnabled("changelog"));
  const send = deps.send ?? feishuGateway.notifyChat;

  const latest = CHANGELOG[0];
  if (!latest) return { sent: false, reason: "empty_changelog" };

  const fresh = pickNewEntries(CHANGELOG, await getLast());
  if (fresh.length === 0) return { sent: false, reason: "up_to_date" };

  const targets = await getTargets();
  if (targets.length === 0) {
    // 开关关着/没有目标群:不推进基线 —— 推进了的话「部署时恰好没开开关」的
    // 版本就永远静默;留着基线,之后开启 + 下次重启会把积压版本合并补播
    // (一张卡片,最多 MAX_VERSIONS 条)。重复播报无虞:走到发送的前提是开关
    // 开着,而发送前(下一行)就推进基线。
    log?.info?.({ event: "changelog.notify.skipped", version: latest.version }, "changelog notify skipped (disabled or no target)");
    return { sent: false, reason: "disabled_or_no_target" };
  }

  // 发送前推进基线:同一版本只播一次(dev 下 tsx watch 重启频繁尤其重要),
  // 发送失败不重播(best-effort,下个版本随下次部署再播)。
  await setLast(latest.version);

  const card = buildChangelogCard(fresh);
  // 逐群 best-effort:某群失败(如机器人不在群)只记日志,不影响其它群。
  await Promise.all(
    targets.map((chatId) =>
      Promise.resolve(send(chatId, card)).catch((e) => {
        log?.warn?.({ err: (e as Error).message, chatId, version: latest.version }, "changelog feishu group notify failed");
      }),
    ),
  );
  log?.info?.(
    { event: "changelog.notify.sent", version: latest.version, versions: fresh.length, chats: targets.length },
    "changelog notified to feishu groups",
  );
  return { sent: true, reason: "ok" };
}
