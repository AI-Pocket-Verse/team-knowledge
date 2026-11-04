import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("../llm/registry.js", () => ({ getProvider: async () => ({ chat }) }));
vi.mock("../tts/registry.js", () => ({ getTtsProvider: async () => ({ synthesize: async () => ({ audioUrl: null }) }) }));
vi.mock("../retrieval/fts5.js", () => ({ search: async () => [] }));

import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { streamAssistantComment } from "./speaker.js";

const log = { warn() {}, error() {}, info() {} } as never;

async function setup() {
  const admin = await seedUser({ ssoId: "ou_host", isAdmin: true });
  const session = await prisma.meetingSession.create({
    data: { title: "m", createdById: admin.id, allowedRoleIds: "[]", config: "{}" },
  });
  const events: string[] = [];
  const cb = {
    onStart: () => events.push("start"),
    onDelta: (_id: string, t: string) => events.push(`delta:${t}`),
    onSentenceTts: () => {},
    onDone: (_id: string, t: string) => events.push(`done:${t}`),
  };
  const input = {
    sessionId: session.id, allowedRoleIds: [], askerUserId: admin.id, askerIsAdmin: true,
    recentTranscript: "x", trigger: "user_question" as const, question: "q", atMs: 0, askerName: "A",
  };
  return { session, events, cb, input };
}

describe("streamAssistantComment", () => {
  beforeEach(async () => { await resetDb(); chat.mockReset(); });
  afterAll(async () => { await disconnectDb(); });

  it("LLM 只返回 error:started=false,不广播、库里不留空发言", async () => {
    chat.mockImplementation(async function* () { yield { type: "error", message: "boom" }; });
    const { session, events, cb, input } = await setup();
    const r = await streamAssistantComment(input, cb, log);
    expect(r.started).toBe(false);
    expect(events).toEqual([]);
    expect(await prisma.meetingComment.count({ where: { sessionId: session.id } })).toBe(0);
  });

  it("LLM 返回空文本:同样 started=false 且不留空行", async () => {
    chat.mockImplementation(async function* () { yield { type: "done" }; });
    const { session, cb, input } = await setup();
    const r = await streamAssistantComment(input, cb, log);
    expect(r.started).toBe(false);
    expect(await prisma.meetingComment.count({ where: { sessionId: session.id } })).toBe(0);
  });

  it("先吐纯空白再报错:不发 start,客户端不会留下空气泡", async () => {
    chat.mockImplementation(async function* () { yield { type: "token", text: "\n " }; yield { type: "error", message: "boom" }; });
    const { session, events, cb, input } = await setup();
    const r = await streamAssistantComment(input, cb, log);
    expect(r.started).toBe(false);
    expect(events).toEqual([]);
    expect(await prisma.meetingComment.count({ where: { sessionId: session.id } })).toBe(0);
  });

  it("正常产出:start → delta → done,文本落库", async () => {
    chat.mockImplementation(async function* () { yield { type: "token", text: "你好" }; });
    const { session, events, cb, input } = await setup();
    const r = await streamAssistantComment(input, cb, log);
    expect(r.started).toBe(true);
    expect(events).toEqual(["start", "delta:你好", "done:你好"]);
    const row = await prisma.meetingComment.findFirst({ where: { sessionId: session.id } });
    expect(row?.text).toBe("你好");
  });
});
