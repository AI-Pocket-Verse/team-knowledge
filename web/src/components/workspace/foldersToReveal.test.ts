import { describe, it, expect } from "vitest";
import { foldersToReveal } from "./WorkspaceLeftRail";
import type { FolderRow, SlimDoc } from "@team-knowledge/shared";

// Minimal tree builders — only the fields foldersToReveal reads are filled, cast
// through unknown so the tests don't have to construct the full row shapes.
function doc(id: string): SlimDoc {
  return { id } as unknown as SlimDoc;
}
function folder(
  id: string,
  opts: { articles?: string[]; children?: FolderRow[]; parentId?: string | null } = {},
): FolderRow {
  return {
    id,
    parentId: opts.parentId ?? null,
    articles: (opts.articles ?? []).map(doc),
    children: opts.children ?? [],
  } as unknown as FolderRow;
}
function tree(folders: FolderRow[], directArticles: string[] = []) {
  return { folders, directArticles: directArticles.map(doc) };
}

describe("foldersToReveal", () => {
  it("returns [] for a role-direct doc (nothing to expand)", () => {
    const trees = { r1: tree([folder("F1", { articles: ["d2"] })], ["d1"]) };
    expect(foldersToReveal(trees, { docId: "d1" })).toEqual([]);
  });

  it("returns the containing folder for a doc one level deep", () => {
    const trees = { r1: tree([folder("F1", { articles: ["d1"] })]) };
    expect(foldersToReveal(trees, { docId: "d1" })).toEqual(["F1"]);
  });

  it("returns the full root→leaf chain for a doc in a subfolder", () => {
    const sub = folder("SUB", { parentId: "TOP", articles: ["d1"] });
    const trees = { r1: tree([folder("TOP", { children: [sub] })]) };
    expect(foldersToReveal(trees, { docId: "d1" })).toEqual(["TOP", "SUB"]);
  });

  it("returns the ancestor chain (incl. the target) for an active subfolder", () => {
    const sub = folder("SUB", { parentId: "TOP" });
    const trees = { r1: tree([folder("TOP", { children: [sub] })]) };
    expect(foldersToReveal(trees, { folderId: "SUB" })).toEqual(["TOP", "SUB"]);
  });

  it("returns null when the target isn't in the loaded trees yet", () => {
    const trees = { r1: tree([folder("F1", { articles: ["d1"] })]) };
    expect(foldersToReveal(trees, { docId: "missing" })).toBeNull();
  });

  it("searches across multiple roles", () => {
    const trees = {
      r1: tree([folder("A", { articles: ["x"] })]),
      r2: tree([folder("B", { articles: ["d1"] })]),
    };
    expect(foldersToReveal(trees, { docId: "d1" })).toEqual(["B"]);
  });
});
