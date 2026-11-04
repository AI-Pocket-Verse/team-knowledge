import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { setExpert } from "./config.js";
import { consult, newConsultContext } from "./consult.js";

const RUN = async () => "技术上可行,沿用现有鉴权。"; // 注入的目标专家回答

describe("experts/consult 护栏", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  async function seedRole(name: string) {
    return prisma.role.create({ data: { name } });
  }

  it("成功:目标允许被请教 → 返回结论,累加 count 与 chain", async () => {
    const tech = await seedRole("技术");
    const ctx = newConsultContext();
    const r = await consult(tech.id, "登录改动影响架构吗?", ctx, { runLlm: RUN });
    expect(r.ok).toBe(true);
    expect(r.answer).toContain("可行");
    expect(ctx.count).toBe(1);
    expect(ctx.chain.has(tech.id)).toBe(true);
  });

  it("深度超限 → depth", async () => {
    const tech = await seedRole("技术");
    const r = await consult(tech.id, "q", { depth: 2, count: 0, chain: new Set() }, { runLlm: RUN });
    expect(r).toEqual({ ok: false, reason: "depth" });
  });

  it("次数超限 → count", async () => {
    const tech = await seedRole("技术");
    const r = await consult(tech.id, "q", { depth: 0, count: 3, chain: new Set() }, { runLlm: RUN });
    expect(r).toEqual({ ok: false, reason: "count" });
  });

  it("成环 → cycle", async () => {
    const tech = await seedRole("技术");
    const r = await consult(tech.id, "q", { depth: 0, count: 0, chain: new Set([tech.id]) }, { runLlm: RUN });
    expect(r).toEqual({ ok: false, reason: "cycle" });
  });

  it("目标不允许被请教 → not-allowed", async () => {
    const tech = await seedRole("技术");
    await setExpert(tech.id, { sources: { kbDocs: true, crossModule: true, webSearch: false, consult: false } }, "admin");
    const r = await consult(tech.id, "q", newConsultContext(), { runLlm: RUN });
    expect(r).toEqual({ ok: false, reason: "not-allowed" });
  });

  it("目标 LLM 不可用(null)→ unavailable", async () => {
    const tech = await seedRole("技术");
    const r = await consult(tech.id, "q", newConsultContext(), { runLlm: async () => null });
    expect(r).toEqual({ ok: false, reason: "unavailable" });
  });
});
