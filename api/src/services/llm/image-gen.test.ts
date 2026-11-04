import { describe, it, expect } from "vitest";
import { readImageStream } from "./image-gen.js";

// 把若干字符串块拼成一个 ReadableStream<Uint8Array>(模拟 SSE 分片到达)。
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else c.close();
    },
  });
}

const partial = (b64: string): string => `data: ${JSON.stringify({ type: "image_generation.partial_image", b64_json: b64 })}\n\n`;
const completed = (b64: string): string => `data: ${JSON.stringify({ type: "image_generation.completed", b64_json: b64 })}\n\n`;

describe("readImageStream", () => {
  it("取 completed 的最终图(优先于局部图)", async () => {
    const out = await readImageStream(streamOf([partial("PARTIAL"), completed("FINAL")]));
    expect(out).toBe("FINAL");
  });

  it("(#2 回归)末尾 completed 事件没有结尾空行也不丢", async () => {
    // 最后一个事件不以 \n\n 结尾、流随即关闭 —— 残留必须被 flush 解析,否则丢最终图。
    const out = await readImageStream(streamOf([partial("PARTIAL"), `data: ${JSON.stringify({ type: "image_generation.completed", b64_json: "FINAL" })}`]));
    expect(out).toBe("FINAL");
  });

  it("只有局部图(无 completed)→ 退回最后一张局部图", async () => {
    const out = await readImageStream(streamOf([partial("P1"), partial("P2")]));
    expect(out).toBe("P2");
  });

  it("事件被切到两个分片中间也能正确拼接解析", async () => {
    const ev = completed("SPLIT");
    const mid = Math.floor(ev.length / 2);
    const out = await readImageStream(streamOf([ev.slice(0, mid), ev.slice(mid)]));
    expect(out).toBe("SPLIT");
  });

  it("局部图回调按序触发,completed 不计入局部计数", async () => {
    const seen: number[] = [];
    await readImageStream(streamOf([partial("a"), partial("b"), completed("c")]), (n) => seen.push(n));
    expect(seen).toEqual([1, 2]);
  });

  it("无图片数据 → null;[DONE]/空行被忽略不报错", async () => {
    const out = await readImageStream(streamOf(["data: [DONE]\n\n", "\n\n"]));
    expect(out).toBeNull();
  });
});
