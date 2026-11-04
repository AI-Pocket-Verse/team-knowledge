import { describe, it, expect } from "vitest";
import { decideDesktopNotifications, type WebNotifItem } from "./webNotify";

// 列表是后端顺序:新→旧(createdAt desc)。
const item = (id: string, createdAt: string, readAt: string | null = null): WebNotifItem => ({ id, createdAt, readAt });

describe("decideDesktopNotifications", () => {
  it("首次挂载(lastSeen=null):建立基线、不补弹历史", () => {
    const web = [item("b", "2026-07-03T10:00:00.000Z"), item("a", "2026-07-03T09:00:00.000Z")];
    const r = decideDesktopNotifications(web, null);
    expect(r.fire).toEqual([]);
    expect(r.nextCursor).toBe("2026-07-03T10:00:00.000Z|b");
  });

  it("首次挂载且列表为空:写哨兵基线 '',这样第一条通知不会被当基线吞掉", () => {
    const r = decideDesktopNotifications([], null);
    expect(r.fire).toEqual([]);
    expect(r.nextCursor).toBe("");
  });

  it("空基线后到来的第一条通知会弹(修复:首条不再被吞)", () => {
    const web = [item("a", "2026-07-03T09:00:00.000Z")];
    const r = decideDesktopNotifications(web, ""); // 上一轮空列表建立的哨兵基线
    expect(r.fire.map((n) => n.id)).toEqual(["a"]);
    expect(r.nextCursor).toBe("2026-07-03T09:00:00.000Z|a");
  });

  it("只弹比基线更新的条目,且按时间正序(旧→新)", () => {
    const web = [
      item("c", "2026-07-03T12:00:00.000Z"),
      item("b", "2026-07-03T11:00:00.000Z"),
      item("a", "2026-07-03T10:00:00.000Z"), // == 基线,不弹
    ];
    const r = decideDesktopNotifications(web, "2026-07-03T10:00:00.000Z|a");
    expect(r.fire.map((n) => n.id)).toEqual(["b", "c"]);
    expect(r.nextCursor).toBe("2026-07-03T12:00:00.000Z|c");
  });

  it("已读的新条目不弹(用户已在铃铛里看过)", () => {
    const web = [item("b", "2026-07-03T11:00:00.000Z", "2026-07-03T11:00:05.000Z")];
    const r = decideDesktopNotifications(web, "2026-07-03T10:00:00.000Z|a");
    expect(r.fire).toEqual([]);
    expect(r.nextCursor).toBe("2026-07-03T11:00:00.000Z|b");
  });

  it("列表为空但已有基线:不覆盖基线(nextCursor=null)", () => {
    const r = decideDesktopNotifications([], "2026-07-03T10:00:00.000Z|a");
    expect(r.fire).toEqual([]);
    expect(r.nextCursor).toBeNull();
  });

  it("同毫秒不同 id:按 id 字典序 tiebreak,不漏不重", () => {
    const web = [item("z", "2026-07-03T10:00:00.000Z"), item("a", "2026-07-03T10:00:00.000Z")];
    // 基线是 id=a 那条 → 只有 id=z(同时刻但 id 更大)算更新。
    const r = decideDesktopNotifications(web, "2026-07-03T10:00:00.000Z|a");
    expect(r.fire.map((n) => n.id)).toEqual(["z"]);
  });
});
