export type ChatChunk =
  | { type: "token"; text: string }
  // Extended-thinking signal from models that support it (e.g. Claude
  // with --effort high|max). Two flavors:
  //   - { type: "thinking", text: "" }  — emitted once when the
  //     thinking content block opens. Lets the UI flip into a
  //     "deep-thinking" indicator even when no thinking_delta text
  //     follows (Claude Code CLI currently only signs the thinking
  //     block; raw reasoning text is not surfaced for some models).
  //   - { type: "thinking", text: "..." } — incremental thinking
  //     text. Concat in order to render the reasoning trace.
  // Non-thinking providers/models simply never yield this variant,
  // so the UI never shows the indicator. That's the "only thinking
  // models display thinking" rule, enforced by absence.
  | { type: "thinking"; text: string }
  // Paired with the first "thinking" event: marks the end of the
  // thinking block so the UI can stop pulsing and collapse the card.
  | { type: "thinking_end" }
  // 联网出处:当放开 WebSearch/WebFetch(webTools)时,模型联网命中的网页 URL。
  // 专家 agent 与总台/门控(助手自答)路径都可能触发(均放开 web 工具)。供上层做「出处」。
  | { type: "citation"; url: string; title?: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

// What the provider needs to send to the model. Signal lives
// separately on the provider call (see LLMProvider.chat) so the
// caller can hand chat() a Promise<ChatPrompt> — that lets the
// provider start spawning the CLI / opening the HTTP connection
// while retrieval and prompt-build still finish in the background.
// Net: ~1-3s shaved off TTFB on cold spawns.
export interface ChatPrompt {
  systemPrompt: string;
  history: ChatHistoryMessage[];
  userMessage: string;
}

export interface ProviderHealth {
  ok: boolean;
  reason?: string;
  version?: string;
}

// Per-call options that must be known at SPAWN time(argv / cwd 在 prompt
// promise 解析前就已固定 —— 见 chat() 的同步 spawn 说明),所以不能放进
// ChatPrompt,由调用方在 chat() 调用时同步给出。
export interface ChatCallOpts {
  /** 随消息附带的图片【绝对路径】(已落盘的本地文件)。视觉能力按 provider 实现:
   *  codex 用原生 `-i <file>` 附件;claude 放开 Read 工具 + 多轮,让模型自己读图。
   *  空/缺省 = 纯文本(行为与现状完全一致)。 */
  images?: string[];
  /** 专家 agent 与总台/门控(助手自答)路径:放开 claude 的 WebSearch/WebFetch 工具 + 多轮,
   *  让模型自己联网搜(答天气/实时类问题)。review/summary 等仍不传 = 工具全禁、单轮。codex 不支持,忽略。 */
  webTools?: boolean;
  /** 思考强度("low"|"medium"|"high"|"xhigh"|"max")。给定则【按调用覆盖】全局 LLM_EFFORT,
   *  让特定路径(如助手自答想展示思考过程)单独调高,而不必抬高所有调用的延迟/成本。
   *  缺省 = 回退 LLM_EFFORT(再缺省 = CLI 默认 medium)。codex 不支持,忽略。 */
  effort?: string;
  /** 覆盖 webTools 路径的 CLI --max-turns(工具 round-trip 轮数上限)。缺省 6。
   *  后台重任务(如自动化联网检索多轮)可调高,避免过早 error_max_turns。codex 不支持,忽略。 */
  maxTurns?: number;
}

export interface LLMProvider {
  readonly name: "claude" | "codex";
  isAvailable(): Promise<ProviderHealth>;
  // chat() begins its connection / process spawn SYNCHRONOUSLY when
  // called, then awaits `prompt` before sending it. Callers that
  // pass a Promise<ChatPrompt> get the spawn overlapped with their
  // own prompt prep (retrieval, build, summary refresh) — no extra
  // work for callers who already have a resolved prompt: a plain
  // ChatPrompt also works because await on a non-promise is free.
  //
  // The idle / hard timers inside the provider DO NOT start until
  // the prompt has been sent — long retrieval times don't get
  // mis-attributed as "CLI hung".
  chat(prompt: ChatPrompt | PromiseLike<ChatPrompt>, signal: AbortSignal, opts?: ChatCallOpts): AsyncIterable<ChatChunk>;
}
