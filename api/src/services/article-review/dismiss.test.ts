import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { disconnectDb } from "../../db.js";
import { resetDb } from "../../../test-helpers/db.js";
import { getDismissedHashes, addDismissed } from "./dismiss.js";
import type { HashedReviewFinding } from "./findings.js";

const f = (hash: string): HashedReviewFinding => ({ category: "logic", severity: "med", problem: hash, suggestion: "", hash });

describe("article-review dismiss set", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("忽略集按文章隔离;addDismissed 幂等累加", async () => {
    expect((await getDismissedHashes("art1")).size).toBe(0);
    await addDismissed("art1", [f("aaa"), f("bbb")], "u1");
    await addDismissed("art1", [f("bbb"), f("ccc")], "u1"); // bbb 重复
    const s1 = await getDismissedHashes("art1");
    expect([...s1].sort()).toEqual(["aaa", "bbb", "ccc"]);
    expect((await getDismissedHashes("art2")).size).toBe(0); // 不串台
  });
});
