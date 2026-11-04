import type { FastifyRequest } from "fastify";
import { env } from "../env.js";

// 语言的唯一真值源：
//  - 个人发起的请求按请求头 X-Lang(web 每个 api 请求都带，见 web/src/i18n/lang.ts 的 installLangHeader)；
//  - 没带或不认识时(飞书机器人、脚本、curl)用部署语言 APP_LANGUAGE；
//  - 不属于某个请求的共享内容(飞书卡片、定时任务、周报、角色 Skill、会议纪要)一律用 appLang()。
export type Lang = "zh" | "en";

export function appLang(): Lang {
  return env.APP_LANGUAGE;
}

export function parseLang(v: unknown): Lang | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "en" || s === "zh" ? s : null;
}

export function requestLang(req: FastifyRequest): Lang {
  return parseLang(req.headers["x-lang"]) ?? appLang();
}

/**
 * 按语言二选一取文案。接口错误提示就地写成对：`L(req, "目录不存在", "Folder not found")`，
 * 中文保持原文，英文紧挨着写，便于对照维护。第一个参数可以是请求或已解析的语言。
 */
export function L(langOrReq: Lang | FastifyRequest, zh: string, en: string): string {
  const lang = typeof langOrReq === "string" ? langOrReq : requestLang(langOrReq);
  return lang === "en" ? en : zh;
}
