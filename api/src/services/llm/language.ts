import type { Lang } from "../../utils/lang.js";

// AI 输出语言。提示词本身保持中文(改造前的行为不变)，英文时在系统提示末尾追加这条指令，
// 让回答、纪要、体检结论等按目标语言输出。知识库正文可能是任意语言，引用原文时保留原文。
export function outputLanguageInstruction(lang: Lang): string {
  if (lang === "zh") return "";
  return "\n\n[Output language] Write your entire response in English, even though these instructions and the knowledge base content may be in Chinese. Keep document titles, quotes and code exactly as they appear in the source.";
}
