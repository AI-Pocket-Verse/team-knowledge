import type { FastifyReply } from "fastify";

export interface SseWriter {
  send(event: string, data: unknown): void;
  /** 心跳:写一行 SSE 注释(`: text`)。不携带事件/数据,纯粹让长时间无 token 的阶段
   *  (如等文生图,可达 120s)保持连接活着,避免反代 idle 超时掐断。前端会忽略注释行。 */
  comment(text?: string): void;
  end(): void;
}

/**
 * 客户端提前断开时 abort(正常结束不触发)。
 * POST 路由的请求流在处理器执行前已读完并销毁,`req.raw` 的 close 不会再触发;
 * 必须监听响应的 close,并用 writableEnded 区分「正常写完」与「对端提前断开」。
 * 返回解除监听的函数(处理器结束时调用)。
 */
export function abortOnClientClose(reply: FastifyReply, ac: AbortController): () => void {
  const onClose = () => { if (!reply.raw.writableEnded) ac.abort(); };
  reply.raw.once("close", onClose);
  return () => reply.raw.removeListener("close", onClose);
}

export function openSse(reply: FastifyReply): SseWriter {
  // reply.hijack() below detaches this response from Fastify's lifecycle,
  // so the onSend hook that normally sets security headers never fires.
  // Inline the headers here so the streaming body still carries the same
  // hardening (nosniff + tight CSP + no Referer).
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  });
  reply.hijack();
  let closed = false;
  // After reply.hijack() the socket is no longer managed by Fastify, so a
  // write that lands after the client disconnected (req "close" → ac.abort(),
  // but a chunk was already buffered) would throw an unhandled 'error' on the
  // raw stream and can crash the process. Mark closed on socket close/error and
  // swallow the error event so a write-after-destroy can never propagate.
  reply.raw.on("error", () => { closed = true; });
  reply.raw.on("close", () => { closed = true; });
  return {
    send(event, data) {
      if (closed || reply.raw.writableEnded || reply.raw.destroyed) return;
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      reply.raw.write(`event: ${event}\n`);
      // SSE protocol: each line of payload prefixed with `data: `,
      // event terminator is the blank line.
      for (const line of payload.split("\n")) reply.raw.write(`data: ${line}\n`);
      reply.raw.write("\n");
      // Force out the buffered write. Without this, Node may hold tokens
      // in the socket write buffer and reverse proxies that don't honor
      // `X-Accel-Buffering: no` (set in writeHead above) can ship them in
      // bursts instead of streaming.
      const sock = reply.raw.socket as { uncork?: () => void } | null;
      if (sock && typeof sock.uncork === "function") sock.uncork();
    },
    comment(text = "keep-alive") {
      if (closed || reply.raw.writableEnded || reply.raw.destroyed) return;
      // SSE 注释行以 `:` 开头,客户端忽略;`\n\n` 终止。仅用于保活,不影响应用状态。
      reply.raw.write(`: ${text.replace(/\n/g, " ")}\n\n`);
      const sock = reply.raw.socket as { uncork?: () => void } | null;
      if (sock && typeof sock.uncork === "function") sock.uncork();
    },
    end() {
      if (closed || reply.raw.writableEnded || reply.raw.destroyed) return;
      closed = true;
      reply.raw.end();
    },
  };
}
