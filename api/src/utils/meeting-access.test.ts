import { describe, it, expect } from "vitest";
import { canViewMeeting, canEditMeetingMeta } from "./meeting-access.js";

const mk = (over: Partial<{ visibility: string; createdById: string }> = {}) =>
  ({ visibility: "public", createdById: "host", ...over });

describe("canViewMeeting", () => {
  it("public is visible to anyone", () => {
    expect(canViewMeeting({ id: "u", isAdmin: false }, mk())).toBe(true);
  });
  it("private is visible only to the creator — NOT admins (unless they are the creator)", () => {
    const s = mk({ visibility: "private" });
    expect(canViewMeeting({ id: "host", isAdmin: false }, s)).toBe(true); // creator
    expect(canViewMeeting({ id: "other", isAdmin: false }, s)).toBe(false); // stranger
    expect(canViewMeeting({ id: "other", isAdmin: true }, s)).toBe(false); // admin gets no bypass
    expect(canViewMeeting({ id: "host", isAdmin: true }, s)).toBe(true); // admin who IS the creator
  });
});

describe("canEditMeetingMeta", () => {
  it("creator or admin only", () => {
    const s = mk();
    expect(canEditMeetingMeta({ id: "host", isAdmin: false }, s)).toBe(true);
    expect(canEditMeetingMeta({ id: "other", isAdmin: false }, s)).toBe(false);
    expect(canEditMeetingMeta({ id: "other", isAdmin: true }, s)).toBe(true);
  });
});
