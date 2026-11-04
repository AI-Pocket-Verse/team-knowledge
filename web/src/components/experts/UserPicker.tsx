import { useEffect, useState } from "react";
import { api, type RoleMember } from "@/lib/api";

// 选人:默认展示建议列表(角色成员),输入 ≥2 字即按名搜任意启用用户。
// value = 选中 userId;onChange(userId, label) 回传选择。
export function UserPicker({ suggestions, value, onChange }: {
  suggestions: RoleMember[];
  value: string | null;
  onChange: (userId: string | null, label?: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<RoleMember[] | null>(null);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setHits(null); return; } // 后端要求 q ≥2 字符
    let alive = true;
    void api.usersSearch(t)
      .then((r) => { if (alive) setHits(r.users.map((u) => ({ userId: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl }))); })
      .catch(() => { if (alive) setHits([]); });
    return () => { alive = false; };
  }, [q]);

  const list = hits ?? suggestions;
  return (
    <div className="space-y-1">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="按名字搜索,或从下方选择"
        className="w-full rounded-lg border border-line px-2 py-1 text-sm outline-none"
      />
      <ul className="max-h-40 overflow-y-auto rounded-lg border border-line">
        {list.length === 0 && <li className="px-2 py-1 text-xs text-muted">{q.trim().length >= 2 ? "无匹配" : "暂无建议,输入名字搜索"}</li>}
        {list.map((m) => (
          <li key={m.userId}>
            <button
              type="button"
              onClick={() => onChange(m.userId, m.displayName)}
              className={`flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-surface ${value === m.userId ? "bg-accent-soft text-primary" : ""}`}
            >
              {m.displayName}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
