import { env } from "../env.js";

type OriginReq = { headers: Record<string, unknown>; protocol: string; hostname: string; host?: string };

// 请求自身的来源。反向代理后 req.host 是 127.0.0.1:<port>,不是浏览器用的公网来源,
// 所以优先取代理设置的 X-Forwarded-Host / Proto(浏览器跨站请求带不了这些头,
// 代理会覆盖写入),没有时回退 req.host(直连)。
export function requestOrigin(req: OriginReq): string | null {
  const xfHost = (req.headers["x-forwarded-host"] ?? "").toString().split(",")[0]?.trim();
  const host = xfHost || (req.host ?? req.hostname ?? "").toString();
  if (!host) return null;
  const xfProto = (req.headers["x-forwarded-proto"] ?? "").toString().split(",")[0]?.trim();
  const proto = xfProto || req.protocol || "http";
  return `${proto}://${host}`;
}

// 浏览器带来的 Origin 是否属于本站:等于 WEB_ORIGIN 或请求自身来源。
// HTTP 的 CSRF 校验与会议 WebSocket 握手共用这一份判断。
export function isAllowedOrigin(origin: string, req: OriginReq): boolean {
  if (origin === env.WEB_ORIGIN) return true;
  const self = requestOrigin(req);
  return self !== null && origin === self;
}
