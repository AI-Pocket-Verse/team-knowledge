import { tr } from "@/i18n";

export const ROLE_PALETTE = [
  { key: "violet", get label() { return tr("shell.color.violet"); }, from: "#a78bfa", to: "#7c3aed" },
  { key: "pink",   get label() { return tr("shell.color.pink"); }, from: "#f9a8d4", to: "#ec4899" },
  { key: "blue",   get label() { return tr("shell.color.blue"); }, from: "#7dd3fc", to: "#0284c7" },
  { key: "amber",  get label() { return tr("shell.color.amber"); }, from: "#fcd34d", to: "#d97706" },
  { key: "green",  get label() { return tr("shell.color.green"); }, from: "#86efac", to: "#16a34a" },
  { key: "teal",   get label() { return tr("shell.color.teal"); }, from: "#5eead4", to: "#0d9488" },
  { key: "rose",   get label() { return tr("shell.color.rose"); }, from: "#fda4af", to: "#e11d48" },
  { key: "slate",  get label() { return tr("shell.color.slate"); }, from: "#cbd5e1", to: "#475569" },
] as const;

export type RoleColorKey = (typeof ROLE_PALETTE)[number]["key"];

export function resolveRoleColor(key: string | null | undefined) {
  const found = ROLE_PALETTE.find((c) => c.key === key);
  return found ?? ROLE_PALETTE.find((c) => c.key === "slate")!;
}
