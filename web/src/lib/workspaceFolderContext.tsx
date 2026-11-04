import { createContext, useContext } from "react";
import type { FolderWithRole, FolderPermissions } from "@team-knowledge/shared";

interface WorkspaceFolderValue {
  folder: FolderWithRole;
  permissions: FolderPermissions;
  refetch: () => Promise<void>;
}

const Ctx = createContext<WorkspaceFolderValue | null>(null);

export const WorkspaceFolderProvider = Ctx.Provider;

export function useWorkspaceFolder(): WorkspaceFolderValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspaceFolder must be used inside WorkspaceFolderProvider");
  return v;
}

// Same as useWorkspaceFolder but returns null when not inside a provider.
// Pages mounted at /d/:docId/edit don't have a WorkspacePage wrapping
// them anymore (URL no longer carries folderId), so they derive folder
// info from the loaded article instead.
export function useOptionalWorkspaceFolder(): WorkspaceFolderValue | null {
  return useContext(Ctx);
}
