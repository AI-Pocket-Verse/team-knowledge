import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { flushBestEffortWrites } from "../../utils/guards.js";
import { markRoleSkillStale, ensureRoleSkillRow } from "./stale.js";

describe("markRoleSkillStale / ensureRoleSkillRow", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("creates a stale row when none exists", async () => {
    const role = await prisma.role.create({ data: { name: "KB" } });
    markRoleSkillStale(role.id);
    await flushBestEffortWrites();
    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("stale");
    expect(rs?.staleSince).toBeTruthy();
  });

  it("flips an existing fresh row back to stale", async () => {
    const role = await prisma.role.create({ data: { name: "KB" } });
    await prisma.roleSkill.create({ data: { roleId: role.id, status: "fresh", content: "x", sourceHash: "h" } });
    markRoleSkillStale(role.id);
    await flushBestEffortWrites();
    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("stale");
  });

  it("resets attempts so a failed-at-cap skill auto-recovers on the next change", async () => {
    const role = await prisma.role.create({ data: { name: "KB" } });
    await prisma.roleSkill.create({ data: { roleId: role.id, status: "failed", content: "x", attempts: 3 } });
    markRoleSkillStale(role.id);
    await flushBestEffortWrites();
    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("stale");
    expect(rs?.attempts).toBe(0);
  });

  it("ensureRoleSkillRow seeds a stale row but leaves an existing one untouched", async () => {
    const role = await prisma.role.create({ data: { name: "KB" } });
    ensureRoleSkillRow(role.id);
    await flushBestEffortWrites();
    expect((await prisma.roleSkill.findUnique({ where: { roleId: role.id } }))?.status).toBe("stale");

    await prisma.roleSkill.update({ where: { roleId: role.id }, data: { status: "fresh" } });
    ensureRoleSkillRow(role.id);
    await flushBestEffortWrites();
    expect((await prisma.roleSkill.findUnique({ where: { roleId: role.id } }))?.status).toBe("fresh");
  });
});
