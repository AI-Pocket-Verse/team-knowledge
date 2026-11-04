// 只读文件头取图片的像素宽高(PNG / JPEG / GIF / WebP),不解码像素。
// 用途:服务端把图片嵌进 SVG 再栅格化前,先挡住「文件很小、像素极大」的图片——
// 解码后按 宽×高×4 字节占内存,16000×16000 的纯色 PNG 只有几百 KB,解码却要约 1GB。
// 识别不了的返回 null,调用方应按「不可信」处理(跳过)。

export interface PixelSize { width: number; height: number }

export function imagePixelSize(buf: Buffer): PixelSize | null {
  // PNG:8 字节签名 + IHDR(宽高在偏移 16 / 20)
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF:解码器按帧尺寸分配内存,帧可以比逻辑屏幕大。遍历全部图像描述符,
  // 取逻辑屏幕与各帧覆盖范围(偏移 + 尺寸)的最大值;结构读不通时返回 null。
  if (buf.length >= 13 && buf.toString("ascii", 0, 3) === "GIF") {
    let width = buf.readUInt16LE(6);
    let height = buf.readUInt16LE(8);
    let i = 13;
    const flags = buf[10]!;
    if (flags & 0x80) i += 3 * 2 ** ((flags & 0x07) + 1);
    const skipSubBlocks = (): boolean => {
      while (i < buf.length) {
        const n = buf[i]!;
        i += 1 + n;
        if (n === 0) return true;
      }
      return false;
    };
    for (;;) {
      if (i >= buf.length) return null;
      const b = buf[i]!;
      if (b === 0x3b) break; // trailer
      if (b === 0x21) { i += 2; if (!skipSubBlocks()) return null; continue; }
      if (b !== 0x2c || i + 10 > buf.length) return null;
      width = Math.max(width, buf.readUInt16LE(i + 1) + buf.readUInt16LE(i + 5));
      height = Math.max(height, buf.readUInt16LE(i + 3) + buf.readUInt16LE(i + 7));
      const lf = buf[i + 9]!;
      i += 10;
      if (lf & 0x80) i += 3 * 2 ** ((lf & 0x07) + 1);
      i += 1; // LZW 最小码长
      if (!skipSubBlocks()) return null;
    }
    return { width, height };
  }
  // WebP:RIFF....WEBP + VP8 / VP8L / VP8X 块
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return null;
  }
  // JPEG:与解码器(jpeg-decoder)读标记的方式一致——找 0xFF、跳过填充的 0xFF,
  // 0xFF 0x00 是数据里的转义字节而不是标记,继续逐字节扫;带长度的段按长度跳过。
  // 取第一个 SOFn(C0–CF,排除 C4 DHT / C8 / CC DAC),与解码器口径一致;不能取全文件最大值——
  // 动态照片等会在 EOI 之后拼接视频数据,里面的随机字节会被误认成巨大的 SOF。
  // 只接受渲染器(resvg)画得出来的帧:基线 / 扩展 / 渐进式(C0 / C1 / C2)、8 位精度、1 或 3 个分量。
  // 其余(无损、算术编码、12 位、CMYK 等)返回 null:轻则画成空白框,无损帧还会让解码线程
  // 直接中止、带崩整个进程,或解码内存远超按像素估算的开销。
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      let j = i + 1;
      while (j < buf.length && buf[j] === 0xff) j++;
      if (j >= buf.length) break;
      const marker = buf[j]!;
      if (marker === 0xd9) return null; // EOI 之前没有 SOF:解码器同样无法解码
      if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i = j + 1; // 不是标记,或是无长度的标记
        continue;
      }
      if (j + 2 >= buf.length) break;
      const len = buf.readUInt16BE(j + 1);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && j + 8 <= buf.length) {
        if (marker > 0xc2 || j + 9 > buf.length) return null;
        const precision = buf[j + 3]!;
        const components = buf[j + 8]!;
        if (precision !== 8 || (components !== 1 && components !== 3)) return null;
        return { width: buf.readUInt16BE(j + 6), height: buf.readUInt16BE(j + 4) };
      }
      i = len >= 2 ? j + 1 + len : j + 1;
    }
    return null;
  }
  return null;
}
