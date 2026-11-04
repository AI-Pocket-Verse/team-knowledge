#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 一次性脚本:验证火山引擎(豆包)语音凭据是否生效 —— 同时检查 STT 与 TTS。
//
// 它【不依赖】项目的 env.ts / 数据库 / registry,只复刻了 src/services/stt/volc.ts
// 与 src/services/tts/volc.ts 里【完全相同】的 WSS 请求头与二进制帧格式,所以验证
// 行为与生产一致,但可以独立运行。唯一依赖是 `ws`(已在本包 node_modules)。
//
// 用法(在 api/ 目录下):
//   node scripts/verify-volc-creds.mjs <APP_ID> <ACCESS_TOKEN>      # 旧版控制台
//   VOLC_API_KEY=xxx node scripts/verify-volc-creds.mjs              # 新版控制台(只需 API Key)
//   # 也可用环境变量 VOLC_APP_ID / VOLC_ACCESS_TOKEN，
//   # 并会回退读取 VOLC_STT_API_KEY / VOLC_STT_APP_ID / VOLC_STT_ACCESS_TOKEN 等
//   # 鉴权头依据火山官方文档：新版 X-Api-Key，旧版 X-Api-App-Key + X-Api-Access-Key。
//   # 按文档实现，未经真实账号验证。
//
// 可选参数:
//   --stt-resource <id>   覆盖 STT resourceId(默认 volc.bigasr.sauc.duration,按时长版)
//   --voice <name>        TTS 音色(默认 zh_female_qingxin_v2_mars_bigtts)
//   --text <文本>         TTS 测试文本(默认一句中文)
//   --stt-endpoint <wss>  覆盖 STT 接入地址
//   --tts-endpoint <wss>  覆盖 TTS 接入地址
//
// 退出码:0 = 两项都通过;1 = 有失败;2 = 参数缺失。
// ─────────────────────────────────────────────────────────────────────────────
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

// ── 参数解析 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") { printUsage(); process.exit(0); }
  if (a.startsWith("--")) { opts[a.slice(2)] = argv[i + 1]; i++; }
  else pos.push(a);
}

const appId =
  pos[0] || process.env.VOLC_APP_ID || process.env.VOLC_STT_APP_ID || process.env.VOLC_TTS_APP_ID;
const accessToken =
  pos[1] || process.env.VOLC_ACCESS_TOKEN || process.env.VOLC_STT_ACCESS_TOKEN || process.env.VOLC_TTS_ACCESS_TOKEN;

const apiKey = process.env.VOLC_API_KEY || process.env.VOLC_STT_API_KEY || process.env.VOLC_TTS_API_KEY;
// 与 src/services/volcAuth.ts 一致：有 API Key 走新版，否则旧版两件套。
const authHeaders = (resourceId) =>
  apiKey
    ? { "X-Api-Key": apiKey, "X-Api-Resource-Id": resourceId }
    : { "X-Api-App-Key": appId, "X-Api-Access-Key": accessToken, "X-Api-Resource-Id": resourceId };

const STT_ENDPOINT = opts["stt-endpoint"] || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
const STT_RESOURCE = opts["stt-resource"] || "volc.bigasr.sauc.duration";
const TTS_ENDPOINT = opts["tts-endpoint"] || "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
const TTS_RESOURCE = opts["tts-resource"] || process.env.VOLC_TTS_RESOURCE_ID || "volc.service_type.10029"; // 新版控制台可能需要 seed-tts-2.0
const VOICE = opts["voice"] || "zh_female_wanwanxiaohe_moon_bigtts";
const TTS_TEXT = opts["text"] || "你好,这是一次火山引擎语音凭据验证。";

function printUsage() {
  console.log(
    "用法: node scripts/verify-volc-creds.mjs <APP_ID> <ACCESS_TOKEN>\n" +
      "  或: VOLC_APP_ID=.. VOLC_ACCESS_TOKEN=.. node scripts/verify-volc-creds.mjs\n" +
      "  新版控制台: VOLC_API_KEY=.. node scripts/verify-volc-creds.mjs\n" +
      "  可选: --stt-resource --tts-resource --voice --text --stt-endpoint --tts-endpoint",
  );
}

if (!apiKey && (!appId || !accessToken)) {
  console.error("✗ 缺少 API_KEY，或 APP_ID + ACCESS_TOKEN。\n");
  printUsage();
  process.exit(2);
}

const logid = (headers) => (headers && headers["x-tt-logid"] ? ` X-Tt-Logid=${headers["x-tt-logid"]}` : "");
const mask = (s) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-4)}`);

// ── STT 帧构造(复刻 src/services/stt/volc.ts) ──────────────────────────────
function sttHeader(messageType, flags, serialization = 0x10, compression = 0x00) {
  const b0 = (0x1 << 4) | 0x1;
  const b1 = (messageType << 4) | (flags & 0x0f);
  const b2 = (serialization & 0xf0) | (compression & 0x0f);
  return Buffer.from([b0, b1, b2, 0x00]);
}

function checkStt() {
  return new Promise((resolve) => {
    const connectId = randomUUID();
    const ws = new WebSocket(STT_ENDPOINT, {
      headers: {
        ...authHeaders(STT_RESOURCE),
        "X-Api-Connect-Id": connectId,
      },
    });
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      resolve(r);
    };
    // 鉴权/资源错误一般在握手或 <1s 内的 4xxx 关闭里出现。握手通过且数秒内
    // 没有鉴权类错误,即认定凭据 + resourceId 被服务端接受(此处不送真实音频,
    // 不追求转写结果,只验证凭据)。
    const timer = setTimeout(
      () => done({ ok: true, detail: "握手成功;发送请求帧后无鉴权错误 → 凭据 + resourceId 已被接受" }),
      6000,
    );

    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => (body += d.toString()));
      res.on("end", () =>
        done({
          ok: false,
          detail: `握手被拒绝 HTTP ${res.statusCode} ${res.statusMessage || ""}${logid(res.headers)} ${body.slice(0, 300)}`,
        }),
      );
    });
    ws.on("open", () => {
      const config = JSON.stringify({
        user: { uid: connectId },
        audio: { format: "ogg", codec: "opus", rate: 16_000, bits: 16, channel: 1 },
        request: {
          model_name: "bigmodel",
          enable_itn: true,
          enable_punc: true,
          show_utterances: true,
          enable_speaker_info: false,
        },
      });
      // NOTE: header 之后必须跟 4 字节大端 payload 长度,再接 JSON。
      // (项目当前的 src/services/stt/volc.ts 漏了这个长度前缀 → 实测被服务端
      //  以 "declared body size does not match" 拒绝;这里用正确帧格式,才能
      //  真实校验凭据。providers 的同名 bug 需另行修复。)
      const cfgBuf = Buffer.from(config, "utf8");
      try { ws.send(Buffer.concat([sttHeader(0x1, 0x0), be32(cfgBuf.length), cfgBuf])); } catch { /* close 会兜底 */ }
    });
    ws.on("message", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const messageType = (buf[1] ?? 0) >> 4;
      const body = buf.subarray(4).toString("utf8");
      if (messageType === 0xf) { done({ ok: false, detail: `服务端错误帧: ${body.slice(0, 300)}` }); return; }
      if (messageType === 0x9) { done({ ok: true, detail: `收到结果帧 → 凭据有效: ${body.slice(0, 150)}` }); return; }
    });
    ws.on("error", (err) => done({ ok: false, detail: `连接错误: ${err.message}` }));
    ws.on("close", (code, reason) => {
      const r = (reason?.toString() || "").slice(0, 200);
      if (code === 1000) done({ ok: true, detail: "服务端正常关闭(1000) → 凭据有效" });
      else done({ ok: false, detail: `连接被关闭 code=${code} reason=${r}` });
    });
  });
}

// ── TTS 帧构造(复刻 src/services/tts/volc.ts,V3 双向流式) ─────────────────
const EV = {
  START_CONNECTION: 1, FINISH_CONNECTION: 2, START_SESSION: 100, FINISH_SESSION: 102, TASK_REQUEST: 200,
  CONNECTION_STARTED: 50, CONNECTION_FAILED: 51, CONNECTION_FINISHED: 52,
  SESSION_STARTED: 150, SESSION_FINISHED: 152, SESSION_FAILED: 153,
};
function ttsHeader(messageType, flags) {
  const b0 = (0x1 << 4) | 0x1;
  const b1 = ((messageType & 0xf) << 4) | (flags & 0xf);
  const b2 = (0x1 << 4) | 0x0; // JSON | 无压缩
  return Buffer.from([b0, b1, b2, 0x00]);
}
function be32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v, 0); return b; }
const FLAG_EVENT = 0x4;
function connFrame(eventId, payload) {
  const p = Buffer.from(payload, "utf8");
  return Buffer.concat([ttsHeader(0x1, FLAG_EVENT), be32(eventId), be32(p.length), p]);
}
function sessFrame(eventId, sessionId, payload) {
  const s = Buffer.from(sessionId, "utf8");
  const p = Buffer.from(payload, "utf8");
  return Buffer.concat([ttsHeader(0x1, FLAG_EVENT), be32(eventId), be32(s.length), s, be32(p.length), p]);
}
function parseFrame(buf) {
  if (buf.length < 4) return null;
  const messageType = (buf[1] >> 4) & 0xf;
  const flags = buf[1] & 0xf;
  let offset = 4;
  let eventId;
  let sessionId;
  if (flags & FLAG_EVENT) {
    if (buf.length < offset + 4) return null;
    eventId = buf.readUInt32BE(offset); offset += 4;
    // Server event frames carry an id string before the payload: session_id
    // for >=100, connection_id for connection-level responses (50/51/52).
    if (eventId >= 100 || (eventId >= 50 && eventId <= 52)) {
      if (buf.length < offset + 4) return null;
      const sLen = buf.readUInt32BE(offset); offset += 4;
      if (buf.length < offset + sLen) return null;
      sessionId = buf.subarray(offset, offset + sLen).toString("utf8"); offset += sLen;
    }
  }
  if (buf.length < offset + 4) return null;
  const pLen = buf.readUInt32BE(offset); offset += 4;
  if (buf.length < offset + pLen) return null;
  return { messageType, flags, eventId, sessionId, payload: buf.subarray(offset, offset + pLen) };
}

function checkTts() {
  return new Promise((resolve) => {
    const sessionId = randomUUID();
    const ws = new WebSocket(TTS_ENDPOINT, {
      headers: {
        ...authHeaders(TTS_RESOURCE),
        "X-Api-Connect-Id": sessionId,
      },
    });
    let settled = false;
    let audioBytes = 0;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      resolve({ ...r, audioBytes });
    };
    const timer = setTimeout(
      () => done({ ok: audioBytes > 0, detail: audioBytes > 0 ? "超时但已收到音频" : "超时未完成会话" }),
      25_000,
    );

    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => (body += d.toString()));
      res.on("end", () =>
        done({
          ok: false,
          detail: `握手被拒绝 HTTP ${res.statusCode} ${res.statusMessage || ""}${logid(res.headers)} ${body.slice(0, 300)}`,
        }),
      );
    });
    ws.on("open", () => { try { ws.send(connFrame(EV.START_CONNECTION, "{}")); } catch (e) { done({ ok: false, detail: e.message }); } });
    ws.on("message", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const f = parseFrame(buf);
      if (!f) return;
      if (f.messageType === 0xf) { done({ ok: false, detail: `错误帧: ${f.payload.toString("utf8").slice(0, 300)}` }); return; }
      if (f.messageType === 0xb) { audioBytes += f.payload.length; return; } // 音频块
      if (f.messageType !== 0x9) return; // 只处理 JSON 控制帧
      switch (f.eventId) {
        case EV.CONNECTION_STARTED: // 50 → 凭据已通过,开会话
          ws.send(
            sessFrame(EV.START_SESSION, sessionId, JSON.stringify({
              event: EV.START_SESSION, namespace: "BidirectionalTTS", user: { uid: sessionId },
              req_params: { speaker: VOICE, audio_params: { format: "mp3", sample_rate: 24_000 } },
            })),
          );
          return;
        case EV.SESSION_STARTED: // 150 → 送文本并立即结束会话
          ws.send(
            sessFrame(EV.TASK_REQUEST, sessionId, JSON.stringify({
              event: EV.TASK_REQUEST, namespace: "BidirectionalTTS", user: { uid: sessionId },
              req_params: { text: TTS_TEXT },
            })),
          );
          ws.send(
            sessFrame(EV.FINISH_SESSION, sessionId, JSON.stringify({
              event: EV.FINISH_SESSION, namespace: "BidirectionalTTS", user: { uid: sessionId },
            })),
          );
          return;
        case EV.SESSION_FINISHED: // 152
          try { ws.send(connFrame(EV.FINISH_CONNECTION, "{}")); } catch { /* noop */ }
          return;
        case EV.CONNECTION_FINISHED: // 52 → 收尾
          done({ ok: audioBytes > 0, detail: audioBytes > 0 ? `合成完成,收到 ${audioBytes} 字节音频` : "会话结束但未收到音频" });
          return;
        case EV.CONNECTION_FAILED: // 51
          done({ ok: false, detail: `连接失败(凭据/资源问题): ${f.payload.toString("utf8").slice(0, 300)}` });
          return;
        case EV.SESSION_FAILED: // 153
          done({ ok: false, detail: `会话失败(音色/参数问题?): ${f.payload.toString("utf8").slice(0, 300)}` });
          return;
        default:
          return; // 句子起止/元数据等,忽略
      }
    });
    ws.on("error", (err) => done({ ok: false, detail: `连接错误: ${err.message}` }));
    ws.on("close", (code, reason) => {
      if (settled) return;
      if (audioBytes > 0) done({ ok: true, detail: `连接关闭但已收到 ${audioBytes} 字节音频` });
      else done({ ok: false, detail: `连接关闭 code=${code} reason=${(reason?.toString() || "").slice(0, 200)}` });
    });
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
console.log("火山引擎语音凭据验证");
if (apiKey) {
  console.log(`  API Key:      ${mask(apiKey)}`);
} else {
  console.log(`  App ID:       ${appId}`);
  console.log(`  Access Token: ${mask(accessToken)}`);
}
console.log(`  STT:  ${STT_ENDPOINT}  (resourceId=${STT_RESOURCE})`);
console.log(`  TTS:  ${TTS_ENDPOINT}  (resourceId=${TTS_RESOURCE}, voice=${VOICE})`);
console.log("");

const stt = await checkStt();
console.log(`${stt.ok ? "✓" : "✗"} STT 实时语音识别: ${stt.detail}`);

const tts = await checkTts();
console.log(`${tts.ok ? "✓" : "✗"} TTS 语音合成:     ${tts.detail}`);

console.log("");
if (stt.ok && tts.ok) {
  console.log("✅ 两项凭据均有效。");
  process.exit(0);
}
console.log("❌ 存在失败项。常见原因:");
console.log("   • HTTP 401/403 → App ID / Access Token 错误,或该应用未开通对应能力。");
console.log("   • code=4xxx / 连接失败 → resourceId 与计费版本不符(按时长 vs 并发),或账号欠费/服务停用。");
console.log("   • 会话失败(153) → 音色名无效:在 火山控制台→语音合成→音色列表 选 bigtts 系列,用 --voice 覆盖。");
console.log("   • Access Token 填【原始值】,不要加 'Bearer ' 前缀。");
process.exit(1);
