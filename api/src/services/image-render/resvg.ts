// Shared SVG→PNG rasterization for the server-side image features (weekly
// report card, chat-share image, …). Wraps @resvg/resvg-js with the bundled
// Noto Sans SC font so CJK renders without relying on system fonts.
//
// Extracted from weekly-report-image/render.ts so multiple features share ONE
// font resolver + one rasterizer (and the same "scale down until under the size
// cap" logic) instead of each copying it.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

const FONT_FAMILY = "Noto Sans SC"; // 与内置 NotoSansSC-Regular.otf 的 name[1] family 完全一致

// 字体路径:dev(tsx 跑 src/)与 prod(node dist/)目录深度相同(都是 <api>/{src,dist}/
// services/<feature>),`../../../assets` 都指向 <api>/assets;再兜底 cwd。
// resvg 通过 fontFiles 自行读取该文件(其类型不暴露 fontBuffers)。
function resolveFontPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../assets/fonts/NotoSansSC-Regular.otf"),
    join(here, "../../../../assets/fonts/NotoSansSC-Regular.otf"),
    join(process.cwd(), "assets/fonts/NotoSansSC-Regular.otf"),
  ];
  const p = candidates.find((c) => existsSync(c));
  if (!p) throw new Error("找不到 NotoSansSC-Regular.otf;请确认 api/assets/fonts/ 随部署一并存在");
  return p;
}

let fontPathCache: string | null = null;
function fontPath(): string { return (fontPathCache ??= resolveFontPath()); }

// resvg 以 SVG 根的 width/height(px)为输出尺寸,fitTo 对带 width 属性的 SVG 不放大。
// 故把根的 width/height 按倍率改写(viewBox 保持逻辑 W×H),resvg 即按缩放后尺寸光栅化。
// 非全局 replace 只命中根标签(首个 width/height),不动内部 rect 的同名属性。
function scaleSvgRoot(svg: string, scale: number): string {
  const vb = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  if (!vb) return svg;
  const w = Math.round(Number(vb[1]) * scale);
  const h = Math.round(Number(vb[2]) * scale);
  return svg.replace(/width="[\d.]+"/, `width="${w}"`).replace(/height="[\d.]+"/, `height="${h}"`);
}

export interface RenderSvgOptions {
  /** Supersampling factors to try, in DESCENDING order. The first whose PNG is
   *  ≤ maxBytes wins; the LAST always returns regardless of size. */
  scales?: number[];
  /** Size cap in bytes (default 4.5MB — under 飞书 uploadImage's 5MB limit). */
  maxBytes?: number;
  /** Canvas background (default white). */
  background?: string;
}

/** Rasterize an SVG (logical `viewBox="0 0 W H"`) to a PNG Buffer using the
 *  bundled Noto Sans SC font. Tries each scale in turn so a tall image
 *  auto-downscales until it fits under `maxBytes`. */
export function renderSvgToPng(svg: string, opts: RenderSvgOptions = {}): Buffer {
  const { scales = [2, 1.5, 1], maxBytes = 4.5 * 1024 * 1024, background = "#ffffff" } = opts;
  const fonts = [fontPath()];
  for (let i = 0; i < scales.length; i++) {
    const resvg = new Resvg(scaleSvgRoot(svg, scales[i]!), {
      background,
      font: { fontFiles: fonts, defaultFontFamily: FONT_FAMILY, loadSystemFonts: false },
    });
    const png = Buffer.from(resvg.render().asPng());
    if (png.length <= maxBytes || i === scales.length - 1) return png;
  }
  throw new Error("renderSvgToPng: unreachable"); // last scale always returns
}

// 子进程里执行的代码(CommonJS,`node -e` 启动,不依赖 dev / prod 的文件路径):从 stdin 读参数,
// 栅格化并编码 PNG 后写到 stdout。放在独立进程而不是 worker 线程里:解码器遇到畸形图片可能
// panic 并 abort,只会带走这个子进程;超时也能用 SIGKILL 真正停掉正在执行的原生调用。
const CHILD_SOURCE = `
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const { svg, scales, maxBytes, background, fontPath, family, resvgPath } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const { Resvg } = require(resvgPath);
  const scaleSvgRoot = ${scaleSvgRoot.toString()};
  for (let i = 0; i < scales.length; i++) {
    const r = new Resvg(scaleSvgRoot(svg, scales[i]), {
      background,
      font: { fontFiles: [fontPath], defaultFontFamily: family, loadSystemFonts: false },
    });
    const png = r.render().asPng();
    if (png.length <= maxBytes || i === scales.length - 1) { process.stdout.write(png); break; }
  }
});
`;

let resvgPathCache: string | null = null;
function resvgPath(): string { return (resvgPathCache ??= createRequire(import.meta.url).resolve("@resvg/resvg-js")); }

export class RenderTimeoutError extends Error {
  constructor() { super("render timeout"); this.name = "RenderTimeoutError"; }
}

/** 同 renderSvgToPng,但整张图(栅格化 + PNG 编码)在独立子进程里完成:不阻塞事件循环,解码器崩溃
 *  也不影响 API 进程。超过 timeoutMs 时以 SIGKILL 结束子进程并抛 RenderTimeoutError;子进程异常退出
 *  时抛错。`onExit` 在子进程结束后调用(只调一次),调用方在这里释放并发名额。
 *  子进程只继承 PATH,不带 API 的环境变量(密钥等)。 */
export function renderSvgToPngInChild(
  svg: string,
  opts: RenderSvgOptions & { timeoutMs: number; onExit?: () => void },
): Promise<Buffer> {
  const { scales = [2, 1.5, 1], maxBytes = 4.5 * 1024 * 1024, background = "#ffffff", timeoutMs, onExit } = opts;
  return new Promise((resolve, reject) => {
    let payload: string;
    try {
      // 先备好参数(含字体路径):缺字体等错误在启动子进程之前就抛出,不让子进程空等到超时。
      payload = JSON.stringify({ svg, scales, maxBytes, background, fontPath: fontPath(), family: FONT_FAMILY, resvgPath: resvgPath() });
    } catch (e) {
      onExit?.();
      reject(e as Error);
      return;
    }
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    // 所有结束路径(正常、超时、崩溃、spawn 失败)都经这里:onExit 与 Promise 各只结算一次。
    const finish = (err: Error | null, png?: Buffer) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      onExit?.();
      if (err) reject(err); else resolve(png!);
    };
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, ["-e", CHILD_SOURCE], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "" },
      });
    } catch (e) {
      finish(e as Error);
      return;
    }
    // 先挂 error:文件句柄耗尽(EMFILE)等 spawn 失败时 stdio 为空,error 异步到来,且不一定有 close。
    child.once("error", (e) => finish(e));
    if (!child.stdout || !child.stdin || !child.stderr) return; // 等 error 事件收尾
    const out: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => { if (stderr.length < 2000) stderr += c.toString(); });
    timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("close", (code, signal) => {
      if (timedOut) return finish(new RenderTimeoutError());
      const png = Buffer.concat(out);
      if (code === 0 && png.length > 0) return finish(null, png);
      finish(new Error(`render process failed (code=${code} signal=${signal}): ${stderr.trim().slice(0, 300)}`));
    });
    child.stdin.on("error", () => { /* 子进程提前退出时写入会 EPIPE,close 里统一处理 */ });
    child.stdin.end(payload);
  });
}
