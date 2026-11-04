import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Mock the provider registry + semaphore so generation needs no real CLI.
const { chatImpl, acquire } = vi.hoisted(() => ({ chatImpl: vi.fn(), acquire: vi.fn() }));
vi.mock("../llm/registry.js", () => ({
  getProvider: vi.fn(async () => ({ name: "claude", isAvailable: vi.fn(), chat: (...a: unknown[]) => chatImpl(...a) })),
}));
vi.mock("../../utils/concurrency.js", () => ({
  chatSemaphore: { acquire: (...a: unknown[]) => acquire(...a) },
  runExclusive: vi.fn(),
}));
// 群通知不发真实请求;断言它在 0 篇文档时不被调用、有文档生成时被调用。
const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn() }));
vi.mock("./notify.js", () => ({ notifySkillUpdated: (...a: unknown[]) => notifyMock(...a) }));

import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { generateRoleSkill } from "./generate.js";

async function* yieldTokens(parts: string[]) {
  for (const p of parts) yield { type: "token", text: p };
  yield { type: "done" };
}
const makeRole = (name: string) => prisma.role.create({ data: { name } });
// 去状态后:技能源按正文长度纳入(hasRetrievableContent ≥10 可见字符)。测试正文统一
// 补足到阈值以上,确保被纳入;名称仍叫 addPub(语义=「加一篇有内容的文档」)。
const addPub = (roleId: string, title: string, body: string) =>
  prisma.article.create({ data: { title, contentMarkdown: `${body} 这是一段足够长的测试正文`, roleId } });

describe("generateRoleSkill", () => {
  beforeEach(async () => {
    await resetDb();
    chatImpl.mockReset();
    acquire.mockReset();
    notifyMock.mockReset();
    acquire.mockImplementation(async () => () => {}); // default: grant a no-op release
  });
  afterAll(async () => { await disconnectDb(); });

  it("generates a fresh skill from published docs, parsing frontmatter", async () => {
    const role = await makeRole("Assistant知识库");
    await addPub(role.id, "入门", "正文A");
    chatImpl.mockReturnValue(yieldTokens(["---\nname: my skill\ndescription: 知道很多\n---\n\n## 用途\nx"]));

    await generateRoleSkill(role.id);

    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("fresh");
    expect(rs?.name).toBe("my-skill"); // slugified
    expect(rs?.description).toBe("知道很多");
    expect(rs?.docCount).toBe(1);
    expect(rs?.truncated).toBe(0);
    expect(rs?.model).toBe("claude");
    expect(rs?.sourceHash).toBeTruthy();
    expect(rs?.content).toContain("## 用途");
    expect(chatImpl).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1); // 有文档生成 → 发群通知
  });

  it("skips the model call when sourceHash is unchanged (no-op refresh)", async () => {
    const role = await makeRole("KB");
    await addPub(role.id, "T", "B");
    chatImpl.mockReturnValue(yieldTokens(["---\nname: a\ndescription: d\n---\n\nbody"]));
    await generateRoleSkill(role.id);
    chatImpl.mockClear();

    await prisma.roleSkill.update({ where: { roleId: role.id }, data: { status: "stale", staleSince: new Date() } });
    await generateRoleSkill(role.id);

    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("fresh");
    expect(chatImpl).not.toHaveBeenCalled();
  });

  it("收录 0 篇文档 → 跳过:不生成、不通知、终止态 empty", async () => {
    const role = await makeRole("空角色");
    await generateRoleSkill(role.id);
    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("empty"); // 终止态,sweep 不再重试
    expect(rs?.docCount).toBe(0);
    expect(chatImpl).not.toHaveBeenCalled(); // 不调用模型
    expect(notifyMock).not.toHaveBeenCalled(); // 不发群通知
  });

  it("文档正文清空(由有变 0 篇)→ 转 empty、不通知,不再被 sweep 反复重试", async () => {
    const role = await makeRole("曾有文档");
    const art = await addPub(role.id, "T", "B");
    chatImpl.mockReturnValue(yieldTokens(["---\nname: a\ndescription: d\n---\n\nbody"]));
    await generateRoleSkill(role.id);
    expect((await prisma.roleSkill.findUnique({ where: { roleId: role.id } }))?.status).toBe("fresh");

    // 清空唯一文档的正文(内容不足 → 不进技能源)→ 标 stale → 再次生成应转 empty 且不通知。
    await prisma.article.update({ where: { id: art.id }, data: { contentMarkdown: "" } });
    await prisma.roleSkill.update({ where: { roleId: role.id }, data: { status: "stale", staleSince: new Date() } });
    notifyMock.mockReset();
    chatImpl.mockClear();
    await generateRoleSkill(role.id);

    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("empty");
    expect(rs?.docCount).toBe(0);
    expect(chatImpl).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("provider error → failed + attempts incremented", async () => {
    const role = await makeRole("KB");
    await addPub(role.id, "T", "B");
    // eslint-disable-next-line require-yield
    async function* errStream() { yield { type: "error", message: "boom" }; }
    chatImpl.mockReturnValue(errStream());
    await generateRoleSkill(role.id);
    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("failed");
    expect(rs?.attempts).toBe(1);
    expect(rs?.error).toContain("boom");
  });

  it("does not run while another pass holds 'generating'", async () => {
    const role = await makeRole("KB");
    await addPub(role.id, "T", "B");
    await prisma.roleSkill.create({ data: { roleId: role.id, status: "generating" } });
    await generateRoleSkill(role.id);
    expect(chatImpl).not.toHaveBeenCalled();
  });

  it("只纳入有可检索正文的文档(空/过短文档不计入 docCount)", async () => {
    const role = await makeRole("KB");
    await addPub(role.id, "Pub", "B"); // 正文充足 → 计入
    await prisma.article.create({ data: { title: "Short", contentMarkdown: "短", roleId: role.id } }); // 过短 → 不计入
    chatImpl.mockReturnValue(yieldTokens(["---\nname: a\ndescription: d\n---\n\nbody"]));
    await generateRoleSkill(role.id);
    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.docCount).toBe(1);
  });

  it("semaphore busy → deferred to stale, no attempt charged, provider not called", async () => {
    const role = await makeRole("KB");
    await addPub(role.id, "T", "B");
    acquire.mockRejectedValueOnce(new Error("busy")); // contention, not a real failure
    await generateRoleSkill(role.id);
    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("stale");
    expect(rs?.attempts).toBe(0);
    expect(chatImpl).not.toHaveBeenCalled();
  });

  it("a stale mark landing mid-generation is not overwritten (commit guard)", async () => {
    const role = await makeRole("KB");
    await addPub(role.id, "T", "B");
    // The stream flips the row back to 'stale' (as a concurrent publish would)
    // BEFORE the generation commits — the commit must then be a no-op.
    async function* racingStream() {
      await prisma.roleSkill.update({ where: { roleId: role.id }, data: { status: "stale", staleSince: new Date() } });
      yield { type: "token", text: "---\nname: a\ndescription: d\n---\n\nbody" };
      yield { type: "done" };
    }
    chatImpl.mockReturnValue(racingStream());
    await generateRoleSkill(role.id);
    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(rs?.status).toBe("stale"); // NOT fresh — the mid-flight change wins
  });

  it("forces a real regen when sourceHash is cleared, even if docs are unchanged", async () => {
    const role = await makeRole("KB");
    await addPub(role.id, "T", "B");
    chatImpl.mockReturnValue(yieldTokens(["---\nname: a\ndescription: d\n---\n\nbody"]));
    await generateRoleSkill(role.id); // first gen sets sourceHash
    chatImpl.mockClear();
    // Mirror the regenerate route: stale + cleared sourceHash, docs UNCHANGED.
    await prisma.roleSkill.update({ where: { roleId: role.id }, data: { status: "stale", staleSince: new Date(), sourceHash: "" } });
    chatImpl.mockReturnValue(yieldTokens(["---\nname: a2\ndescription: d2\n---\n\nbody2"]));
    await generateRoleSkill(role.id);
    const rs = await prisma.roleSkill.findUnique({ where: { roleId: role.id } });
    expect(chatImpl).toHaveBeenCalledTimes(1); // regenerated, not swallowed by the no-op guard
    expect(rs?.status).toBe("fresh");
    expect(rs?.name).toBe("a2");
  });
});
