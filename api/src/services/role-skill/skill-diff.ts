// 角色 Skill 更新通知用:对比同一角色 skill.md 的【上一版 vs 本次】,让 LLM 写一句
// 「本次相对上次改了什么」。只读 skill.md 内容本身(不碰源文档)—— 通知关心的是
// 「技能」这份产物怎么变了,而非它由哪些文档蒸馏而来。
//
// best-effort:无上一版 / 内容相同 / LLM 抖动都各有降级,绝不抛错影响通知发送。
import { getProvider } from "../llm/registry.js";
import { chatSemaphore } from "../../utils/concurrency.js";

const SYS =
  "你在对比同一个角色「技能说明(skill.md)」的新旧两版。用 1-3 句简体中文说明本次相对上一版的实质改动" +
  "(补充/删除/调整了哪些要点或能力),抓重点、不要逐字罗列。若两版没有实质差异,只回复「无实质变化」。" +
  "直接输出结论,不要标题、前缀或 markdown 语法。";

const CLIP = 8000; // 单边最多喂多少字符,skill.md 通常远小于此

/**
 * 返回一句话变更摘要;无法对比(无上一版)时由调用方传 prev 为空并据此显示「首次生成」,
 * 这里只处理「有上一版」的情形。内容完全相同 → 「无实质变化」;LLM 失败 → null(调用方兜底)。
 */
export async function summarizeSkillDiff(prev: string, next: string): Promise<string | null> {
  if (prev.trim() === next.trim()) return "无实质变化";
  // 与在线聊天共享全局 LLM 并发闸:后台摘要绝不挤占交互流量,繁忙时直接降级
  // (返回 null,卡片用兜底文案)。
  let release: () => void;
  try {
    release = await chatSemaphore.acquire(30_000);
  } catch {
    console.warn("[skill-diff] LLM 繁忙,变更摘要降级省略");
    return null;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  try {
    const provider = await getProvider();
    let out = "";
    const userMessage = `【上一版 skill.md】\n${prev.slice(0, CLIP)}\n\n【本次 skill.md】\n${next.slice(0, CLIP)}`;
    for await (const chunk of provider.chat({ systemPrompt: SYS, history: [], userMessage }, ac.signal)) {
      if (chunk.type === "token") out += chunk.text;
      else if (chunk.type === "error") throw new Error(chunk.message);
    }
    return out.trim().slice(0, 500) || null;
  } catch (e) {
    console.warn("[skill-diff] 变更摘要生成失败,省略:", (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
    release();
  }
}
