import { getLlmProvider } from "../settings.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { CodexCliProvider } from "./codex-cli.js";
import type { LLMProvider, ProviderHealth } from "./types.js";

let cached: { provider: LLMProvider; at: number } | null = null;
const TTL_MS = 30_000;

const claude = new ClaudeCliProvider();
const codex = new CodexCliProvider();

export async function getProvider(): Promise<LLMProvider> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.provider;
  const name = await getLlmProvider();
  const provider = name === "codex" ? codex : claude;
  cached = { provider, at: now };
  return provider;
}

export function invalidateProviderCache(): void {
  cached = null;
}

export async function probeAll(): Promise<{ claude: ProviderHealth; codex: ProviderHealth }> {
  const [c, x] = await Promise.all([claude.isAvailable(), codex.isAvailable()]);
  return { claude: c, codex: x };
}

// 两个主 provider 单例最近一次对话流里探测到的真实模型名(仅供后台核对提示)。
// 注意:只读这里的【主单例】—— 后台汇总用的 Haiku 是 summary-provider.ts 里另建的
// 实例,不会污染这里,故显示的始终是「当前答疑/生成」实际用的主模型。
export function observedModels(): { claude: string | null; codex: string | null } {
  return { claude: claude.lastModel, codex: codex.lastModel };
}
