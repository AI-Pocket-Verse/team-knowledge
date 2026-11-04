import { describe, it, expect } from "vitest";
import { renderSvgToPng, renderSvgToPngInChild, RenderTimeoutError } from "./resvg.js";
import { buildChatShareSvg } from "../chat-share-image/svg.js";

const svgOf = (n: number) => buildChatShareSvg([{ role: "user", content: "啊".repeat(n) }]);

// 59 字节的无损 JPEG(SOF3,3 分量,16 位精度):resvg 解码时 panic 并 abort 所在进程。
const LOSSLESS_JPEG = Buffer.from("/9j/xAAUAAEAAAAAAAAAAAAAAAAAAAAA/8MAERAAEAAQAwERAAIRAAMRAP/aAAwDAQACAAMAAQAA/9k=", "base64");

describe("renderSvgToPngInChild", () => {
  it("与主线程同步渲染逐字节一致(内置中文字体在子进程里同样生效)", async () => {
    const svg = svgOf(30);
    const inChild = await renderSvgToPngInChild(svg, { scales: [1], timeoutMs: 60_000 });
    expect(inChild.equals(renderSvgToPng(svg, { scales: [1] }))).toBe(true);
  }, 60_000);

  it("体积超限时按倍率逐级重绘,最后一档总能返回", async () => {
    const png = await renderSvgToPngInChild(svgOf(20), { scales: [2, 1], maxBytes: 1, timeoutMs: 60_000 });
    expect(png.readUInt32BE(16)).toBe(720); // 落到 1x:IHDR 宽 = 720
  }, 60_000);

  it("超时结束渲染进程:抛 RenderTimeoutError,onExit 在进程结束后调用一次", async () => {
    let exits = 0;
    await expect(
      renderSvgToPngInChild(svgOf(3000), { scales: [2], timeoutMs: 300, onExit: () => { exits++; } }),
    ).rejects.toBeInstanceOf(RenderTimeoutError);
    expect(exits).toBe(1);
  }, 60_000);

  it("解码器崩溃只结束子进程:返回错误,当前进程不受影响", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><image width="64" height="64" href="data:image/jpeg;base64,${LOSSLESS_JPEG.toString("base64")}"/></svg>`;
    let exits = 0;
    await expect(renderSvgToPngInChild(svg, { scales: [1], timeoutMs: 60_000, onExit: () => { exits++; } })).rejects.toThrow(/render process failed/);
    expect(exits).toBe(1);
  }, 60_000);
});
