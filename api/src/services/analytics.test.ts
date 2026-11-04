import { describe, it, expect } from "vitest";
import { bucketTrends, bucketUploadTypes, scoreHotDocs } from "./analytics.js";
import type { ActivityEvent } from "./activity.js";
import type { AdminActivityType } from "@team-knowledge/shared";

function ev(type: AdminActivityType, at: Date): ActivityEvent {
  return { id: `${type}-${at.getTime()}-${Math.random()}`, uid: "u", at, type, title: null };
}

describe("bucketTrends", () => {
  it("counts events by type and day, aligned to dayKeys; ignores out-of-window", () => {
    const dayKeys = ["2026-06-05", "2026-06-06", "2026-06-07"];
    const d = (s: string) => new Date(`${s}T10:00:00+08:00`); // 北京时间 10:00 → beijingDayKey == s
    const events = [
      ev("doc_create", d("2026-06-05")),
      ev("doc_create", d("2026-06-07")),
      ev("comment", d("2026-06-07")),
      ev("like", d("2026-06-06")),
      ev("doc_create", d("2026-06-01")), // out of window → dropped
    ];
    const t = bucketTrends(events, dayKeys);
    expect(t.docCreate).toEqual([1, 0, 1]);
    expect(t.comment).toEqual([0, 0, 1]);
    expect(t.like).toEqual([0, 1, 0]);
    expect(t.meeting).toEqual([0, 0, 0]);
  });

  it("按北京日分桶：北京 00:30 的事件归当天，与服务器时区无关", () => {
    // 2026-06-06T16:30Z = 北京 06-07 00:30；按 UTC 日会被归到 06-06。
    const t = bucketTrends([ev("doc_create", new Date("2026-06-06T16:30:00Z"))], ["2026-06-06", "2026-06-07"]);
    expect(t.docCreate).toEqual([0, 1]);
  });

  it("returns all eight series with the right length even when empty", () => {
    const t = bucketTrends([], ["2026-06-07"]);
    for (const key of ["docCreate", "docEdit", "comment", "like", "bookmark", "upload", "chat", "meeting"] as const) {
      expect(t[key]).toEqual([0]);
    }
  });
});

describe("bucketUploadTypes", () => {
  it("buckets mime types into image / document / other and always returns all three", () => {
    const out = bucketUploadTypes([
      { mimeType: "image/png", count: 3 },
      { mimeType: "image/jpeg", count: 2 },
      { mimeType: "application/pdf", count: 4 },
      { mimeType: "text/plain", count: 1 },
      { mimeType: "application/octet-stream", count: 5 },
    ]);
    const get = (k: string) => out.find((o) => o.key === k)!.count;
    expect(get("image")).toBe(5);
    expect(get("document")).toBe(5);
    expect(get("other")).toBe(5);
    expect(out).toHaveLength(3);
  });

  it("returns zeroed buckets for no rows", () => {
    expect(bucketUploadTypes([])).toEqual([
      { key: "image", count: 0 },
      { key: "document", count: 0 },
      { key: "other", count: 0 },
    ]);
  });
});

describe("scoreHotDocs", () => {
  it("weights interactions over views (view×1 + like×2 + comment×3 + bookmark×2) and sorts desc", () => {
    const out = scoreHotDocs({
      viewers: [{ articleId: "a", count: 1 }, { articleId: "b", count: 10 }],
      likes: [{ articleId: "a", count: 2 }],
      comments: [{ articleId: "a", count: 1 }],
      bookmarks: [{ articleId: "a", count: 1 }],
    });
    // a: 1 + 2×2 + 1×3 + 1×2 = 10;b: 10 浏览人 = 10 → 同分,但 a 有互动应排先(稳定:分数相同看插入序,a 先入)。
    const a = out.find((h) => h.articleId === "a")!;
    const b = out.find((h) => h.articleId === "b")!;
    expect(a.score).toBe(10);
    expect(b.score).toBe(10);
    expect(a).toMatchObject({ viewers: 1, likes: 2, comments: 1, bookmarks: 1 });
    expect(out.map((h) => h.score)).toEqual([...out.map((h) => h.score)].sort((x, y) => y - x));
    // 同分时保持插入序(有互动的 a 先入 → 排在纯浏览的 b 前):锁定稳定排序意图。
    expect(out[0].articleId).toBe("a");
  });

  it("returns [] when every source is empty", () => {
    expect(scoreHotDocs({ viewers: [], likes: [], comments: [], bookmarks: [] })).toEqual([]);
  });
});
