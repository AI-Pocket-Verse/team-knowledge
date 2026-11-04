// HTTP client for feishu-sso's Feishu gateway. team-knowledge never touches the
// Feishu SDK or the user's token directly — it forwards the inbound session
// cookie to feishu-sso, which acts as the user; bot pushes use the shared
// INTERNAL_API_TOKEN. Without WHOAMI_URL (local single-user mode) every call
// fails fast with `feishu_not_configured`.
import { AUTH_API_BASE, env } from "../env.js";

/** Stable error carrying the gateway's normalized error code + HTTP status. */
export class FeishuGatewayError extends Error {
  constructor(
    public code: string,
    public status: number,
    /** Real upstream Feishu message (which scopes are missing + enable link). */
    public feishuMessage?: string,
  ) {
    super(code);
  }
}

function gatewayBase(): string {
  if (!AUTH_API_BASE) {
    throw new FeishuGatewayError("feishu_not_configured", 503, "未接入飞书：请先部署 feishu-sso 并配置 WHOAMI_URL");
  }
  return AUTH_API_BASE;
}

// 出站请求统一加超时；超时/连不上返回可区分的错误码，不让一个卡住的网关拖住调用方。
const GATEWAY_TIMEOUT_MS = 10_000;
const GATEWAY_BINARY_TIMEOUT_MS = 30_000;
async function gwFetch(url: string, init: RequestInit = {}, timeoutMs = GATEWAY_TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = (e as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new FeishuGatewayError("feishu_gateway_timeout", 504, "飞书网关(feishu-sso)响应超时");
    }
    throw new FeishuGatewayError("feishu_gateway_unreachable", 502, "无法连接飞书网关(feishu-sso)");
  }
}

async function call<T>(path: string, cookie: string): Promise<T> {
  const res = await gwFetch(`${gatewayBase()}${path}`, { headers: { cookie } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new FeishuGatewayError(body?.error ?? "feishu_upstream", res.status, body?.message);
  }
  return res.json() as Promise<T>;
}

export const feishuGateway = {
  getDocxMeta: (cookie: string, documentId: string) =>
    call<{ title: string }>(`/feishu/docx/${encodeURIComponent(documentId)}`, cookie),

  listDocxBlocks: (cookie: string, documentId: string) =>
    call<{ blocks: unknown[] }>(`/feishu/docx/${encodeURIComponent(documentId)}/blocks`, cookie),

  resolveWikiNode: (cookie: string, wikiToken: string) =>
    call<{ objType: string; objToken: string }>(
      `/feishu/wiki/node?token=${encodeURIComponent(wikiToken)}`,
      cookie,
    ),

  listBitableFields: (cookie: string, appToken: string, tableId: string) =>
    call<{ fields: string[] }>(
      `/feishu/bitable/${encodeURIComponent(appToken)}/${encodeURIComponent(tableId)}/fields`,
      cookie,
    ),

  listBitableRecords: (cookie: string, appToken: string, tableId: string) =>
    call<{ records: Array<Record<string, unknown>> }>(
      `/feishu/bitable/${encodeURIComponent(appToken)}/${encodeURIComponent(tableId)}/records`,
      cookie,
    ),

  readSheetRange: (cookie: string, sheetToken: string, sheetId: string) =>
    call<{ values: unknown[][] }>(
      `/feishu/sheet/${encodeURIComponent(sheetToken)}/${encodeURIComponent(sheetId)}/values`,
      cookie,
    ),

  downloadMedia: (cookie: string, fileToken: string) =>
    binary(`/feishu/media/${encodeURIComponent(fileToken)}`, cookie, "application/octet-stream"),

  downloadWhiteboardImage: (cookie: string, whiteboardId: string) =>
    binary(`/feishu/board/${encodeURIComponent(whiteboardId)}/image`, cookie, "image/png"),

  getWhiteboardNodes: (cookie: string, whiteboardId: string) =>
    call<{ nodes: Array<Record<string, unknown>> }>(
      `/feishu/board/${encodeURIComponent(whiteboardId)}/nodes`,
      cookie,
    ),

  // Bot push (app→app, NOT user-scoped): send an interactive card to a user by
  // open_id via feishu-sso's internal notify endpoint. Authed with the shared
  // INTERNAL_API_TOKEN header instead of a session cookie.
  notify: async (openId: string, card: unknown): Promise<{ messageId: string }> => {
    const res = await gwFetch(`${gatewayBase()}/feishu/notify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_API_TOKEN },
      body: JSON.stringify({ openId, card }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      throw new FeishuGatewayError(body?.error ?? "feishu_upstream", res.status, body?.message);
    }
    return res.json() as Promise<{ messageId: string }>;
  },

  // 把一张本地图片上传到飞书素材库换 image_key(供卡片 img 元素引用)。走 feishu-sso
  // 的内部端点(octet-stream + INTERNAL_API_TOKEN),tenant token 上传,与 notify
  // 同一信任边界。
  uploadImage: async (bytes: Buffer): Promise<{ imageKey: string }> => {
    const res = await gwFetch(`${gatewayBase()}/feishu/upload-image`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-internal-token": env.INTERNAL_API_TOKEN },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      throw new FeishuGatewayError(body?.error ?? "feishu_upstream", res.status, body?.message);
    }
    return res.json() as Promise<{ imageKey: string }>;
  },

  // Bot push to a CHAT (chat_id,p2p 或群;机器人须在群里)— 群通知(如
  // 「角色 Skill 已更新」)走这条,与 notify 同一内部端点、同一鉴权。
  notifyChat: async (chatId: string, card: unknown): Promise<{ messageId: string }> => {
    const res = await gwFetch(`${gatewayBase()}/feishu/notify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_API_TOKEN },
      body: JSON.stringify({ chatId, card }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      throw new FeishuGatewayError(body?.error ?? "feishu_upstream", res.status, body?.message);
    }
    return res.json() as Promise<{ messageId: string }>;
  },

  // Bot REPLY to a received message (引用原消息) with a card —— 群聊智能答疑用。
  // 与 notify 同一内部端点信任边界(INTERNAL_API_TOKEN);reply 复用机器人发送权限
  // im:message:send_as_bot,无需额外权限。messageId 是入站事件的 open_message_id。
  replyInChat: async (messageId: string, card: unknown): Promise<{ messageId: string }> => {
    const res = await gwFetch(`${gatewayBase()}/feishu/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_API_TOKEN },
      body: JSON.stringify({ messageId, card }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      throw new FeishuGatewayError(body?.error ?? "feishu_upstream", res.status, body?.message);
    }
    return res.json() as Promise<{ messageId: string }>;
  },

  // Bot「点赞」一条收到的群消息 —— 给该消息加一个表情回复(如 👍)。群答疑觉得
  // 某条消息「好」时调这条。与 notify/reply 同一内部端点信任边界(INTERNAL_API_TOKEN);
  // 但飞书侧需机器人「发送、删除消息表情回复」(im:message.reactions:write_only,应用身份)
  // 权限,改权限后须发布新版本才生效。messageId 是入站事件的 open_message_id(om_*)。
  react: async (messageId: string, emojiType: string): Promise<void> => {
    const res = await gwFetch(`${gatewayBase()}/feishu/reaction`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_API_TOKEN },
      body: JSON.stringify({ messageId, emojiType }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      throw new FeishuGatewayError(body?.error ?? "feishu_upstream", res.status, body?.message);
    }
  },
};

async function binary(
  path: string,
  cookie: string,
  fallbackMime: string,
): Promise<{ bytes: Buffer; mime: string }> {
  const res = await gwFetch(`${gatewayBase()}${path}`, { headers: { cookie } }, GATEWAY_BINARY_TIMEOUT_MS);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new FeishuGatewayError(body?.error ?? "feishu_upstream", res.status, body?.message);
  }
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    mime: res.headers.get("content-type") ?? fallbackMime,
  };
}
