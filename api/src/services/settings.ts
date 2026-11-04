import { env as procEnv } from "node:process";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { isValidModelId, setModelOverride } from "./llm/model-choice.js";

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}

export async function setSetting(key: string, value: unknown, updatedBy: string): Promise<void> {
  const encoded = JSON.stringify(value);
  await prisma.setting.upsert({
    where: { key },
    update: { value: encoded, updatedBy },
    create: { key, value: encoded, updatedBy },
  });
}

export type LlmProviderName = "claude" | "codex";
const LLM_KEY = "llm.provider";
const VALID: ReadonlySet<LlmProviderName> = new Set(["claude", "codex"]);

// codex 引擎带 shell 工具、只读沙箱也不限制读路径，不能暴露给多人模式(配置了 WHOAMI_URL，
// 任意登录成员都能向助手提问)。多人模式只允许 claude；本地单用户模式两者都可用。
export function codexAllowed(): boolean {
  return !env.WHOAMI_URL;
}

export async function getLlmProvider(): Promise<LlmProviderName> {
  const stored = await getSetting<LlmProviderName>(LLM_KEY, "claude");
  return stored === "codex" && !codexAllowed() ? "claude" : stored;
}

// 启动时调用：多人模式下库里残留 codex 设置则改回 claude 并留日志。
export async function enforceLlmProviderPolicy(log: { warn: (msg: string) => void }): Promise<void> {
  if (codexAllowed()) return;
  const stored = await getSetting<LlmProviderName>(LLM_KEY, "claude");
  if (stored !== "codex") return;
  await setSetting(LLM_KEY, "claude", "system");
  log.warn("LLM 引擎设置为 codex，但已启用登录(WHOAMI_URL)，codex 不允许用于多人模式，已回退为 claude");
}

export async function setLlmProvider(name: LlmProviderName, updatedBy: string): Promise<void> {
  if (!VALID.has(name)) throw new Error(`invalid llm provider: ${name}`);
  await setSetting(LLM_KEY, name, updatedBy);
}

// ─── 火山引擎 STT / TTS credentials ─────────────────────────
// Layered resolution: DB row > env var > null. The Setting row
// lets an admin rotate keys without redeploy; env vars are the
// deploy-time bootstrap default. Returning `null` when neither
// is set tells the registry to fall back to the stub provider.
//
// The stored shape is whitelisted via the *_KEYS constants — we
// don't trust arbitrary JSON to round-trip into env-shaped strings.

// 鉴权二选一：apiKey(新版控制台)，或 appId + accessToken(旧版控制台)。
export interface VolcSttCreds {
  apiKey?: string;
  appId?: string;
  accessToken?: string;
  /** Optional. Defaults baked into the provider when null. */
  endpoint?: string;
  resourceId?: string;
  /** Optional 火山 model name (request.model_name). Defaults to "bigmodel"
   *  in the provider. Switch to a faster model (paired with the matching
   *  endpoint/resourceId) when the transcript can't keep up with real time. */
  model?: string;
  /** Optional 火山「热词表」ID. When set, the STT request sends
   *  request.corpus.boosting_table_id so domain vocabulary (e.g.
   *  a domain term) wins over higher-frequency homophones. The table
   *  itself is created/maintained in the 火山 console (语音技术 → 热词). */
  boostingTableId?: string;
}

export interface VolcTtsCreds {
  apiKey?: string;
  appId?: string;
  accessToken?: string;
  /** Optional voice preset; provider defaults to a neutral CN voice. */
  voice?: string;
  endpoint?: string;
}

const VOLC_STT_KEY = "volc.stt.creds";
const VOLC_TTS_KEY = "volc.tts.creds";

function s(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export async function getVolcSttCreds(): Promise<VolcSttCreds | null> {
  // DB first
  const row = await prisma.setting.findUnique({ where: { key: VOLC_STT_KEY } });
  if (row) {
    try {
      const v = JSON.parse(row.value) as Partial<VolcSttCreds>;
      const apiKey = s(v.apiKey);
      const appId = s(v.appId);
      const accessToken = s(v.accessToken);
      if (apiKey || (appId && accessToken)) {
        return { apiKey, appId, accessToken, endpoint: s(v.endpoint), resourceId: s(v.resourceId), model: s(v.model), boostingTableId: s(v.boostingTableId) };
      }
    } catch { /* fall through to env */ }
  }
  // Env fallback
  const apiKey = s(procEnv.VOLC_STT_API_KEY);
  const appId = s(procEnv.VOLC_STT_APP_ID);
  const accessToken = s(procEnv.VOLC_STT_ACCESS_TOKEN);
  if (!apiKey && (!appId || !accessToken)) return null;
  return {
    apiKey,
    appId,
    accessToken,
    endpoint: s(procEnv.VOLC_STT_ENDPOINT),
    resourceId: s(procEnv.VOLC_STT_RESOURCE_ID),
    model: s(procEnv.VOLC_STT_MODEL),
    boostingTableId: s(procEnv.VOLC_STT_BOOSTING_TABLE_ID),
  };
}

export async function setVolcSttCreds(creds: VolcSttCreds | null, updatedBy: string): Promise<void> {
  if (creds === null) {
    await prisma.setting.deleteMany({ where: { key: VOLC_STT_KEY } });
    return;
  }
  const apiKey = s(creds.apiKey);
  const appId = s(creds.appId);
  const accessToken = s(creds.accessToken);
  if (!apiKey && (!appId || !accessToken)) throw new Error("apiKey, or appId + accessToken, is required");
  await setSetting(VOLC_STT_KEY, {
    apiKey, appId, accessToken, endpoint: s(creds.endpoint), resourceId: s(creds.resourceId),
    model: s(creds.model), boostingTableId: s(creds.boostingTableId),
  }, updatedBy);
}

export async function getVolcTtsCreds(): Promise<VolcTtsCreds | null> {
  const row = await prisma.setting.findUnique({ where: { key: VOLC_TTS_KEY } });
  if (row) {
    try {
      const v = JSON.parse(row.value) as Partial<VolcTtsCreds>;
      const apiKey = s(v.apiKey);
      const appId = s(v.appId);
      const accessToken = s(v.accessToken);
      if (apiKey || (appId && accessToken)) {
        return { apiKey, appId, accessToken, voice: s(v.voice), endpoint: s(v.endpoint) };
      }
    } catch { /* fall through to env */ }
  }
  const apiKey = s(procEnv.VOLC_TTS_API_KEY);
  const appId = s(procEnv.VOLC_TTS_APP_ID);
  const accessToken = s(procEnv.VOLC_TTS_ACCESS_TOKEN);
  if (!apiKey && (!appId || !accessToken)) return null;
  return {
    apiKey,
    appId,
    accessToken,
    voice: s(procEnv.VOLC_TTS_VOICE),
    endpoint: s(procEnv.VOLC_TTS_ENDPOINT),
  };
}

export async function setVolcTtsCreds(creds: VolcTtsCreds | null, updatedBy: string): Promise<void> {
  if (creds === null) {
    await prisma.setting.deleteMany({ where: { key: VOLC_TTS_KEY } });
    return;
  }
  const apiKey = s(creds.apiKey);
  const appId = s(creds.appId);
  const accessToken = s(creds.accessToken);
  if (!apiKey && (!appId || !accessToken)) throw new Error("apiKey, or appId + accessToken, is required");
  await setSetting(VOLC_TTS_KEY, {
    apiKey, appId, accessToken, voice: s(creds.voice), endpoint: s(creds.endpoint),
  }, updatedBy);
}

// ─── LLM CLI 可执行文件路径(claude / codex)──────────────────
// systemd 的 PATH 很精简(/usr/bin:/bin 等),不含 nvm/用户级安装目录,
// 于是 spawn 裸命令 "claude"/"codex" 直接 ENOENT,系统设置里探测显示红色 ✗。
// 这里允许管理员填可执行文件的【绝对路径】。优先级:
//   DB 行 > 环境变量 CLAUDE_BIN/CODEX_BIN > 裸命令名(走 PATH)。
// provider(claude-cli.ts / codex-cli.ts)的 bin getter 惰性读取 procEnv,
// 所以保存时把路径写进 process.env 即可对【新发起】的 spawn 立即生效,无需重启。
// 绝对路径还能绕过 systemd 的精简 PATH。

const LLM_CLAUDE_BIN_KEY = "llm.claude.bin";
const LLM_CODEX_BIN_KEY = "llm.codex.bin";

export interface LlmBinPaths {
  claudePath: string | null;
  codexPath: string | null;
}

async function getBin(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return null;
  try { return s(JSON.parse(row.value)) ?? null; } catch { return null; }
}

export async function getLlmBinPaths(): Promise<LlmBinPaths> {
  const [claudePath, codexPath] = await Promise.all([
    getBin(LLM_CLAUDE_BIN_KEY),
    getBin(LLM_CODEX_BIN_KEY),
  ]);
  return { claudePath, codexPath };
}

// 第一次用后台路径覆盖 CLAUDE_BIN / CODEX_BIN 前记下 .env 里的原值，清除后台路径时还原它；
// 直接 delete 会丢掉 .env 的配置，退回裸命令名，直到重启才恢复。
const envBinBeforeOverride = new Map<string, string | undefined>();

function overrideBinEnv(envVar: "CLAUDE_BIN" | "CODEX_BIN", path: string | null): void {
  if (!envBinBeforeOverride.has(envVar)) envBinBeforeOverride.set(envVar, procEnv[envVar]);
  if (path) {
    procEnv[envVar] = path;
    return;
  }
  const original = envBinBeforeOverride.get(envVar);
  if (original === undefined) delete procEnv[envVar];
  else procEnv[envVar] = original;
}

export async function setLlmBinPath(
  which: "claude" | "codex",
  path: string | null,
  updatedBy: string,
): Promise<void> {
  const key = which === "claude" ? LLM_CLAUDE_BIN_KEY : LLM_CODEX_BIN_KEY;
  const envVar = which === "claude" ? "CLAUDE_BIN" : "CODEX_BIN";
  const clean = s(path ?? undefined);
  if (!clean) {
    await prisma.setting.deleteMany({ where: { key } });
    overrideBinEnv(envVar, null);   // 回退到 .env / PATH
    return;
  }
  await setSetting(key, clean, updatedBy);
  overrideBinEnv(envVar, clean);    // 立即对新 spawn 生效
}

// 启动时调用:把 DB 里配置的路径写进 process.env,使其在本进程任何 spawn
// 之前就生效(DB 优先于部署期写入的 CLAUDE_BIN/CODEX_BIN env)。
export async function applyLlmBinPathsToEnv(): Promise<void> {
  const { claudePath, codexPath } = await getLlmBinPaths();
  if (claudePath) overrideBinEnv("CLAUDE_BIN", claudePath);
  if (codexPath) overrideBinEnv("CODEX_BIN", codexPath);
}

// ─── 各引擎使用的模型(claude / codex)──────────────────────────
// 管理后台「AI 引擎」页为每个引擎选择模型 ID。优先级：DB 行 > .env 的 CLAUDE_MODEL / CODEX_MODEL
// > 不传(用 CLI 默认模型)，解析逻辑在 llm/model-choice.ts。保存时同步写进内存覆盖值，
// 对新发起的调用立即生效，无需重启。

const LLM_MODEL_KEY: Record<LlmProviderName, string> = {
  claude: "llm.claude.model",
  codex: "llm.codex.model",
};

export interface LlmModelChoice {
  claude: string | null;
  codex: string | null;
}

export async function getLlmModels(): Promise<LlmModelChoice> {
  const [claude, codex] = await Promise.all([getBin(LLM_MODEL_KEY.claude), getBin(LLM_MODEL_KEY.codex)]);
  return {
    claude: claude && isValidModelId(claude) ? claude : null,
    codex: codex && isValidModelId(codex) ? codex : null,
  };
}

export async function setLlmModel(which: LlmProviderName, model: string | null, updatedBy: string): Promise<void> {
  const clean = s(model ?? undefined);
  if (!clean) {
    await prisma.setting.deleteMany({ where: { key: LLM_MODEL_KEY[which] } });
    setModelOverride(which, null);
    return;
  }
  if (!isValidModelId(clean)) throw new Error(`invalid model id: ${clean}`);
  await setSetting(LLM_MODEL_KEY[which], clean, updatedBy);
  setModelOverride(which, clean);
}

// 启动时调用：把 DB 里选择的模型写进内存覆盖值，使其在本进程任何 spawn 之前生效。
export async function applyLlmModelsFromDb(): Promise<void> {
  const models = await getLlmModels();
  setModelOverride("claude", models.claude);
  setModelOverride("codex", models.codex);
}
