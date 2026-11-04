import { renderSvgToPngInChild } from "../image-render/resvg.js";
import { buildChatShareSvg, type ChatShareMessage, type ChatShareOptions } from "./svg.js";

/** Selected chat messages → PNG Buffer (chat-bubble card). Reuses the shared
 *  resvg rasterizer; tall exports auto-downscale to stay under the size cap.
 *  渲染在独立子进程里进行(可能要十几秒),不阻塞事件循环;超时抛 RenderTimeoutError,
 *  `onExit` 在渲染进程结束后调用(用于释放并发名额)。 */
export function renderChatSharePng(
  messages: ChatShareMessage[],
  opts?: ChatShareOptions & { timeoutMs?: number; onExit?: () => void },
): Promise<Buffer> {
  let svg: string;
  try {
    svg = buildChatShareSvg(messages, opts);
  } catch (e) {
    // 还没起线程就失败:同样要通知调用方释放名额,否则名额永久泄漏。
    opts?.onExit?.();
    return Promise.reject(e);
  }
  const h = Number(svg.match(/viewBox="0 0 \d+(?:\.\d+)? (\d+(?:\.\d+)?)"/)?.[1] ?? 0);
  const scales = h > 5000 ? [1.5, 1] : [2, 1.5, 1];
  return renderSvgToPngInChild(svg, { scales, timeoutMs: opts?.timeoutMs ?? 60_000, onExit: opts?.onExit });
}
