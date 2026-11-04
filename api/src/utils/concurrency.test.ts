import { describe, expect, it } from "vitest";
import { Semaphore, runExclusive } from "./concurrency.js";

describe("Semaphore", () => {
  it("allows up to N concurrent acquisitions", async () => {
    const s = new Semaphore(2);
    const t1 = s.acquire();
    const t2 = s.acquire();
    const t3 = s.acquire();
    expect(await Promise.race([t1, Promise.resolve("pending")])).not.toBe("pending");
    expect(await Promise.race([t2, Promise.resolve("pending")])).not.toBe("pending");
    expect(await Promise.race([t3, Promise.resolve("pending")])).toBe("pending");
    const r1 = await t1; r1();
    expect(await Promise.race([t3, Promise.resolve("pending")])).not.toBe("pending");
    (await t2)();
    (await t3)();
  });

  it("acquire(timeoutMs) rejects when no slot frees", async () => {
    const s = new Semaphore(1);
    const r = await s.acquire();
    await expect(s.acquire(20)).rejects.toThrow(/timeout/i);
    r();
  });
});

describe("runExclusive (#10 per-conversation serialization)", () => {
  const tick = (ms: number) => new Promise((res) => setTimeout(res, ms));

  it("serializes same-key work strictly in submission order", async () => {
    const order: string[] = [];
    // Start b AFTER a is submitted; a's body sleeps longer. Without
    // serialization b would finish first. With it, a fully completes
    // (start→end) before b starts.
    const a = runExclusive("conv1", async () => {
      order.push("a:start");
      await tick(30);
      order.push("a:end");
    });
    const b = runExclusive("conv1", async () => {
      order.push("b:start");
      await tick(1);
      order.push("b:end");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("lets different keys run concurrently", async () => {
    const order: string[] = [];
    const a = runExclusive("convA", async () => {
      order.push("A:start");
      await tick(30);
      order.push("A:end");
    });
    const b = runExclusive("convB", async () => {
      order.push("B:start");
      await tick(1);
      order.push("B:end");
    });
    await Promise.all([a, b]);
    // B (different conversation, faster) finishes before A even though
    // A was submitted first — they don't block each other.
    expect(order).toEqual(["A:start", "B:start", "B:end", "A:end"]);
  });

  it("returns the callback's resolved value", async () => {
    expect(await runExclusive("k", async () => 42)).toBe(42);
  });

  it("propagates the callback's rejection to its own caller", async () => {
    await expect(runExclusive("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  it("does not let one failed turn poison the next turn on the same key", async () => {
    const failing = runExclusive("convX", async () => { throw new Error("turn1 failed"); });
    const next = runExclusive("convX", async () => "turn2 ok");
    await expect(failing).rejects.toThrow("turn1 failed");
    // The chain absorbed the predecessor's rejection — turn2 still runs.
    expect(await next).toBe("turn2 ok");
  });
});
