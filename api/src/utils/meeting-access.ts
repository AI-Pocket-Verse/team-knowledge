// Centralized meeting authorization. Mirrors the public/private model used for
// folders (utils/permissions.ts) but scoped to a meeting's own visibility +
// creator, NOT role membership — a meeting's audience is "everyone" (public) or
// "just the creator" (private), independent of the knowledge-base role tree.
// Private meetings are creator-only to VIEW: admins do NOT get a view bypass
// (an admin sees a private meeting only when they ARE its creator).
export interface MeetingActor {
  id: string;
  isAdmin: boolean;
}
export interface MeetingAccessRow {
  visibility: string;
  createdById: string;
}

/** Who may view/join a meeting: public → anyone; private → creator only. */
export function canViewMeeting(user: MeetingActor, s: MeetingAccessRow): boolean {
  return s.visibility === "public" || s.createdById === user.id;
}

/**
 * Who may edit a meeting's metadata (visibility, title): creator + admins.
 * NOTE: every route must gate on canViewMeeting FIRST — an admin who is not
 * the creator is 404'd on another user's PRIVATE meeting before this edit
 * check is ever reached, so the admin bypass here only applies to meetings
 * the admin can already view (public, or their own).
 */
export function canEditMeetingMeta(user: MeetingActor, s: MeetingAccessRow): boolean {
  return s.createdById === user.id || user.isAdmin;
}
