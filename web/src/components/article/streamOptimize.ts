import { API_BASE } from "@/lib/api";
import { parseSseChunk } from "@/lib/sse";
import { handleUnauthorized } from "@/lib/sseAuth";
import { tr } from "@/i18n";

// 「文档一键优化」的 SSE 消费(fetch + ReadableStream,带 cookie)。大文档优化耗时长,同步返回
// 会被网关/CDN idle 超时切断报 504;改走 SSE 后连接全程活跃(token 帧 + 心跳),前端还能显示进度。
// 契约与后端 POST /api/articles/:id/review/optimize 一致:
//   event: token → { text }        增量文本(用于进度显示 / 保活)
//   event: done  → { fixedMarkdown } 最终净化后的修订全文
//   event: error → { message }      失败/LLM 不可用/被 abort
export interface OptimizeStreamOptions {
  signal?: AbortSignal;
  /** 增量到达时回调,charsSoFar = 已生成的累计字符数,供 UI 显示「已生成 N 字」。 */
  onProgress?(charsSoFar: number): void;
}

export async function streamOptimize(
  articleId: string,
  o: OptimizeStreamOptions = {},
): Promise<{ fixedMarkdown: string; unlocated: number }> {
  const res = await fetch(`${API_BASE}/articles/${articleId}/review/optimize`, {
    method: "POST",
    credentials: "include",
    signal: o.signal,
  });
  if (!res.ok) {
    if (res.status === 401) { void handleUnauthorized(); throw new Error(tr("article.optimize.expired")); }
    if (res.status === 403) throw new Error(tr("article.optimize.forbidden"));
    if (res.status === 409) throw new Error(tr("article.optimize.busy"));
    throw new Error(tr("article.optimize.requestFailed", { status: res.status }));
  }
  if (!res.body) throw new Error(tr("article.optimize.emptyResponse"));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let chars = 0;
  let fixedMarkdown: string | null = null;
  let unlocated = 0; // 未能自动定位/应用的补丁数(部分成功时 > 0)
  let errMsg: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseChunk(buf);
    buf = rest;
    for (const evt of events) {
      if (evt.event === "token") {
        try { chars += (JSON.parse(evt.data) as { text: string }).text.length; o.onProgress?.(chars); } catch { /* skip */ }
      } else if (evt.event === "done") {
        try {
          const d = JSON.parse(evt.data) as { fixedMarkdown: string; unlocated?: number };
          fixedMarkdown = d.fixedMarkdown;
          unlocated = typeof d.unlocated === "number" ? d.unlocated : 0;
        } catch { /* skip */ }
      } else if (evt.event === "error") {
        try { errMsg = (JSON.parse(evt.data) as { message?: string }).message ?? tr("article.optimize.failed"); } catch { errMsg = tr("article.optimize.failed"); }
      }
    }
  }
  if (errMsg) throw new Error(errMsg);
  if (fixedMarkdown === null) throw new Error(tr("article.optimize.incomplete"));
  return { fixedMarkdown, unlocated };
}
