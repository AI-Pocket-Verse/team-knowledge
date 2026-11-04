import { env } from "../env.js";

/** 助手的显示名（界面、提示词、飞书卡片统一从这里取），由环境变量 ASSISTANT_NAME 配置，默认 "AI"。 */
export const ASSISTANT_NAME = env.ASSISTANT_NAME;

const DEFAULT_WAKE_WORDS = "小助手";

/** 把逗号分隔的唤醒词配置编译成匹配正则；`@?` 让「@唤醒词」也能命中。空配置回退默认值。 */
export function buildWakeWordRegex(raw: string): RegExp {
  const words = raw.split(/[,，]/).map((w) => w.trim()).filter(Boolean);
  const list = words.length > 0 ? words : [DEFAULT_WAKE_WORDS];
  const escaped = list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`@?(${escaped.join("|")})`, "i");
}
