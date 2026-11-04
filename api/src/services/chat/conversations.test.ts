import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import {
  createConversation, getOrCreateFeishuConversation, getOwnedConversation,
  listConversations, renameConversation, pinConversation, deleteConversation,
  touchConversation, deriveTitle,
} from "./conversations.js";

async function mkUser(suffix = "") {
  return prisma.user.create({ data: { ssoId: `sso${suffix}${Math.random()}`, displayName: "U" } });
}

// 飞书会话现在「有消息才在列表显示」;置顶/排序类用例需先给它补一条消息才会出现。
async function seedMsg(conversationId: string) {
  return prisma.chatMessage.create({ data: { conversationId, role: "user", content: "hi" } });
}

describe("chat/conversations", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("createConversation:同一用户可建多条(singletonKey=null 互不冲突)", async () => {
    const u = await mkUser();
    const a = await createConversation(u.id);
    const b = await createConversation(u.id);
    expect(a.id).not.toBe(b.id);
    expect(a.singletonKey).toBeNull();
    expect(b.singletonKey).toBeNull();
  });

  it("getOrCreateFeishuConversation:每用户唯一、幂等", async () => {
    const u = await mkUser();
    const f1 = await getOrCreateFeishuConversation(u.id);
    const f2 = await getOrCreateFeishuConversation(u.id);
    expect(f1.id).toBe(f2.id);
    expect(f1.singletonKey).toBe("feishu");
  });

  it("getOwnedConversation:归属校验,他人会话取不到", async () => {
    const u1 = await mkUser("1"); const u2 = await mkUser("2");
    const c = await createConversation(u1.id);
    expect((await getOwnedConversation(u1.id, c.id))?.id).toBe(c.id);
    expect(await getOwnedConversation(u2.id, c.id)).toBeNull();
    expect(await getOwnedConversation(u1.id, "nope")).toBeNull();
  });

  it("listConversations:按 lastMessageAt 倒序,飞书置顶", async () => {
    const u = await mkUser();
    const a = await createConversation(u.id);
    const b = await createConversation(u.id);
    const f = await getOrCreateFeishuConversation(u.id);
    await seedMsg(a.id); await seedMsg(b.id); await seedMsg(f.id); // 有消息才显示
    await touchConversation(a.id, new Date(1000));
    await touchConversation(b.id, new Date(2000));
    await touchConversation(f.id, new Date(500)); // 飞书最旧也应置顶
    const list = await listConversations(u.id, {});
    expect(list.items[0]!.id).toBe(f.id);          // 飞书置顶
    expect(list.items.slice(1).map((c) => c.id)).toEqual([b.id, a.id]); // 其余按时间倒序
    expect(list.items[0]!.isFeishu).toBe(true);
  });

  it("listConversations:空的飞书会话不进列表(有消息才显示),会话仍按需创建且幂等", async () => {
    const u = await mkUser();
    // 用户还没聊过飞书 → 空的飞书单例不显示(避免点开是 Hi助手空态),列表为空。
    const list = await listConversations(u.id, {});
    expect(list.items.length).toBe(0);
    // 会话确实被按需创建了(幂等);补一条消息后即出现在列表并置顶。
    const f1 = await getOrCreateFeishuConversation(u.id);
    const f2 = await getOrCreateFeishuConversation(u.id);
    expect(f2.id).toBe(f1.id);
    await seedMsg(f1.id);
    const again = await listConversations(u.id, {});
    expect(again.items.length).toBe(1);
    expect(again.items[0]!.isFeishu).toBe(true);
    expect(again.items[0]!.id).toBe(f1.id);
  });

  it("listConversations:空的普通会话不显示(0 消息的空壳不入列表)", async () => {
    const u = await mkUser();
    const empty = await createConversation(u.id);   // 建了但没任何消息(如首发中断留下的空壳)
    const real = await createConversation(u.id);
    await seedMsg(real.id);                          // 有过对话
    const list = await listConversations(u.id, {});
    expect(list.items.map((c) => c.id)).toEqual([real.id]); // 只显示有消息的那条
    expect(list.items.some((c) => c.id === empty.id)).toBe(false);
  });

  it("listConversations:limit 生效,飞书置顶且不占名额,hasMore 反映非飞书剩余", async () => {
    const u = await mkUser();
    const f = await getOrCreateFeishuConversation(u.id);
    const a = await createConversation(u.id);
    const b = await createConversation(u.id);
    await seedMsg(f.id); await seedMsg(a.id); await seedMsg(b.id); // 有消息才显示
    await touchConversation(a.id, new Date(1000));
    await touchConversation(b.id, new Date(2000));
    const list = await listConversations(u.id, { limit: 1 });
    // 飞书置顶(额外名额)+ 最近活跃的 1 条普通会话;a 被 limit 截掉 → hasMore
    expect(list.items.map((c) => c.id)).toEqual([f.id, b.id]);
    expect(list.hasMore).toBe(true);
  });

  it("listConversations:offset 翻页 —— 第二页接着取,飞书只在第一页", async () => {
    const u = await mkUser();
    const fc = await getOrCreateFeishuConversation(u.id);
    const a = await createConversation(u.id);
    const b = await createConversation(u.id);
    const c = await createConversation(u.id);
    await seedMsg(fc.id); await seedMsg(a.id); await seedMsg(b.id); await seedMsg(c.id); // 有消息才显示
    await touchConversation(a.id, new Date(1000)); // 最旧
    await touchConversation(b.id, new Date(2000));
    await touchConversation(c.id, new Date(3000)); // 最新
    // 第一页 limit 2:飞书 + c、b,还有 a 剩 → hasMore
    const p1 = await listConversations(u.id, { limit: 2 });
    expect(p1.items.map((x) => x.id)).toEqual([expect.any(String), c.id, b.id]); // [飞书, c, b]
    expect(p1.items[0]!.isFeishu).toBe(true);
    expect(p1.hasMore).toBe(true);
    // 第二页 offset 2(已加载 2 条非飞书):只剩 a,不带飞书,hasMore=false
    const p2 = await listConversations(u.id, { limit: 2, offset: 2 });
    expect(p2.items.map((x) => x.id)).toEqual([a.id]);
    expect(p2.items.some((x) => x.isFeishu)).toBe(false);
    expect(p2.hasMore).toBe(false);
  });

  it("listConversations:新建会话立刻排到最前(不因 lastMessageAt=null 被 NULLS LAST 沉底)", async () => {
    const u = await mkUser();
    const a = await createConversation(u.id);
    await seedMsg(a.id);
    await touchConversation(a.id, new Date(1000)); // a 活跃时间很早
    const b = await createConversation(u.id);       // 新建 → lastMessageAt≈now,应排在 a 之前
    await seedMsg(b.id);
    const list = await listConversations(u.id, {});
    expect(list.items.filter((c) => !c.isFeishu).map((c) => c.id)).toEqual([b.id, a.id]);
  });

  it("pinConversation:置顶排到普通会话之上(飞书仍最顶),取消则回落;pinned 字段正确", async () => {
    const u = await mkUser();
    const f = await getOrCreateFeishuConversation(u.id);
    const a = await createConversation(u.id);
    const b = await createConversation(u.id);
    await seedMsg(f.id); await seedMsg(a.id); await seedMsg(b.id); // 有消息才显示
    await touchConversation(a.id, new Date(2000)); // a 更近
    await touchConversation(b.id, new Date(1000)); // b 更旧
    expect((await listConversations(u.id, {})).items.map((c) => c.id)).toEqual([f.id, a.id, b.id]);
    // 置顶较旧的 b → 飞书、b(置顶)、a
    expect(await pinConversation(u.id, b.id, true)).toBe(true);
    let list = await listConversations(u.id, {});
    expect(list.items.map((c) => c.id)).toEqual([f.id, b.id, a.id]);
    expect(list.items.find((c) => c.id === b.id)!.pinned).toBe(true);
    expect(list.items.find((c) => c.id === a.id)!.pinned).toBe(false);
    // 取消置顶 → 回落到按活跃排序
    expect(await pinConversation(u.id, b.id, false)).toBe(true);
    list = await listConversations(u.id, {});
    expect(list.items.map((c) => c.id)).toEqual([f.id, a.id, b.id]);
    expect(list.items.every((c) => !c.pinned)).toBe(true);
  });

  it("pinConversation:归属校验,他人会话改不动", async () => {
    const u1 = await mkUser("1"); const u2 = await mkUser("2");
    const c = await createConversation(u1.id);
    expect(await pinConversation(u2.id, c.id, true)).toBe(false);
  });

  it("renameConversation / deleteConversation 带归属校验", async () => {
    const u1 = await mkUser("1"); const u2 = await mkUser("2");
    const c = await createConversation(u1.id);
    expect(await renameConversation(u2.id, c.id, "x")).toBe(false); // 越权
    expect(await renameConversation(u1.id, c.id, "新标题")).toBe(true);
    expect((await getOwnedConversation(u1.id, c.id))?.title).toBe("新标题");
    expect(await deleteConversation(u2.id, c.id)).toBe(false);      // 越权
    expect(await deleteConversation(u1.id, c.id)).toBe(true);
    expect(await getOwnedConversation(u1.id, c.id)).toBeNull();
  });

  it("deriveTitle:超 40 字截断并补「…」、≤40 原样、空兜底「新对话」", () => {
    const long = "字".repeat(45); // 45 字 → 取前 40 + 「…」
    expect(deriveTitle(long)).toBe("字".repeat(40) + "…");
    expect(deriveTitle("字".repeat(40))).toBe("字".repeat(40)); // 恰好 40:原样,不加「…」
    expect(deriveTitle("短问题")).toBe("短问题");
    expect(deriveTitle("  ")).toBe("新对话");
  });
});
