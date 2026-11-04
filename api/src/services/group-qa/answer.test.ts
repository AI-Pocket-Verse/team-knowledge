import { describe, it, expect, vi, beforeEach } from "vitest";

const search = vi.fn();
const getProvider = vi.fn();
const acquire = vi.fn(async () => () => {});

vi.mock("../retrieval/fts5.js", () => ({ search: (...a: unknown[]) => search(...a) }));
vi.mock("../llm/registry.js", () => ({ getProvider: (...a: unknown[]) => getProvider(...a) }));
vi.mock("../../utils/concurrency.js", () => ({ chatSemaphore: { acquire: () => acquire() } }));

import { decideAndAnswer, retrieveLimit } from "./answer.js";
import type { GroupMsg } from "./buffer.js";

const hit = (articleId: string, title: string) => ({
  articleId, title, snippet: `${title} 的内容片段`, body: "", folderId: "f", roleId: "r", folderName: "F", roleName: "R",
});
const recent: GroupMsg[] = [{ messageId: "om_1", openId: "ou_1", senderName: "张三", text: "报销怎么走", ts: 1 }];
// provider.chat 返回一个产 token 的异步迭代器。
function provider(tokens: string[]) {
  return {
    chat: () => (async function* () {
      for (const t of tokens) yield { type: "token", text: t } as const;
      yield { type: "done" } as const;
    })(),
  };
}
const sig = () => new AbortController().signal;

beforeEach(() => {
  search.mockReset();
  getProvider.mockReset();
  acquire.mockReset();
  acquire.mockResolvedValue(() => {});
});

describe("retrieveLimit", () => {
  it("三档各不同:1 保守 5 / 2 适中 6 / 3 积极 8", () => {
    expect(retrieveLimit(1)).toBe(5);
    expect(retrieveLimit(2)).toBe(6);
    expect(retrieveLimit(3)).toBe(8);
  });
});

describe("decideAndAnswer", () => {
  it("积极度传入 → 按档决定检索 limit", async () => {
    search.mockResolvedValue([]);
    await decideAndAnswer({ recent, question: "报销怎么走", signal: sig(), aggressiveness: 3 });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 8 }));
  });

  it("检索为空 → null,且不调用 LLM", async () => {
    search.mockResolvedValue([]);
    const r = await decideAndAnswer({ recent, question: "报销怎么走", signal: sig() });
    expect(r).toBeNull();
    expect(getProvider).not.toHaveBeenCalled();
  });

  it("LLM 回 NO_ANSWER → null", async () => {
    search.mockResolvedValue([hit("a1", "报销指南")]);
    getProvider.mockResolvedValue(provider(["NO_ANSWER"]));
    const r = await decideAndAnswer({ recent, question: "今天天气不错", signal: sig() });
    expect(r).toBeNull();
  });

  it("能答 → 返回简短答案 + 来源(取 top hit)", async () => {
    search.mockResolvedValue([hit("a1", "报销指南"), hit("a2", "其它")]);
    getProvider.mockResolvedValue(provider(["先提交申请,", "主管审批后财务打款。"]));
    const r = await decideAndAnswer({ recent, question: "报销怎么走", signal: sig() });
    expect(r?.answer).toBe("先提交申请,主管审批后财务打款。");
    expect(r?.sourceTitle).toBe("报销指南");
    expect(r?.sourceArticleId).toBe("a1");
  });

  it("超长答案 → 截断到 160 + …", async () => {
    search.mockResolvedValue([hit("a1", "X")]);
    getProvider.mockResolvedValue(provider(["很长".repeat(200)]));
    const r = await decideAndAnswer({ recent, question: "问", signal: sig() });
    expect(r!.answer.length).toBeLessThanOrEqual(161);
    expect(r!.answer.endsWith("…")).toBe(true);
  });
});
