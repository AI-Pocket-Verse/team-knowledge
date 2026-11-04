import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const getScenarioNotifyConfig = vi.fn();
const decideAndAnswer = vi.fn();
const isDemoted = vi.fn();
const recordAnswer = vi.fn();
const replyInChat = vi.fn();

vi.mock("../../env.js", async (orig) => {
  const m = await orig<typeof import("../../env.js")>();
  return { ...m, env: { ...m.env, WEB_PUBLIC_URL: "https://kb.example.com" } };
});
vi.mock("../../utils/feishuGateway.js", () => ({ feishuGateway: { replyInChat: (...a: unknown[]) => replyInChat(...a) } }));
vi.mock("../notify-config/index.js", () => ({
  getScenarioNotifyConfig: (...a: unknown[]) => getScenarioNotifyConfig(...a),
  chatLabel: (id: string) => id,
}));
vi.mock("./answer.js", () => ({ decideAndAnswer: (...a: unknown[]) => decideAndAnswer(...a) }));
vi.mock("./store.js", () => ({
  isDemoted: (...a: unknown[]) => isDemoted(...a),
  recordAnswer: (...a: unknown[]) => recordAnswer(...a),
}));

import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { observeGroupMessage } from "./observe.js";
import { recentMessages, _resetBuffers } from "./buffer.js";
import { _resetGate } from "./gate.js";

const ON = { enabled: true, chatIds: ["oc_1"], schedule: null };
const base = { chatId: "oc_1", messageId: "om_1", openId: "ou_1", senderName: "张三" };

afterAll(async () => { await disconnectDb(); });

beforeEach(async () => {
  await resetDb();
  await seedUser({ ssoId: "ou_1" }); // 发言人默认是已启用成员
  _resetBuffers();
  _resetGate();
  getScenarioNotifyConfig.mockReset().mockResolvedValue(ON);
  decideAndAnswer.mockReset().mockResolvedValue({ answer: "答案", sourceTitle: "报销指南", sourceArticleId: "a1" });
  isDemoted.mockReset().mockResolvedValue(false);
  recordAnswer.mockReset().mockResolvedValue(undefined);
  replyInChat.mockReset().mockResolvedValue({ messageId: "om_reply" });
});

describe("observeGroupMessage", () => {
  it("发言人不是知识库成员(或已停用)→ 静默跳过:不进缓冲、不回答", async () => {
    await seedUser({ ssoId: "ou_off", isActive: false });
    for (const openId of ["ou_stranger", "ou_off"]) {
      await observeGroupMessage({ ...base, openId, text: "报销怎么走?", now: 1000 });
    }
    expect(recentMessages("oc_1")).toEqual([]);
    expect(decideAndAnswer).not.toHaveBeenCalled();
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("任何消息都进缓冲(即使未开启答疑)", async () => {
    getScenarioNotifyConfig.mockResolvedValue({ enabled: false, chatIds: [], schedule: null });
    await observeGroupMessage({ ...base, text: "随便聊聊", now: 1000 });
    expect(recentMessages("oc_1").map((m) => m.text)).toEqual(["随便聊聊"]);
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("本群未被勾选 → 不答", async () => {
    getScenarioNotifyConfig.mockResolvedValue({ enabled: true, chatIds: ["oc_other"], schedule: null });
    await observeGroupMessage({ ...base, text: "报销怎么走?", now: 1000 });
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("非问句 → 不调 LLM、不答", async () => {
    await observeGroupMessage({ ...base, text: "我先下班了", now: 1000 });
    expect(decideAndAnswer).not.toHaveBeenCalled();
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("问题被反对降权 → 不答", async () => {
    isDemoted.mockResolvedValue(true);
    await observeGroupMessage({ ...base, text: "报销怎么走?", now: 1000 });
    expect(decideAndAnswer).not.toHaveBeenCalled();
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("LLM 判定不答 → 不发", async () => {
    decideAndAnswer.mockResolvedValue(null);
    await observeGroupMessage({ ...base, text: "报销怎么走?", now: 1000 });
    expect(decideAndAnswer).toHaveBeenCalled();
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("并发同群两条问题 → 只判定/回复一次(防 TOCTOU 双发)", async () => {
    // 让第一条的判定挂起,制造并发窗口:第二条应被 in-flight 直接挡掉。
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    decideAndAnswer.mockImplementationOnce(async () => { await gate; return { answer: "答案", sourceTitle: "x", sourceArticleId: "a1" }; });
    const p1 = observeGroupMessage({ ...base, messageId: "om_a", text: "报销怎么走?", now: 1000 });
    const p2 = observeGroupMessage({ ...base, messageId: "om_b", text: "报销额度多少?", now: 1001 });
    await p2; // p2 被 in-flight 挡住,快速返回
    expect(decideAndAnswer).toHaveBeenCalledTimes(1); // 第二条没进 LLM
    release();
    await p1;
    expect(replyInChat).toHaveBeenCalledTimes(1); // 只回了一条
  });

  it("命中 → 引用回复(带卡片)+ 记录;随后同群冷却内不再答", async () => {
    await observeGroupMessage({ ...base, text: "报销怎么走?", now: 1000 });
    expect(replyInChat).toHaveBeenCalledTimes(1);
    const [msgId, card] = replyInChat.mock.calls[0];
    expect(msgId).toBe("om_1");
    expect(JSON.stringify(card)).toContain("答案");
    expect(recordAnswer).toHaveBeenCalled();

    // 冷却内(+1s)再来一条问句 → 被挡
    await observeGroupMessage({ ...base, messageId: "om_2", text: "那报销额度呢?", now: 2000 });
    expect(replyInChat).toHaveBeenCalledTimes(1);
  });
});
