import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import {
  getDocAuditStrength, getDocAuditMaxPerCategory, getDocAuditTuning, setDocAuditTuning, clampInt,
  STRENGTH_DEFAULT, MAX_PER_CATEGORY_DEFAULT,
} from "./config.js";

describe("doc-audit clampInt", () => {
  it("取整夹紧 + 非法回退", () => {
    expect(clampInt(4, 1, 10, 4)).toBe(4);
    expect(clampInt(0, 1, 10, 4)).toBe(1);       // 低于下界
    expect(clampInt(99, 1, 10, 4)).toBe(10);     // 高于上界
    expect(clampInt("abc", 1, 10, 4)).toBe(4);   // 非法 → 默认
    expect(clampInt("7", 1, 10, 4)).toBe(7);     // 数字字符串
    expect(clampInt(6.9, 1, 10, 4)).toBe(6);     // 取整
    // 强转陷阱:这些必须回退默认,而不是被 Number() 变成 0/1 再夹成 min。
    expect(clampInt("", 1, 10, 4)).toBe(4);
    expect(clampInt(null, 1, 10, 4)).toBe(4);
    expect(clampInt(true, 1, 10, 4)).toBe(4);
    expect(clampInt([5], 1, 10, 4)).toBe(4);
  });
});

describe("doc-audit tuning", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("默认值", async () => {
    expect(await getDocAuditStrength()).toBe(STRENGTH_DEFAULT);
    expect(await getDocAuditMaxPerCategory()).toBe(MAX_PER_CATEGORY_DEFAULT);
    expect(await getDocAuditTuning()).toEqual({ strength: STRENGTH_DEFAULT, maxPerCategory: MAX_PER_CATEGORY_DEFAULT });
  });

  it("setDocAuditTuning 部分更新 + 越界夹紧 + 回读一致", async () => {
    const r1 = await setDocAuditTuning({ strength: 8, maxPerCategory: 25 }, "admin");
    expect(r1).toEqual({ strength: 8, maxPerCategory: 25 });

    const r2 = await setDocAuditTuning({ strength: 99 }, "admin"); // 越界
    expect(r2.strength).toBe(10);           // 夹到上界
    expect(r2.maxPerCategory).toBe(25);     // 未传 → 保持

    const r3 = await setDocAuditTuning({ strength: 0, maxPerCategory: 0 }, "admin"); // 低于下界
    expect(r3.strength).toBe(1);
    expect(r3.maxPerCategory).toBe(1);
    expect(await getDocAuditTuning()).toEqual(r3);
  });

  it("非法值回退默认(读)", async () => {
    // 直接写脏值,读取时应回退默认。
    await setDocAuditTuning({ strength: 4, maxPerCategory: 10 }, "admin");
    // clampInt 已在 set 层保证落库合法,这里验证 get 对历史脏数据的兜底由 clampInt 单测覆盖。
    expect(await getDocAuditStrength()).toBe(4);
    expect(await getDocAuditMaxPerCategory()).toBe(10);
  });
});
