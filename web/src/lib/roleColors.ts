export const ROLE_PALETTE = [
  { key: "violet", label: "紫",  from: "#a78bfa", to: "#7c3aed" },
  { key: "pink",   label: "粉",  from: "#f9a8d4", to: "#ec4899" },
  { key: "blue",   label: "蓝",  from: "#7dd3fc", to: "#0284c7" },
  { key: "amber",  label: "琥珀", from: "#fcd34d", to: "#d97706" },
  { key: "green",  label: "绿",  from: "#86efac", to: "#16a34a" },
  { key: "teal",   label: "青",  from: "#5eead4", to: "#0d9488" },
  { key: "rose",   label: "玫红", from: "#fda4af", to: "#e11d48" },
  { key: "slate",  label: "灰",  from: "#cbd5e1", to: "#475569" },
] as const;

export type RoleColorKey = (typeof ROLE_PALETTE)[number]["key"];

export function resolveRoleColor(key: string | null | undefined) {
  const found = ROLE_PALETTE.find((c) => c.key === key);
  return found ?? ROLE_PALETTE.find((c) => c.key === "slate")!;
}
