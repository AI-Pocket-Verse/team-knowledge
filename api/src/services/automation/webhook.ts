import { L, appLang, type Lang } from "../../utils/lang.js";
// 自动化投递:把 AI 产出 POST 到用户填的飞书机器人 webhook。
//   - 安全:仅允许飞书/Lark 官方机器人 webhook 域(堵 SSRF —— 服务端不代 POST 任意 URL)。
//   - 从 AI 输出里提取飞书消息 JSON(优先 ```json 代码块;否则首个可解析的 {…});
//     带 msg_type 直接用,否则当作 interactive card 包一层;都取不到则退化成 text 消息。
//   - 校验 JSON 合法后 POST;失败(网络/5xx/飞书 code≠0)重试;返回 {ok, httpStatus, error}。

const ALLOWED_HOSTS = new Set(["open.feishu.cn", "open.larksuite.com"]);
const HOOK_PATH = "/open-apis/bot/v2/hook/";

/** retryable=false 表示确定性失败(域不合法 / 4xx),整轮重跑也不会变好。 */
export interface DeliveryResult { ok: boolean; httpStatus?: number; error?: string; retryable?: boolean }

/** webhook 是否为合法的飞书/Lark 机器人 webhook(域白名单 + 路径前缀)。 */
export function isAllowedWebhook(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname) && u.pathname.startsWith(HOOK_PATH);
}

// 从文本里抠出飞书消息 JSON。优先 ```json 代码块;否则扫描【所有】顶层平衡的 {…},
// 优先取「像飞书消息体」的(含 msg_type/card/elements/header/config),多个则取最后一个;
// 都不像则取最后一个可解析对象 —— 模型常先写解释再在末尾给最终 JSON,取「第一个」易误选散文里的示例对象。
// 导出给阅读页渲染(render.ts)复用同一套「从产出里抠飞书卡片」逻辑。
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; }
    catch { return null; }
  };
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { const p = tryParse(fence[1].trim()); if (p) return p; }

  // 扫描所有顶层平衡对象(跳过字符串内的假括号;解析成功后跳到该对象之后,不重复解析其嵌套子对象)。
  const candidates: Record<string, unknown>[] = [];
  let i = text.indexOf("{");
  while (i >= 0) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end >= 0) {
      const p = tryParse(text.slice(i, end + 1));
      if (p) candidates.push(p);
      i = text.indexOf("{", end + 1);
    } else {
      i = text.indexOf("{", i + 1);
    }
  }
  if (candidates.length === 0) return null;
  const shaped = candidates.filter((c) => typeof c.msg_type === "string" || !!c.card || !!c.elements || !!c.header || !!c.config);
  return shaped.length ? shaped[shaped.length - 1] : candidates[candidates.length - 1];
}

// 把通用 markdown 转成飞书 lark_md 能渲染的文本。飞书 lark_md 支持 **加粗** / *斜体* /
// ~~删除线~~ / [文本](链接),但【不支持】# 标题、- 列表、> 引用、--- 分隔线 —— 这些原样
// 发出去就会露出 markdown 记号(见反馈截图)。这里按行归一化:标题→加粗、列表→圆点、
// 引用去记号、分隔线→横线;行内的 **加粗** 和 [文本](链接) 本就兼容,原样保留。
export function markdownToLarkMd(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      // ATX 标题 `# xxx` ~ `###### xxx` → 加粗(去掉行首/行尾的 # 记号)
      const h = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
      if (h) {
        const t = h[1].trim();
        if (!t) return "";                          // 空标题 → 空行(避免生成 ****)
        if (/^\*\*[\s\S]+\*\*$/.test(t)) return t;  // 标题本身已加粗 → 不再重复包 **(避免 ****x****)
        return `**${t}**`;
      }
      // 无序列表 -、*、+ → 圆点(lark_md 不渲染 markdown 列表)
      const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (ul) return `${ul[1]}• ${ul[2]}`;
      // 分隔线 ---、***、___ → 一条可见横线
      if (/^\s{0,3}([-*_])\1{2,}\s*$/.test(line)) return "────────";
      // 引用 `> xxx` → 去掉记号
      const q = line.match(/^\s{0,3}>\s?(.*)$/);
      if (q) return q[1];
      return line;
    })
    .join("\n");
}

/** 把 AI 输出转成飞书 webhook 请求体。带 msg_type 直接用;是卡片对象则包 interactive;
 *  取不到 JSON 时不再发原始 markdown 纯文本,而是转成 lark_md 卡片,让标题/加粗/链接正常渲染。 */
export function buildFeishuPayload(aiOutput: string): Record<string, unknown> {
  const obj = extractJsonObject(aiOutput);
  if (obj) {
    if (typeof obj.msg_type === "string") return obj;                 // 已是完整请求体
    if (obj.elements || obj.header || obj.config) return { msg_type: "interactive", card: obj }; // 卡片对象
    return { msg_type: "interactive", card: obj };
  }
  // 退化:markdown → lark_md 卡片(与网页阅读页的渲染观感一致)。
  // 飞书交互卡片有整体体积上限(~30KB);中文约 3 字节/字,这里保守限 5000 字(≈15KB,留足余量),
  // 超长则截断并加提示,避免超大卡片被飞书判 code≠0 投递失败。截断在转换前做,避免切断行内标记。
  const FEISHU_MD_MAX = 5000;
  const truncated = aiOutput.length > FEISHU_MD_MAX;
  const md = markdownToLarkMd(aiOutput.slice(0, FEISHU_MD_MAX)) + (truncated ? L(appLang(), "\n\n…(内容较长,已截断)", "\n\n… (content too long, truncated)") : "");
  const content = md.trim() || L(appLang(), "(无内容)", "(no content)"); // 兜底:lark_md 内容不能为空,否则飞书拒收
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      elements: [{ tag: "div", text: { tag: "lark_md", content } }],
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** POST 到飞书 webhook。仅白名单域;失败重试 2 次。飞书成功判据:HTTP 200 且 body.code===0(或无 code)。 */
export async function deliverToFeishu(webhookUrl: string, aiOutput: string): Promise<DeliveryResult> {
  if (!isAllowedWebhook(webhookUrl)) return { ok: false, retryable: false, error: L(appLang(), "webhook 域不在白名单(仅支持飞书/Lark 机器人 webhook)", "Webhook domain is not allowed (only Feishu / Lark bot webhooks are supported)") };
  const body = JSON.stringify(buildFeishuPayload(aiOutput));
  let last: DeliveryResult = { ok: false, error: L(appLang(), "未执行", "Not executed") };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    try {
      // redirect:"error":白名单只校验首个 URL host,禁止跟随 3xx 跳到白名单外(SSRF 硬化);飞书正常不重定向。
      const res = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ac.signal, redirect: "error" });
      const text = await res.text().catch(() => "");
      let code: number | undefined;
      try { code = (JSON.parse(text) as { code?: number }).code; } catch { /* 非 JSON 响应 */ }
      if (res.ok && (code === undefined || code === 0)) return { ok: true, httpStatus: res.status };
      last = { ok: false, httpStatus: res.status, error: L(appLang(), `飞书返回 ${res.status}${code !== undefined ? ` code=${code}` : ""}: ${text.slice(0, 200)}`, `Feishu returned ${res.status}${code !== undefined ? ` code=${code}` : ""}: ${text.slice(0, 200)}`) };
      if (res.status < 500 && res.status !== 429) return { ...last, retryable: false }; // 4xx(除 429)确定性错误,不重试
    } catch (e) {
      last = { ok: false, error: (e as Error).name === "AbortError" ? L(appLang(), "投递超时", "Delivery timed out") : (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 3) await sleep(attempt * 800);
  }
  return last;
}
