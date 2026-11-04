import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { getExpert, setExpert, getExpertsByRoleIds, DEFAULT_SOURCES } from "./config.js";

describe("experts/config", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("未配置 → 返回默认(enabled, 默认来源, 无负责人)", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    const e = await getExpert(role.id);
    expect(e).toEqual({ roleId: role.id, instruction: "", ownerUserId: null, avatarUrl: null, sources: DEFAULT_SOURCES, enabled: true });
  });

  it("set 后回读一致;sources 脏值回退默认", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    await setExpert(role.id, {
      instruction: "你是产品专家",
      ownerUserId: null,
      sources: { kbDocs: true, crossModule: false, webSearch: true, consult: true },
      enabled: true,
    }, "admin");
    const e = await getExpert(role.id);
    expect(e.instruction).toBe("你是产品专家");
    expect(e.sources.webSearch).toBe(true);
    expect(e.sources.crossModule).toBe(false);
  });

  it("avatarUrl 可写入并回读;默认 null;可清除", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    expect((await getExpert(role.id)).avatarUrl).toBeNull();
    await setExpert(role.id, { avatarUrl: "/uploads/abc.png" }, "admin");
    expect((await getExpert(role.id)).avatarUrl).toBe("/uploads/abc.png");
    await setExpert(role.id, { avatarUrl: null }, "admin");
    expect((await getExpert(role.id)).avatarUrl).toBeNull();
  });

  it("sources 持久化为损坏 JSON → 读取时回退默认", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.roleExpert.create({ data: { roleId: role.id, sources: "not-json{" } });
    const e = await getExpert(role.id);
    expect(e.sources).toEqual(DEFAULT_SOURCES);
  });

  it("getExpertsByRoleIds 批量:已配置取库值,未配置补默认(消除 N+1)", async () => {
    const r1 = await prisma.role.create({ data: { name: "产品" } });
    const r2 = await prisma.role.create({ data: { name: "技术" } });
    await setExpert(r1.id, { instruction: "P", enabled: false }, "admin"); // 仅 r1 配置
    const map = await getExpertsByRoleIds([r1.id, r2.id]);
    expect(map.get(r1.id)).toMatchObject({ instruction: "P", enabled: false });
    expect(map.get(r2.id)).toEqual({ roleId: r2.id, instruction: "", ownerUserId: null, avatarUrl: null, sources: DEFAULT_SOURCES, enabled: true });
    expect(await getExpertsByRoleIds([])).toEqual(new Map());
  });
});
