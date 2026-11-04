// 专家应答里的「协作标记」解析。专家在回答中可输出:
//   [[CONSULT: <角色名> | <要问的子问题>]]      —— 需要别角色专家的专长视角
//   [[ESCALATE: <背景> | <问题> | <候选1>;<候选2>]] —— 自己拍不了板,要人工
// 编排器据此触发 consult / raiseEscalation,并把标记行从最终展示文本里剥掉。
export interface ConsultMarker { target: string; question: string }
export interface EscalateMarker { background: string; question: string; options: string[] }
export interface ParsedMarkers { clean: string; consult: ConsultMarker | null; escalate: EscalateMarker | null }

const CONSULT_RE = /\[\[\s*CONSULT\s*[:：]\s*([^|｜\]]+?)\s*[|｜]\s*([^\]]+?)\s*\]\]/i;
const ESCALATE_RE = /\[\[\s*ESCALATE\s*[:：]\s*([^|｜\]]+?)\s*[|｜]\s*([^|｜\]]+?)\s*[|｜]\s*([^\]]*?)\s*\]\]/i;
// 全局版仅用于 clean 时剥除「所有」同类标记——即便模型违规输出了多个,也不会有残留标记
// 文本泄漏到最终答复里(只有第一个会被真正执行,见下)。
const CONSULT_RE_G = new RegExp(CONSULT_RE.source, "gi");
const ESCALATE_RE_G = new RegExp(ESCALATE_RE.source, "gi");

// 出处使用标记:`[[USED: #1 #3]]`(用到第 1、3 条)/ `[[USED: none]]`(没用到任何参考资料)。
// 返回剥除标记后的正文 + 实际用到的编号数组;usedNs=[] 表示「none」;usedNs=null 表示模型
// 没给标记(调用方据此回退到原口径,避免漏列出处)。
const USED_RE = /\[\[\s*USED\s*[:：]\s*([^\]]*?)\s*\]\]/i;
const USED_RE_G = new RegExp(USED_RE.source, "gi");
export function parseUsedMarker(text: string): { clean: string; usedNs: number[] | null } {
  const m = USED_RE.exec(text);
  const clean = text.replace(USED_RE_G, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!m) return { clean, usedNs: null };
  const body = m[1].trim();
  if (/^none$|^无$/i.test(body)) return { clean, usedNs: [] };
  const ns = Array.from(body.matchAll(/#?\s*(\d+)/g)).map((x) => Number(x[1])).filter((n) => Number.isFinite(n) && n > 0);
  // 给了标记但没解析出有效编号 → 当作 none(没用到),而不是 null(回退全列)。
  return { clean, usedNs: ns };
}

// 门控标记:总台助手在「用户选了专家」时,先判一手——通用问题自己答,确需专家则
// 只输出 `[[EXPERT]]`(由 markerSafeSink 扣住不外泄),编排据此把这一轮交接给所选专家。
const EXPERT_RE = /\[\[\s*EXPERT\s*\]\]/i;
export function hasExpertMarker(text: string): boolean {
  return EXPERT_RE.test(text);
}

// 生图标记:助手判断用户想「画/生成一张图片」时,只输出 `[[IMAGE: <文生图提示词>]]`
// (走 markerSafeSink 不外泄)。编排据此调文生图,把生成的图回灌为 assistant 图片。
const IMAGE_RE = /\[\[\s*IMAGE\s*[:：]\s*([^\]]+?)\s*\]\]/i;
const IMAGE_RE_G = new RegExp(IMAGE_RE.source, "gi");
export function parseImageMarker(text: string): { prompt: string | null; clean: string } {
  const m = IMAGE_RE.exec(text);
  const clean = text.replace(IMAGE_RE_G, "").replace(/\n{3,}/g, "\n\n").trim();
  return { prompt: m ? m[1].trim() : null, clean };
}

// 兜底:剥除最终展示文本里【任何】残留的协作/控制标记(USED/IMAGE/EXPERT/CONSULT/ESCALATE)。
// 正常路径各自的解析器已剥除对应标记,但当模型输出「只有标记、没有正文」时,旧的
// `clean || 原文` 兜底会把原始标记当正文漏出去(见 [[USED: #4]] 泄漏)。统一过一道,杜绝任何残留。
const ANY_MARKER_G = /\[\[\s*(?:USED|IMAGE|EXPERT|CONSULT|ESCALATE)\b[^\]]*\]\]/gi;
export function stripResidualMarkers(text: string): string {
  return text.replace(ANY_MARKER_G, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseMarkers(text: string): ParsedMarkers {
  const em = ESCALATE_RE.exec(text);
  const cm = CONSULT_RE.exec(text);
  const escalate: EscalateMarker | null = em
    ? { background: em[1].trim(), question: em[2].trim(), options: em[3].split(/[;；]/).map((s) => s.trim()).filter(Boolean) }
    : null;
  const consult: ConsultMarker | null = cm ? { target: cm[1].trim(), question: cm[2].trim() } : null;
  // 执行只认第一个(em/cm),但剥除用全局正则,杜绝第二个标记残留在展示文本中。
  const clean = text.replace(ESCALATE_RE_G, "").replace(CONSULT_RE_G, "").replace(/\n{3,}/g, "\n\n").trim();
  return { clean, consult, escalate };
}
