import { useAuth } from "@/stores/auth";
import { ProfileFeedTabs } from "@/components/profile/ProfileFeedTabs";

/**
 * Personal page (admins + regular users). Identity — avatar, display name,
 * email/mobile — is owned by the platform SSO (Feishu): shown read-only here,
 * with no in-app edit of avatar / display name / password. Below the identity
 * card sits the personal feed (动态 / 文档 / 收藏 / 点赞).
 */
function Avatar({ url, name, size = 64 }: { url: string | null; name: string; size?: number }) {
  if (url) {
    return (
      <img
        src={url}
        alt={`${name} 头像`}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  // Fallback when no avatar: gradient circle with the first character of the
  // display name (matches the role/people surfaces).
  const initial = name.trim().slice(0, 1) || "·";
  return (
    <div
      className="shrink-0 flex items-center justify-center rounded-full bg-gradient-to-br from-blue-400 to-cyan-400 text-white shadow-glass"
      style={{ width: size, height: size, fontSize: size * 0.4, fontWeight: 600 }}
      aria-label={`${name} 头像`}
    >
      {initial}
    </div>
  );
}

export function ProfilePage() {
  const user = useAuth((s) => s.user);
  if (!user) return <div className="text-muted">未登录</div>;

  return (
    <div className="flex flex-col gap-6">
      {/* Read-only identity card. Avatar + display name + email come from the
          platform SSO (Feishu); there is no in-app edit here. */}
      <section className="rounded-xl border border-line bg-white p-5 shadow-glass">
        <div className="flex items-center gap-4">
          <Avatar url={user.avatarUrl} name={user.displayName} size={64} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-lg font-semibold text-fg">{user.displayName}</p>
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-primary">
                {user.isAdmin ? "管理员" : "用户"}
              </span>
            </div>
            {user.email ? (
              <p className="mt-1 text-xs text-muted">
                邮箱 <span className="font-mono">{user.email}</span>
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {/* Personal feed (动态 / 文档 / 收藏 / 点赞). */}
      <ProfileFeedTabs />
    </div>
  );
}
