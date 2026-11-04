import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { getVisibilityMap, setPageVisibility, isOpenToAll, openPageKeys, ELIGIBLE_PAGES } from "./index.js";

describe("admin-visibility", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("默认全部仅管理员;白名单有 4 页", () => {
    expect(ELIGIBLE_PAGES.map((p) => p.key)).toEqual(["article-review", "group-qa", "weekly-report", "web-notify"]);
  });

  it("默认 map 全 admin;openPageKeys 为空", async () => {
    expect(await getVisibilityMap()).toEqual({ "article-review": "admin", "group-qa": "admin", "weekly-report": "admin", "web-notify": "admin" });
    expect(await openPageKeys()).toEqual([]);
    expect(await isOpenToAll("article-review")).toBe(false);
  });

  it("setPageVisibility 放开白名单页 → isOpenToAll/openPageKeys 反映", async () => {
    await setPageVisibility("group-qa", "all", "admin");
    expect(await isOpenToAll("group-qa")).toBe(true);
    expect(await openPageKeys()).toEqual(["group-qa"]);
    expect((await getVisibilityMap())["group-qa"]).toBe("all");
  });

  it("非白名单 key:set 抛错、isOpenToAll=false", async () => {
    await expect(setPageVisibility("users", "all", "admin")).rejects.toThrow();
    expect(await isOpenToAll("users")).toBe(false);
  });
});
