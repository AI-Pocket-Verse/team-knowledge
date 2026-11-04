import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { claimMinutesNotified } from "./notify.js";

async function createEndedMeeting(): Promise<string> {
  const user = await prisma.user.create({ data: { ssoId: "ou_claim_tester", displayName: "认领测试" } });
  const m = await prisma.meetingSession.create({
    data: { title: "评审会", createdById: user.id, allowedRoleIds: "[]", config: "{}", status: "ended", endedAt: new Date() },
  });
  return m.id;
}

describe("会议纪要群通知一次性认领(claimMinutesNotified)", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("首次认领成功,重复认领(=手动重新生成)失败 → 不会再发群", async () => {
    const id = await createEndedMeeting();
    expect(await claimMinutesNotified(id)).toBe(true);   // 首次生成 → 通知
    expect(await claimMinutesNotified(id)).toBe(false);  // 重新生成 → 不再通知
    expect(await claimMinutesNotified(id)).toBe(false);  // 再来几次也一样
  });

  it("并发认领只有一个赢家", async () => {
    const id = await createEndedMeeting();
    const results = await Promise.all([claimMinutesNotified(id), claimMinutesNotified(id), claimMinutesNotified(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("不同会议互不影响", async () => {
    const a = await createEndedMeeting();
    const user = await prisma.user.findFirstOrThrow();
    const b = await prisma.meetingSession.create({
      data: { title: "另一场", createdById: user.id, allowedRoleIds: "[]", config: "{}", status: "ended", endedAt: new Date() },
    });
    expect(await claimMinutesNotified(a)).toBe(true);
    expect(await claimMinutesNotified(b.id)).toBe(true);
  });
});
