import { describe, it, expect } from "vitest";
import { imagePixelSize } from "./imageSize.js";

// 各格式的最小合法文件头(只含解析需要的字节)。
const png = (w: number, h: number) => {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
// 逻辑屏幕 + 直接结束(无帧)的最小 GIF。
const gif = (w: number, h: number) => { const b = Buffer.alloc(14); b.write("GIF89a", 0, "ascii"); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); b[13] = 0x3b; return b; };
const jpeg = (w: number, h: number) => Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0(长度 4)
  0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const webpX = (w: number, h: number) => {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii"); b.write("WEBP", 8, "ascii"); b.write("VP8X", 12, "ascii");
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
};

describe("imagePixelSize", () => {
  it("PNG / GIF / JPEG / WebP(VP8X)取到宽高", () => {
    expect(imagePixelSize(png(16000, 9000))).toEqual({ width: 16000, height: 9000 });
    expect(imagePixelSize(gif(320, 240))).toEqual({ width: 320, height: 240 });
    expect(imagePixelSize(jpeg(4000, 3000))).toEqual({ width: 4000, height: 3000 });
    expect(imagePixelSize(webpX(16383, 16383))).toEqual({ width: 16383, height: 16383 });
  });

  it("不认识或截断的数据返回 null", () => {
    expect(imagePixelSize(Buffer.from("not an image"))).toBeNull();
    expect(imagePixelSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it("JPEG:0xFF 0x00 不是标记,与解码器一样逐字节往后扫,不会被伪装的段长度带偏", () => {
    const sof = (w: number, h: number) => [0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    // FF 00 后两字节若被当成段长度(13),会跳过紧随其后的真 SOF(16000²),落到后面的假 SOF(1×1)上。
    const crafted = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x0d, ...sof(16000, 16000), ...sof(1, 1)]);
    expect(imagePixelSize(crafted)).toEqual({ width: 16000, height: 16000 });
  });

  it("GIF:帧比逻辑屏幕大时按帧的覆盖范围算", () => {
    const b = Buffer.alloc(13 + 10 + 1 + 1 + 1 + 1);
    b.write("GIF89a", 0, "ascii");
    b.writeUInt16LE(1, 6); b.writeUInt16LE(1, 8); // 逻辑屏幕 1×1,无全局色表
    let i = 13;
    b[i] = 0x2c; b.writeUInt16LE(0, i + 1); b.writeUInt16LE(0, i + 3); b.writeUInt16LE(4000, i + 5); b.writeUInt16LE(3000, i + 7); b[i + 9] = 0;
    i += 10;
    b[i++] = 2; // LZW 最小码长
    b[i++] = 0; // 数据子块结束
    b[i] = 0x3b;
    expect(imagePixelSize(b)).toEqual({ width: 4000, height: 3000 });
  });

  it("JPEG:取第一个 SOF;EOI 之后拼接的数据(如动态照片里的视频)不参与", () => {
    const sof = (w: number, h: number) => [0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const photo = Buffer.from([0xff, 0xd8, ...sof(4032, 3024), 0xff, 0xd9, ...sof(60000, 60000)]);
    expect(imagePixelSize(photo)).toEqual({ width: 4032, height: 3024 });
  });

  it("JPEG:只接受渲染器画得出来的帧(C0 / C1 / C2、8 位、1 或 3 个分量)", () => {
    const frame = (marker: number, precision: number, comps: number) =>
      Buffer.from([0xff, 0xd8, 0xff, marker, 0x00, 0x11, precision, 0x00, 0x10, 0x00, 0x10, comps, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imagePixelSize(frame(0xc2, 8, 3))).toEqual({ width: 16, height: 16 }); // 渐进式
    expect(imagePixelSize(frame(0xc0, 8, 1))).toEqual({ width: 16, height: 16 }); // 灰度
    expect(imagePixelSize(frame(0xc3, 16, 3))).toBeNull(); // 无损:会让解码进程 abort
    expect(imagePixelSize(frame(0xc3, 8, 3))).toBeNull();
    expect(imagePixelSize(frame(0xc9, 8, 3))).toBeNull(); // 算术编码
    expect(imagePixelSize(frame(0xc1, 12, 3))).toBeNull(); // 12 位
    expect(imagePixelSize(frame(0xc0, 8, 4))).toBeNull(); // CMYK:渲染器画不出
    expect(imagePixelSize(Buffer.from("/9j/xAAUAAEAAAAAAAAAAAAAAAAAAAAA/8MAERAAEAAQAwERAAIRAAMRAP/aAAwDAQACAAMAAQAA/9k=", "base64"))).toBeNull();
  });
});
