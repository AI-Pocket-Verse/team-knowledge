import { describe, it, expect, vi } from "vitest";

// notify.ts(及其 import 链)间接 import env,mock 掉避免真实 env 校验介入。
// checkAndNotifyChangelog 的 DB / 发送依赖全部注入,单测不读库不发请求。
vi.mock("../../env.js", () => ({
  AUTH_API_BASE: "http://auth.invalid/api",
  env: {
    INTERNAL_API_TOKEN: "t",
    WEB_PUBLIC_URL: "http://gw.invalid/kb",
    FEISHU_CARD_USE_APPLINK: false,
  },
}));

import { CURRENT_VERSION, type ChangelogEntry } from "@team-knowledge/shared";
import { pickNewEntries, buildChangelogCard, checkAndNotifyChangelog } from "./notify.js";

const LOG: ChangelogEntry[] = [
  { version: "3.5.0", kind: "minor", date: "2026-06-11 21:30", items: ["A", "B"] },
  { version: "3.4.0", kind: "minor", items: ["C"] },
  { version: "3.3.0", kind: "patch", items: ["D"] },
];

const cardText = (card: unknown) =>
  (card as { elements: Array<{ text?: { content: string } }> }).elements.map((e) => e.text?.content ?? "").join("\n");

describe("changelog 版本播报", () => {
  it("pickNewEntries:无基线 → 只取最新 1 条(不回放历史)", () => {
    expect(pickNewEntries(LOG, null).map((e) => e.version)).toEqual(["3.5.0"]);
  });

  it("pickNewEntries:基线在表中 → 取比它新的全部;基线即最新 → 空", () => {
    expect(pickNewEntries(LOG, "3.3.0").map((e) => e.version)).toEqual(["3.5.0", "3.4.0"]);
    expect(pickNewEntries(LOG, "3.5.0")).toEqual([]);
  });

  it("pickNewEntries:基线不在表中(历史被精简)→ 只取最新 1 条", () => {
    expect(pickNewEntries(LOG, "0.9.0").map((e) => e.version)).toEqual(["3.5.0"]);
  });

  it("卡片:标题带最新版本,逐版本列条目(类型标签 + 日期),按钮跳关于页", () => {
    const card = buildChangelogCard(LOG.slice(0, 2)) as {
      header: { title: { content: string } };
      elements: Array<{ tag: string; text?: { content: string }; actions?: Array<{ url: string; text: { content: string } }> }>;
    };
    expect(Object.keys(card).sort()).toEqual(["config", "elements", "header"]);
    expect(card.header.title.content).toContain("v3.5.0");
    const text = cardText(card);
    expect(text).toContain("**v3.5.0（功能）**　2026-06-11 21:30");
    expect(text).toContain("· A");
    expect(text).toContain("**v3.4.0（功能）**"); // 无日期也正常
    expect(text).toContain("· C");
    const action = card.elements.find((e) => e.tag === "action");
    expect(action?.actions?.[0]?.text.content).toBe("查看更新日志");
    expect(action?.actions?.[0]?.url).toBe("http://gw.invalid/kb/about");
  });

  it("卡片:空条目兜底,标题不带悬空的「· v」", () => {
    const card = buildChangelogCard([]) as { header: { title: { content: string } } };
    expect(card.header.title.content).toBe("🚀 团队知识库已更新");
  });

  it("卡片:版本超上限时截断并标注剩余", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ version: `1.${6 - i}.0`, kind: "minor" as const, items: ["x"] }));
    const text = cardText(buildChangelogCard(many));
    expect(text).toContain("另有 2 个版本");
  });

  it("check:无基线 → 播最新版本到所有群,并推进基线", async () => {
    const send = vi.fn(async (_chatId: string, _card: unknown) => ({ messageId: "om" }));
    const setLast = vi.fn(async () => undefined);
    const r = await checkAndNotifyChangelog(undefined, {
      getLast: async () => null,
      setLast,
      getTargets: async () => ["oc_a", "oc_b"],
      send,
    });
    expect(r).toEqual({ sent: true, reason: "ok" });
    expect(setLast).toHaveBeenCalledWith(CURRENT_VERSION);
    expect(send.mock.calls.map((c) => c[0])).toEqual(["oc_a", "oc_b"]);
    const card = send.mock.calls[0]![1] as { header: { title: { content: string } } };
    expect(card.header.title.content).toContain(`v${CURRENT_VERSION}`);
  });

  it("check:基线已是最新 → 不发不写", async () => {
    const send = vi.fn();
    const setLast = vi.fn();
    const r = await checkAndNotifyChangelog(undefined, {
      getLast: async () => CURRENT_VERSION,
      setLast,
      getTargets: async () => ["oc_a"],
      send,
    });
    expect(r).toEqual({ sent: false, reason: "up_to_date" });
    expect(send).not.toHaveBeenCalled();
    expect(setLast).not.toHaveBeenCalled();
  });

  it("check:任务关闭/无目标群 → 不发、基线也不推进(之后开启 + 重启会补播,不会永远静默)", async () => {
    const send = vi.fn();
    const setLast = vi.fn(async () => undefined);
    const r = await checkAndNotifyChangelog(undefined, {
      getLast: async () => null,
      setLast,
      getTargets: async () => [],
      send,
    });
    expect(r).toEqual({ sent: false, reason: "disabled_or_no_target" });
    expect(setLast).not.toHaveBeenCalled(); // 不消耗:开关关着时该版本资格保留
    expect(send).not.toHaveBeenCalled();
  });

  it("check:基线在发送前推进(开关开着时),发送失败也不会重播", async () => {
    const order: string[] = [];
    const setLast = vi.fn(async () => { order.push("setLast"); });
    const send = vi.fn(async () => { order.push("send"); throw new Error("机器人不在群"); });
    const r = await checkAndNotifyChangelog(undefined, {
      getLast: async () => null,
      setLast,
      getTargets: async () => ["oc_a"],
      send,
    });
    expect(r.sent).toBe(true); // best-effort:单群失败只记日志
    expect(order[0]).toBe("setLast"); // 推进在发送之前 → 同一版本绝不二播
  });

  it("check:单群失败不影响其它群,也不抛错", async () => {
    const warn = vi.fn();
    const send = vi.fn(async (chatId: string) => {
      if (chatId === "oc_bad") throw new Error("机器人不在群");
      return { messageId: "om" };
    });
    const r = await checkAndNotifyChangelog({ warn }, {
      getLast: async () => null,
      setLast: async () => undefined,
      getTargets: async () => ["oc_bad", "oc_good"],
      send,
    });
    expect(r.sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
