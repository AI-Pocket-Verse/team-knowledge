import { L, appLang } from "../utils/lang.js";
// 火山引擎语音服务(STT / TTS)的鉴权请求头。
// 依据官方文档「大模型流式语音识别 API」(https://www.volcengine.com/docs/6561/1354869)与
// 「双向流式语音合成」(https://www.volcengine.com/docs/6561/1329505)：
//   - 新版控制台：只用 X-Api-Key（API Key）+ X-Api-Resource-Id
//   - 旧版控制台：X-Api-App-Key（APP ID）+ X-Api-Access-Key（Access Token）+ X-Api-Resource-Id
// 配置了 API Key 就走新版，否则走旧版两件套。按文档实现，未经真实账号验证。
export interface VolcAuthCreds {
  apiKey?: string;
  appId?: string;
  accessToken?: string;
}

export function volcAuthHeaders(creds: VolcAuthCreds, resourceId: string): Record<string, string> {
  if (creds.apiKey) return { "X-Api-Key": creds.apiKey, "X-Api-Resource-Id": resourceId };
  if (!creds.appId || !creds.accessToken) throw new Error(L(appLang(), "火山凭据缺少 API Key 或 APP ID + Access Token", "Volcengine credentials are missing an API key or APP ID + Access Token"));
  return {
    "X-Api-App-Key": creds.appId,
    "X-Api-Access-Key": creds.accessToken,
    "X-Api-Resource-Id": resourceId,
  };
}

/** GET 接口回显用：只露出末 4 位，PUT 时原样回传表示「不修改」。 */
export const SECRET_MASK_PREFIX = "****";
export function maskSecret(v: string | undefined | null): string | null {
  if (!v) return null;
  return SECRET_MASK_PREFIX + (v.length > 8 ? v.slice(-4) : "");
}
export function isMaskedSecret(v: string): boolean {
  return v.startsWith(SECRET_MASK_PREFIX);
}
