import { prisma } from "../../db.js";

export interface ChatUser { id: string; isAdmin: boolean; chatPreference: string | null }

/**
 * 飞书 `open_id` → 已启用的知识库成员。team-knowledge 的 `User.ssoId` 存的就是飞书登录
 * 时的 open_id(`ou_` 开头),所以直接按 ssoId 唯一索引查。映射不到、非 ou_、或
 * 账号已停用(isActive=false)→ null(对应「仅已登录成员」可用)。
 */
export async function resolveUserByOpenId(openId: string): Promise<ChatUser | null> {
  if (!openId.startsWith("ou_")) return null;
  const u = await prisma.user.findUnique({
    where: { ssoId: openId },
    select: { id: true, isAdmin: true, chatPreference: true, isActive: true },
  });
  if (!u || !u.isActive) return null;
  return { id: u.id, isAdmin: u.isAdmin, chatPreference: u.chatPreference };
}
