import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { currentLang, format, readLangPref, resolveLang, setCurrentLang, writeLangPref, type Lang, type LangPref } from "./lang";
import { MESSAGES, type MessageKey } from "./messages";

export type { Lang, LangPref } from "./lang";
export type { MessageKey } from "./messages";

export type TFunction = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  /** 当前生效的语言 */
  lang: Lang;
  /** 用户偏好(含「跟随系统」) */
  pref: LangPref;
  setPref: (pref: LangPref) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nValue | null>(null);

/** 取某种语言的翻译函数。 */
export function translator(lang: Lang): TFunction {
  return (key, vars) => format(MESSAGES[lang][key], vars);
}

/**
 * 组件外(工具函数、store、toast 文案)用的翻译：按当前生效语言取文案。
 * 只能在调用时求值，不要在模块顶层缓存结果(切换语言后会过期)。
 */
export function tr(key: MessageKey, vars?: Record<string, string | number>): string {
  return format(MESSAGES[currentLang()][key], vars);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<LangPref>(readLangPref);
  // 跟随系统时，系统语言变了要跟着变(languagechange 事件)。
  const [sysTick, setSysTick] = useState(0);
  useEffect(() => {
    const onChange = () => setSysTick((n) => n + 1);
    window.addEventListener("languagechange", onChange);
    return () => window.removeEventListener("languagechange", onChange);
  }, []);

  // sysTick 只用来触发重算
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lang = useMemo(() => resolveLang(pref), [pref, sysTick]);
  // 渲染期间就同步给非组件代码(请求头 X-Lang、tr())，避免首个请求或首屏文案带错语言。
  setCurrentLang(lang);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = MESSAGES[lang]["app.title"];
  }, [lang]);

  const setPref = useCallback((p: LangPref) => {
    writeLangPref(p);
    setPrefState(p);
  }, []);

  const value = useMemo<I18nValue>(() => ({ lang, pref, setPref, t: translator(lang) }), [lang, pref, setPref]);
  // 切换语言时整棵树按新语言重新挂载：组件外用 tr() 求值的文案、各 store 里缓存的提示都会随之刷新。
  return (
    <I18nContext.Provider value={value}>
      <Fragment key={lang}>{children}</Fragment>
    </I18nContext.Provider>
  );
}

/** 组件里取翻译函数与当前语言。不在 Provider 内(如单测)时按当前生效语言工作。 */
export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (v) return v;
  const lang = currentLang();
  return { lang, pref: lang, setPref: () => {}, t: translator(lang) };
}

/** 只要 t 时的简写。 */
export function useT(): TFunction {
  return useI18n().t;
}
