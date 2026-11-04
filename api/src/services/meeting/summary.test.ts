import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// LLM 与「群通知目标」是外部依赖，替换成假的；其余（库、纪要生成、通知闸门）走真实链路。
vi.mock("../llm/registry.js", () => ({
  getProvider: async () => ({
    async *chat() { yield { type: "token", text: "## 决策点\n上线登录" }; },
  }),
}));
vi.mock("../notify-config/index.js", () => ({ targetsIfEnabled: async () => ["oc_probe"] }));

import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { feishuGateway } from "../../utils/feishuGateway.js";
import { generateMeetingSummary } from "./summary.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const flush = () => new Promise((r) => setTimeout(r, 50)); // 群通知是 fire-and-forget

async function endedMeeting(visibility: "public" | "private") {
  const u = await seedUser({ ssoId: `ou_${visibility}` });
  const m = await prisma.meetingSession.create({
    data: { title: `${visibility} 会议`, createdById: u.id, allowedRoleIds: "[]", config: "{}", status: "ended", endedAt: new Date(), visibility },
  });
  await prisma.meetingTranscript.create({ data: { sessionId: m.id, text: "讨论上线", startMs: 0, endMs: 1000 } });
  return m.id;
}

describe("generateMeetingSummary 群通知", () => {
  const notifyChat = vi.spyOn(feishuGateway, "notifyChat");
  beforeEach(async () => {
    await resetDb();
    notifyChat.mockReset().mockResolvedValue({ messageId: "om_1" });
  });
  afterAll(async () => { await disconnectDb(); });

  it("公开会议：纪要生成后推送到目标群", async () => {
    const id = await endedMeeting("public");
    expect((await generateMeetingSummary(id, log)).reason).toBe("ok");
    await flush();
    expect(notifyChat).toHaveBeenCalledTimes(1);
  });

  it("私密会议：纪要照常生成，但不推送到群，也不消耗一次性认领", async () => {
    const id = await endedMeeting("private");
    expect((await generateMeetingSummary(id, log)).reason).toBe("ok");
    await flush();
    expect(notifyChat).not.toHaveBeenCalled();
    const row = await prisma.meetingSession.findUnique({ where: { id }, select: { minutesNotifiedAt: true } });
    expect(row?.minutesNotifiedAt).toBeNull();
  });
});
