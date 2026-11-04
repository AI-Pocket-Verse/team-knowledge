// 界面语言的纯逻辑部分(不依赖 React)，便于单测，也供 api.ts 这类非组件代码读取当前语言。

export const LANGS = ["zh", "en"] as const;
export type Lang = (typeof LANGS)[number];
/** 用户偏好：跟随系统，或固定某种语言。 */
export type LangPref = "system" | Lang;

/** 偏好的存储 key。是设备偏好，不跟账号走。 */
export const LANG_STORAGE_KEY = "team-knowledge.lang";

/**
 * 按系统语言列表选界面语言：取第一个能识别的(zh* → 中文，en* → 英文)，
 * 都识别不了时用英文 —— 对既不说中文也不说英文的用户，英文是更通用的回落。
 */
export function detectSystemLang(languages: readonly string[]): Lang {
  for (const l of languages) {
    const tag = l.toLowerCase();
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

export function systemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

export function readLangPref(): LangPref {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY);
    if (v === "zh" || v === "en" || v === "system") return v;
  } catch {
    // 隐私模式等禁用 localStorage 时回落到跟随系统
  }
  return "system";
}

export function writeLangPref(pref: LangPref): void {
  try {
    if (pref === "system") localStorage.removeItem(LANG_STORAGE_KEY);
    else localStorage.setItem(LANG_STORAGE_KEY, pref);
  } catch {
    // 写不进去只影响「下次打开还记得」，本次切换照常生效
  }
}

export function resolveLang(pref: LangPref, languages: readonly string[] = systemLanguages()): Lang {
  return pref === "system" ? detectSystemLang(languages) : pref;
}

/** 当前生效的界面语言。由 I18nProvider 维护；请求头 X-Lang、组件外的 tr() 都读它。 */
let current: Lang = resolveLang(readLangPref());
export function currentLang(): Lang {
  return current;
}
export function setCurrentLang(lang: Lang): void {
  current = lang;
}

/**
 * 把 `{name}` 占位符替换成变量值；缺的变量原样保留，方便发现漏传。
 * 英文单复数：`{n|doc|docs}` 按 n 是否为 1 取单数或复数(中文不用)。
 */
export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template
    .replace(/\{(\w+)\|([^|{}]*)\|([^|{}]*)\}/g, (m, k: string, one: string, other: string) =>
      k in vars ? (Number(vars[k]) === 1 ? one : other) : m)
    .replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/**
 * 给发往本站 api 的请求统一带上 X-Lang(含 SSE 流与上传)，服务端据此返回对应语言的提示与 AI 回答。
 * 只处理同源的 `<BASE>/api/` 请求，第三方地址原样放行。
 */
export function installLangHeader(apiBase: string): void {
  if (typeof window === "undefined" || (window.fetch as { __tkLang?: boolean }).__tkLang) return;
  const original = window.fetch.bind(window);
  const patched = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const sameOriginApi = url.startsWith(apiBase + "/") || url.startsWith(`${window.location.origin}${apiBase}/`);
    if (!sameOriginApi) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("X-Lang")) headers.set("X-Lang", current);
    return original(input, { ...init, headers });
  }) as typeof window.fetch & { __tkLang?: boolean };
  patched.__tkLang = true;
  window.fetch = patched;
}
