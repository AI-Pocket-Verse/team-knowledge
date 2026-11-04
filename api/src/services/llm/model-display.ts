// 「对外显示的模型型号」= 管理员手填的 curated 三段(模型 + 版本 + 等级),如
// Codex 5.6-sol high。飞书卡片 / Skill 卡片 / 后台页都以它为准,格式统一好看。
// 探测到的真实模型(providers 从 CLI 流里抓的 lastModel)只在后台做「实际检测到 X」
// 提示,供管理员核对手填是否与真在跑的一致,不参与对外显示。复用 Setting 键值,免迁移。
import { getSetting, setSetting, type LlmProviderName } from "../settings.js";
import { observedModels, getProvider } from "./registry.js";

export interface ModelDisplayFields {
  model: string;   // 模型(如 Codex / Claude)
  version: string; // 版本(如 5.6-sol / 4.8)
  level: string;   // 等级(如 high / medium)
}
export interface ModelDisplayConfig {
  claude: ModelDisplayFields;
  codex: ModelDisplayFields;
  /** 群答疑卡片是否显示模型(默认关,避免群里噪音)。 */
  showInGroupCard: boolean;
}

const KEY = "llm.model_display";
const PROVIDER_LABEL: Record<LlmProviderName, string> = { claude: "Claude Code", codex: "Codex" };

function normFields(v: unknown): ModelDisplayFields {
  const o = (v ?? {}) as Partial<ModelDisplayFields>;
  const s = (x: unknown) => (typeof x === "string" ? x.trim().slice(0, 60) : "");
  return { model: s(o.model), version: s(o.version), level: s(o.level) };
}

export async function getModelDisplayConfig(): Promise<ModelDisplayConfig> {
  const raw = await getSetting<Partial<ModelDisplayConfig>>(KEY, {});
  return {
    claude: normFields(raw.claude),
    codex: normFields(raw.codex),
    showInGroupCard: raw.showInGroupCard === true,
  };
}

export async function setModelDisplayConfig(patch: Partial<ModelDisplayConfig>, by: string): Promise<ModelDisplayConfig> {
  const cur = await getModelDisplayConfig();
  const next: ModelDisplayConfig = {
    claude: patch.claude !== undefined ? normFields(patch.claude) : cur.claude,
    codex: patch.codex !== undefined ? normFields(patch.codex) : cur.codex,
    showInGroupCard: patch.showInGroupCard === undefined ? cur.showInGroupCard : patch.showInGroupCard === true,
  };
  await setSetting(KEY, next, by);
  return next;
}

// 三段拼成显示串:「模型 版本 等级」(空段跳过);三段全空 → 回退 provider 标签。
export function composeDisplay(f: ModelDisplayFields, provider: LlmProviderName): string {
  const parts = [f.model, f.version, f.level].map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts.join(" ") : PROVIDER_LABEL[provider];
}

/** 对外显示:某 provider 的 curated 型号名(手填为准,空则 provider 标签)。
 *  入参收 string(调用方常拿到的是 provider.name):非 claude/codex 原样返回。 */
export async function resolveModelDisplay(provider: string): Promise<string> {
  if (provider !== "claude" && provider !== "codex") return provider;
  const cfg = await getModelDisplayConfig();
  return composeDisplay(cfg[provider], provider);
}

/** 群答疑卡片要显示的型号:开关关 → undefined(不显示);开 → 本次答复所用 provider 的
 *  curated 名。用 getProvider()(与 answer.ts 走同一 registry 缓存实例)而非 getLlmProvider(),
 *  避免刚切换 provider 的 30s 缓存窗口内「用旧 provider 答、卡片却标新 provider」的瞬时不一致。 */
export async function getGroupCardModel(): Promise<string | undefined> {
  const cfg = await getModelDisplayConfig();
  if (!cfg.showInGroupCard) return undefined;
  const provider = (await getProvider()).name;
  return composeDisplay(cfg[provider], provider);
}

/** 后台用:curated 配置 + 探测到的真实模型(核对提示)。 */
export async function getModelDisplayAdmin(): Promise<ModelDisplayConfig & { detected: { claude: string | null; codex: string | null } }> {
  const cfg = await getModelDisplayConfig();
  return { ...cfg, detected: observedModels() };
}
