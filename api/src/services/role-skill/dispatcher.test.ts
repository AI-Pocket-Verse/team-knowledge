import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("./generate.js", () => ({ generateRoleSkill: vi.fn(async () => {}) }));

import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { generateRoleSkill } from "./generate.js";
import { kickRoleSkill, QUIET_MS, MAX_ATTEMPTS } from "./dispatcher.js";

const gen = vi.mocked(generateRoleSkill);
const OLD = () => new Date(Date.now() - QUIET_MS - 60_000);
const RECENT = () => new Date(Date.now() - 60_000);

async function roleWithSkill(name: string, data: { status: string; staleSince?: Date | null; attempts?: number }) {
  const role = await prisma.role.create({ data: { name } });
  await prisma.roleSkill.create({
    data: { roleId: role.id, status: data.status, staleSince: data.staleSince ?? null, attempts: data.attempts ?? 0 },
  });
  return role.id;
}

describe("kickRoleSkill — selection", () => {
  beforeEach(async () => { await resetDb(); gen.mockClear(); });
  afterAll(async () => { await disconnectDb(); });

  it("regenerates a stale skill past the quiet window", async () => {
    const id = await roleWithSkill("A", { status: "stale", staleSince: OLD() });
    await kickRoleSkill();
    expect(gen).toHaveBeenCalledWith(id, expect.objectContaining({ log: expect.anything() }));
  });

  it("skips a stale skill still inside the quiet window", async () => {
    await roleWithSkill("B", { status: "stale", staleSince: RECENT() });
    await kickRoleSkill();
    expect(gen).not.toHaveBeenCalled();
  });

  it("retries a failed skill under the attempt cap", async () => {
    const id = await roleWithSkill("C", { status: "failed", staleSince: OLD(), attempts: 1 });
    await kickRoleSkill();
    expect(gen).toHaveBeenCalledWith(id, expect.objectContaining({ log: expect.anything() }));
  });

  it("gives up on a failed skill at the attempt cap", async () => {
    await roleWithSkill("D", { status: "failed", staleSince: OLD(), attempts: MAX_ATTEMPTS });
    await kickRoleSkill();
    expect(gen).not.toHaveBeenCalled();
  });

  it("never re-picks a row that is RECENTLY generating (in-flight)", async () => {
    await roleWithSkill("E", { status: "generating", staleSince: OLD() });
    await kickRoleSkill(); // updatedAt is ~now → not orphaned → left alone
    expect(gen).not.toHaveBeenCalled();
  });

  it("reclaims an orphaned 'generating' row (stuck past the timeout) and regenerates it", async () => {
    const role = await prisma.role.create({ data: { name: "Stuck" } });
    await prisma.roleSkill.create({ data: { roleId: role.id, status: "generating", staleSince: OLD() } });
    // Backdate updatedAt into the past (prisma @updatedAt can't be set via create).
    await prisma.$executeRaw`UPDATE "RoleSkill" SET "updatedAt" = ${new Date(Date.now() - 10 * 60 * 1000)} WHERE "roleId" = ${role.id}`;
    await kickRoleSkill();
    expect(gen).toHaveBeenCalledWith(role.id, expect.objectContaining({ log: expect.anything() })); // reclaimed → stale → selected → regenerated
  });

  it("ignores fresh skills", async () => {
    await roleWithSkill("F", { status: "fresh", staleSince: null });
    await kickRoleSkill();
    expect(gen).not.toHaveBeenCalled();
  });
});
