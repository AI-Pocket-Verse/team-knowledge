import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { getAssistantExclusionSets, invalidateAssistantExclusionCache, exclusionPrismaWhere } from "./exclusions.js";

async function seedRole(name: string) { return prisma.role.create({ data: { name } }); }

describe("getAssistantExclusionSets", () => {
  beforeEach(async () => { await resetDb(); invalidateAssistantExclusionCache(); });
  afterAll(async () => { await disconnectDb(); });

  it("returns empty sets when nothing is excluded", async () => {
    const sets = await getAssistantExclusionSets();
    expect(sets.roleIds.size).toBe(0);
    expect(sets.folderIds.size).toBe(0);
    expect(sets.articleIds.size).toBe(0);
  });

  it("cascades an excluded folder to include its subfolders", async () => {
    const role = await seedRole("产品");
    const parent = await prisma.folder.create({ data: { name: "父", roleId: role.id, visibility: "public" } });
    const child = await prisma.folder.create({ data: { name: "子", roleId: role.id, visibility: "public", parentId: parent.id } });
    await prisma.assistantExclusion.create({ data: { targetType: "folder", targetId: parent.id, createdById: "admin" } });
    invalidateAssistantExclusionCache();

    const sets = await getAssistantExclusionSets();
    expect(sets.folderIds.has(parent.id)).toBe(true);
    expect(sets.folderIds.has(child.id)).toBe(true); // 子文件夹被级联
  });

  it("collects role and article exclusions verbatim", async () => {
    const role = await seedRole("法务");
    await prisma.assistantExclusion.create({ data: { targetType: "role", targetId: role.id, createdById: "admin" } });
    await prisma.assistantExclusion.create({ data: { targetType: "article", targetId: "art-1", createdById: "admin" } });
    invalidateAssistantExclusionCache();

    const sets = await getAssistantExclusionSets();
    expect([...sets.roleIds]).toEqual([role.id]);
    expect([...sets.articleIds]).toEqual(["art-1"]);
  });

  it("exclusionPrismaWhere only adds clauses for non-empty sets", () => {
    expect(exclusionPrismaWhere({ roleIds: new Set(), folderIds: new Set(), articleIds: new Set() })).toEqual({});
    const w = exclusionPrismaWhere({ roleIds: new Set(["r1"]), folderIds: new Set(["f1"]), articleIds: new Set(["a1"]) });
    expect(w.roleId).toEqual({ notIn: ["r1"] });
    expect(w.id).toEqual({ notIn: ["a1"] });
    expect(w.OR).toEqual([{ folderId: null }, { folderId: { notIn: ["f1"] } }]);
  });
});
