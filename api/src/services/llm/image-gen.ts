// 文生图(AI 生成图片):调 OpenAI 图像生成 API,把结果落盘成 /uploads url 供前端展示。
// 底层聊天模型(claude/codex CLI)不产图,故图片生成单独走这条 HTTP 调用。
//   - 模型 id 可配置(OPENAI_IMAGE_MODEL,默认 gpt-image-1;可设 gpt-image-2);
//   - 画质/尺寸可配置(OPENAI_IMAGE_QUALITY 默认 high;OPENAI_IMAGE_SIZE 默认 1024x1024,
//     gpt-image-2 支持更灵活尺寸、最大边 ≤3840);
//   - 正/负向提示词可配置(OPENAI_IMAGE_POSITIVE / OPENAI_IMAGE_NEGATIVE)。注意:OpenAI 图像 API
//     【没有】独立 negative_prompt 字段,负向词以「请避免:…」文本形式拼进 prompt(置空即关闭);
//   - 网关可配置(OPENAI_BASE_URL,默认官方,可指向代理/Azure/国内网关);
//   - 未配置 OPENAI_API_KEY 或调用失败 → 返回 null(优雅降级,上层回一句「暂不可用」,不报错)。
import { storeImageBuffer } from "../uploads/image-store.js";
import { imageGenSemaphore } from "../../utils/concurrency.js";

export type RunImageGen = (prompt: string, userId: string) => Promise<string[] | null>;

// 【每次尝试】的超时(AbortController 掐断单次 OpenAI 请求)。默认 120s;可经 OPENAI_IMAGE_TIMEOUT_MS 调。
// 关键:这是 per-attempt 而非全局——某次尝试卡死只掐这一次,不会拖垮其余重试(之前共享总超时,
// 一次卡死就吃光预算、导致末次必然超时)。gpt-image-2 medium 实测 ~37s,120s 余量充足。
const PER_ATTEMPT_TIMEOUT_MS = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS) || 120_000;
// 跨所有重试的整体墙钟上限(兜底,避免极端情况下总耗时过长)。可经 OPENAI_IMAGE_TOTAL_TIMEOUT_MS 调。
const TOTAL_TIMEOUT_MS = Number(process.env.OPENAI_IMAGE_TOTAL_TIMEOUT_MS) || 300_000;
const ACQUIRE_TIMEOUT_MS = 30_000;
const PROMPT_MAX = 4000;
// 瞬时失败(网络错误 / 本次尝试超时 / 429 / 5xx)时的最大尝试次数(含首次)。可经 OPENAI_IMAGE_RETRIES 调。
const MAX_ATTEMPTS = Math.max(1, Number(process.env.OPENAI_IMAGE_RETRIES) || 3);

// 正/负向提示词默认值(可被 env 覆盖;设为空串即关闭对应段)。正向=统一拔高画质与风格;
// 负向=以文本形式规避 gpt-image 常见瑕疵(文字乱码、畸形手脸、杂乱背景等)。
const DEFAULT_POSITIVE = "画面干净专业、构图平衡、主体突出、配色和谐统一、细节清晰锐利、光影自然、具现代高级质感";
const DEFAULT_NEGATIVE = "文字乱码或错别字、无意义的水印与 logo、扭曲畸形的手部与面部、多余或缺失的肢体、低分辨率、模糊噪点、杂乱拥挤的背景、过曝或脏污的配色";

// 把助手扩写出的绘画提示词,拼上统一的正向(画质/风格)与负向(规避瑕疵)段。
function buildPrompt(raw: string): string {
  const positive = process.env.OPENAI_IMAGE_POSITIVE ?? DEFAULT_POSITIVE;
  const negative = process.env.OPENAI_IMAGE_NEGATIVE ?? DEFAULT_NEGATIVE;
  let out = raw.slice(0, PROMPT_MAX);
  if (positive) out += `\n\n【画质与风格】${positive}。`;
  if (negative) out += `\n【请避免】${negative}。`;
  return out;
}

// 解析 OpenAI 图像【流式】响应(SSE)。事件形如 `data: {json}\n\n`,类型 image_generation.partial_image
// (生成途中的局部图)/ image_generation.completed(最终图),各带 b64_json。返回最终图的 base64
// (completed 优先;若流被提前截断则退回最后一张局部图)。读流期间持续有数据 → 连接不被代理判空闲关闭。
// reader.read() 受外层 AbortController 控制:abort 时抛错,由调用方按瞬时故障重试。
export async function readImageStream(body: ReadableStream<Uint8Array>, onPartial?: (n: number) => void): Promise<string | null> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let sbuf = "";
  let finalB64: string | null = null;
  let lastB64: string | null = null;
  let partials = 0;
  // 解析单个 SSE 事件块(可能含多行,取首个 data: 行)。
  const handleEvent = (chunk: string): void => {
    const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) return;
    const data = dataLine.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let evt: { type?: string; b64_json?: string };
    try { evt = JSON.parse(data) as typeof evt; } catch { return; }
    if (typeof evt.b64_json === "string" && evt.b64_json) {
      lastB64 = evt.b64_json;
      if (typeof evt.type === "string" && evt.type.includes("completed")) finalB64 = evt.b64_json;
      else { partials += 1; onPartial?.(partials); }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // 每个事件携带 ~1.8MB base64;只从【新增字节】起找分隔符(回退 1 字节防 \n\n 跨界),
    // 避免每次 read 都从 0 重扫整个增长缓冲(O(n²))。
    const prevLen = sbuf.length;
    sbuf += dec.decode(value, { stream: true });
    let from = Math.max(0, prevLen - 1);
    let idx: number;
    while ((idx = sbuf.indexOf("\n\n", from)) >= 0) {
      handleEvent(sbuf.slice(0, idx));
      sbuf = sbuf.slice(idx + 2);
      from = 0;
    }
  }
  sbuf += dec.decode(); // 收尾:flush 多字节解码器尾部
  // 流末尾未以 \n\n 结尾的残留事件也要解析,否则最后的 completed(最终图)会被丢掉。
  if (sbuf.trim()) handleEvent(sbuf);
  return finalB64 || lastB64;
}

// 失败一律返回 null(上层回一句「暂不可用」,不向用户泄漏内部细节)。但服务端日志按
// 【可 grep 的类别】分别记录,便于运维一眼区分:no-key(没配 key)/ busy(并发满)/
// http(网关报错)/ empty(响应无图)/ store(落盘失败)/ error(网络/超时等)。
export const generateImages: RunImageGen = async (prompt, userId) => {
  // 服务端按【可 grep 的类别】记录生图过程,便于运维定位(no-key/busy/http/empty/store/error)。
  const imgLog = (msg: string): void => { console.warn(msg); };
  const key = process.env.OPENAI_API_KEY;
  if (!key) { imgLog("[image-gen] skip(no-key): 未配置 OPENAI_API_KEY"); return null; }
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const size = process.env.OPENAI_IMAGE_SIZE || "1024x1024";
  // quality 默认 medium:实测 gpt-image-2 在 quality=high 下单张需 60~120s+(易超时→整轮无图),
  // medium 约 37s、质量已足够;high 想要更精细可显式开(自担时延)。置空字符串则不传该字段。
  const quality = process.env.OPENAI_IMAGE_QUALITY ?? "medium";
  // 流式生成(默认开)。关键:gpt-image-2 生成复杂图常 60~75s,生成期间连接长时间【无数据】,
  // 经本地/公司代理(clash 等)时空闲隧道会被代理按 idle-timeout 关闭 → undici `UND_ERR_SOCKET
  // other side closed`(实测短 prompt ~37s 能过、长 prompt ~64s 必挂)。开启 stream + partial_images
  // 后,生成途中持续推送局部图,连接一直有数据流 → 不再被判空闲关闭(实测 74s 也稳过)。
  // 网关不支持 SSE 时可设 OPENAI_IMAGE_STREAM=0 退回一次性 JSON。
  const wantStream = (process.env.OPENAI_IMAGE_STREAM ?? "1") !== "0";
  // 局部图次数 0~3。容错:非数字配置 → 回退 3(否则 NaN 会被 JSON 序列化成 null → OpenAI 400 且不可重试)。
  const partialsRaw = Number(process.env.OPENAI_IMAGE_PARTIALS ?? 3);
  const partialImages = Math.min(3, Math.max(0, Number.isFinite(partialsRaw) ? Math.floor(partialsRaw) : 3));
  // body 只带广泛支持的字段(prompt/n/size/quality[/stream]);不带 background(gpt-image-2 不支持透明背景)。
  const body: Record<string, unknown> = { model, prompt: buildPrompt(prompt), n: 1, size };
  if (quality) body.quality = quality;
  if (wantStream) { body.stream = true; body.partial_images = partialImages; }
  // 诊断:打出出网路由(base + 是否启用环境代理 + 代理地址),便于一眼判断「直连」还是「走代理」。
  const proxyInfo = `useEnvProxy=${process.env.NODE_USE_ENV_PROXY || "0"} httpsProxy=${process.env.HTTPS_PROXY || "(none)"}`;
  imgLog(`[image-gen] request model=${model} size=${size} quality=${quality || "(default)"} stream=${wantStream ? partialImages : "off"} promptLen=${(body.prompt as string).length} base=${base} ${proxyInfo}`);

  // 并发闸:满载时排队,超时则降级(不无界并发打爆网关,也不占满交互聊天的槽位)。
  let release: () => void;
  try { release = await imageGenSemaphore.acquire(ACQUIRE_TIMEOUT_MS); }
  catch { imgLog("[image-gen] busy: 生图并发已满,本次排队超时,降级"); return null; }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const startedAt = Date.now();
  try {
    // 瞬时失败重试:国内出网到官方 OpenAI 不稳(连接抖动 / 长请求中途卡死),单次失败就放弃会让整轮无图。
    // 对【网络错误 / 本次尝试超时 / 429 / 5xx】做最多 MAX_ATTEMPTS 次短退避重试;
    // 【4xx(除 429)】是确定性错误(参数/鉴权)重试无益。每次尝试【独立超时】,卡死只掐这一次;
    // 另设 TOTAL_TIMEOUT_MS 整体墙钟兜底。所有尝试共用同一并发槽。
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const last = attempt === MAX_ATTEMPTS;
      const tag = `第${attempt}/${MAX_ATTEMPTS}次`;
      // 本次尝试超时压到【剩余总预算】内:并发槽占用总时长 ≤ TOTAL_TIMEOUT_MS,不会一次卡死叠加成
      // MAX_ATTEMPTS×PER_ATTEMPT(~360s)而饿死其他生图请求。预算耗尽则不再发起新尝试。
      const remaining = TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) break;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), Math.min(PER_ATTEMPT_TIMEOUT_MS, remaining));
      const attemptStart = Date.now();
      try {
        const res = await fetch(`${base}/images/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 200);
          const retriable = res.status === 429 || res.status >= 500;
          imgLog(`[image-gen] http(${res.status}) ${tag}${retriable && !last ? " 将重试" : ""}: ${detail}`);
          if (retriable && !last && Date.now() - startedAt < TOTAL_TIMEOUT_MS) { await sleep(attempt * 800); continue; }
          return null;
        }
        let buf: Buffer | null = null;
        const isSSE = (res.headers.get("content-type") || "").includes("event-stream");
        if (wantStream && isSSE && res.body) {
          // 流式:边生成边推送局部图,保持连接活跃。累积事件,取最终图(completed),无则退而取最后一张局部图。
          const b64 = await readImageStream(res.body, (n) => imgLog(`[image-gen] stream: 收到局部图#${n} (+${Date.now() - attemptStart}ms)`));
          if (b64) buf = Buffer.from(b64, "base64");
        } else {
          const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
          const item = json.data?.[0];
          // gpt-image-1 默认回 b64_json;DALL·E 可能回 url —— 两种都兼容。
          if (item?.b64_json) buf = Buffer.from(item.b64_json, "base64");
          else if (item?.url) {
            // 图已生成,这里只是下载;下载失败/超时 → buf 留空走「empty」返回,
            // 不抛进外层重试(否则会触发整图重生,白白再付一次昂贵的生成)。
            try {
              const r = await fetch(item.url, { signal: ac.signal });
              if (r.ok) buf = Buffer.from(await r.arrayBuffer());
            } catch { /* 下载失败 → buf=null → empty 分支 */ }
          }
        }
        if (!buf || buf.length === 0) { imgLog("[image-gen] empty: 响应无图片数据"); return null; }
        try {
          // 落盘 + Upload 归属(同聊天上传),但【不计用户配额】——系统代生成,非用户主动上传。
          const stored = await storeImageBuffer(buf, userId, undefined, { quotaExempt: true });
          imgLog(`[image-gen] ok: ${stored.url} (${buf.length} bytes) ${tag}`);
          return [stored.url];
        } catch (e) {
          // 落盘失败是确定性错误(磁盘/权限),重试无益。
          imgLog(`[image-gen] store: 落盘失败: ${(e as Error).message || (e as Error).name || String(e)}`);
          return null;
        }
      } catch (e) {
        // 真实原因藏在 `e.cause`(undici 把底层错误包成外层 "fetch failed"):
        //   UND_ERR_CONNECT_TIMEOUT/ENOTFOUND/ECONNRESET = 没连上目标(直连官方被墙 / 代理抖动);
        //   ECONNREFUSED 127.0.0.1:xxxx = 配了代理但代理口没开。打出来便于一眼定位。
        const err = e as Error & { cause?: { code?: string; message?: string } };
        const cause = err.cause ? ` cause=${err.cause.code || ""}${err.cause.message ? " " + err.cause.message : ""}`.trim() : "";
        // 本次尝试超时(AbortError)与网络错误一样视为可重试瞬时故障(不再一次超时就放弃整轮)。
        const elapsed = Date.now() - attemptStart;
        const what = err.name === "AbortError" ? "本次尝试超时" : `${err.message}${cause ? " — " + cause : ""}`;
        const giveUp = last || Date.now() - startedAt >= TOTAL_TIMEOUT_MS;
        imgLog(`[image-gen] error ${tag}${giveUp ? " 放弃" : " 将重试"}: 生成失败: ${what} [耗时${elapsed}ms] (${proxyInfo})`);
        if (giveUp) return null;
        await sleep(attempt * 800);
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  } finally {
    release();
  }
};
