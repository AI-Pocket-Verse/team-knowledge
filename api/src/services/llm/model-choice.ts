import { env as procEnv } from "node:process";

// 每个 AI 引擎实际使用的模型 ID。优先级：管理后台设置 > .env(CLAUDE_MODEL / CODEX_MODEL)
// > 不传(用命令行自己的默认模型)。后台设置存在 Setting 表(见 settings.ts 的 setLlmModel),
// 启动时与保存时写进这里的内存覆盖值，provider 在每次 spawn 时读取，切换对新发起的调用立即生效。
// 本模块不依赖数据库，provider 与测试可以直接引用。

export type ModelEngine = "claude" | "codex";

const ENV_KEY: Record<ModelEngine, "CLAUDE_MODEL" | "CODEX_MODEL"> = {
  claude: "CLAUDE_MODEL",
  codex: "CODEX_MODEL",
};

// 模型 ID 会作为命令行参数值传给 CLI：只允许字母数字开头，避免被当成其他参数。
// 例：opus、sonnet、claude-opus-5-5、claude-sonnet-5-5[1m]、gpt-6.1-sol、openai/gpt-oss:20b。
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/;

export function isValidModelId(v: string): boolean {
  return MODEL_ID_PATTERN.test(v);
}

const overrides: Record<ModelEngine, string | null> = { claude: null, codex: null };

export function setModelOverride(engine: ModelEngine, model: string | null): void {
  overrides[engine] = model;
}

/** .env 里配置的默认模型(格式不合法时视为未设置，启动校验会先报错)。 */
export function envDefaultModel(engine: ModelEngine): string | null {
  const v = procEnv[ENV_KEY[engine]]?.trim();
  return v && isValidModelId(v) ? v : null;
}

/** 当前生效的模型 ID；undefined = 不传模型参数，用 CLI 默认模型。 */
export function activeModel(engine: ModelEngine): string | undefined {
  return overrides[engine] ?? envDefaultModel(engine) ?? undefined;
}
