import { describe, it, expect } from "vitest";
import { folderDragIntent } from "./WorkspaceLeftRail";

type Evt = Parameters<typeof folderDragIntent>[0];

// Build a synthetic dnd-kit drag event. The over row is 40px tall at top=0, so
// the POINTER y (activatorEvent.clientY + delta.y) controls the band:
//   pointerY=20 → rel 0.5 → MIDDLE (nest);  pointerY=2 → rel 0.05 → EDGE (reorder)
function evt(opts: {
  active: { roleId: string; parentId: string | null; folderId: string; hasChildren?: boolean };
  overId: string;
  over: { roleId?: string; parentId?: string | null; folderId?: string };
  pointerY?: number;
}): Evt {
  return {
    activatorEvent: { clientY: opts.pointerY ?? 20 },
    delta: { x: 0, y: 0 },
    active: {
      data: { current: { kind: "folder", ...opts.active } },
      rect: { current: { translated: { top: 0, height: 40 } } },
    },
    over: {
      id: opts.overId,
      data: { current: opts.over },
      rect: { top: 0, height: 40 },
    },
  } as unknown as Evt;
}

describe("folderDragIntent", () => {
  it("nests a childless top-level folder dropped on another top-level folder's middle", () => {
    const r = folderDragIntent(evt({
      active: { roleId: "r1", parentId: null, folderId: "A" },
      overId: "folder:B", over: { roleId: "r1", parentId: null, folderId: "B" },
      pointerY: 20, // middle band
    }));
    expect(r).toEqual({ kind: "nest", targetId: "B" });
  });

  it("denies nesting a folder that has subfolders (with a reason)", () => {
    const r = folderDragIntent(evt({
      active: { roleId: "r1", parentId: null, folderId: "A", hasChildren: true },
      overId: "folder:B", over: { roleId: "r1", parentId: null, folderId: "B" },
      pointerY: 20, // middle band
    }));
    expect(r?.kind).toBe("denied");
    expect((r as { reason?: string }).reason).toContain("含子目录");
  });

  it("denies nesting under a subfolder (depth cap)", () => {
    const r = folderDragIntent(evt({
      active: { roleId: "r1", parentId: null, folderId: "A" },
      overId: "folder:B", over: { roleId: "r1", parentId: "TOP", folderId: "B" }, // B is itself a subfolder
      pointerY: 20, // middle band
    }));
    expect(r?.kind).toBe("denied");
    expect((r as { reason?: string }).reason).toContain("两级");
  });

  it("reorders within the same parent group when dropped on a sibling edge", () => {
    const r = folderDragIntent(evt({
      active: { roleId: "r1", parentId: null, folderId: "A" },
      overId: "folder:B", over: { roleId: "r1", parentId: null, folderId: "B" },
      pointerY: 2, // edge band
    }));
    expect(r).toEqual({ kind: "reorder", parent: null });
  });

  it("promotes a subfolder dropped on the role header", () => {
    const r = folderDragIntent(evt({
      active: { roleId: "r1", parentId: "TOP", folderId: "A" },
      overId: "roledrop:r1", over: { roleId: "r1" },
    }));
    expect(r).toEqual({ kind: "promote" });
  });

  it("does nothing when an already-top-level folder is dropped on the role header", () => {
    const r = folderDragIntent(evt({
      active: { roleId: "r1", parentId: null, folderId: "A" },
      overId: "roledrop:r1", over: { roleId: "r1" },
    }));
    expect(r).toBeNull();
  });

  it("denies cross-role drops silently (no reason)", () => {
    const r = folderDragIntent(evt({
      active: { roleId: "r1", parentId: null, folderId: "A" },
      overId: "folder:B", over: { roleId: "r2", parentId: null, folderId: "B" },
      pointerY: 20, // middle band
    }));
    expect(r).toEqual({ kind: "denied" });
  });

  it("returns null when dropped on itself", () => {
    const r = folderDragIntent(evt({
      active: { roleId: "r1", parentId: null, folderId: "A" },
      overId: "folder:A", over: { roleId: "r1", parentId: null, folderId: "A" },
      pointerY: 20, // middle band
    }));
    expect(r).toBeNull();
  });
});
