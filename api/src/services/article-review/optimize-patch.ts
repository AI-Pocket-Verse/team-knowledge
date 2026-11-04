// 一键优化「定点补丁」:LLM 只产出「查找→替换」edits(而非整篇重写),服务端把它们
// 应用到原文得到修订全文。好处:输出小、快、稳,diff 也只显示真正改动的片段。
// 纯函数,便于单测。

export interface OptimizeEdit {
  /** 从原文逐字复制的、要被替换掉的连续片段(含足够上下文以唯一定位)。 */
  find: string;
  /** 修正后的片段。 */
  replace: string;
}

export type EditFailReason = "empty" | "not_found" | "ambiguous";

export interface ApplyEditsResult {
  /** 应用全部可应用 edits 后的正文。无法应用的 edit 跳过,不影响其它。 */
  markdown: string;
  applied: number;
  failed: { find: string; reason: EditFailReason }[];
}

/** 从 LLM 文本稳健抽取 {edits:[{find,replace}]}:剥代码块、取最外层 {…}、容错。失败 → []。 */
export function parseOptimizeEdits(text: string): OptimizeEdit[] {
  if (!text) return [];
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const i = stripped.indexOf("{");
  const j = stripped.lastIndexOf("}");
  if (i < 0 || j < i) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(stripped.slice(i, j + 1));
  } catch {
    return [];
  }
  const arr = (obj as { edits?: unknown }).edits;
  if (!Array.isArray(arr)) return [];
  const out: OptimizeEdit[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.find !== "string" || typeof r.replace !== "string") continue;
    if (!r.find.trim()) continue;
    out.push({ find: r.find, replace: r.replace });
  }
  return out;
}

const RX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** 把 find 编译成「空白宽松」正则:非空白逐字转义,空白串 → \s+,吸收模型对空格/换行的轻微改动。 */
function flexRegex(find: string): RegExp | null {
  const trimmed = find.trim();
  if (!trimmed) return null;
  const pattern = trimmed.split(/\s+/).map((w) => w.replace(RX_SPECIAL, "\\$&")).join("\\s+");
  try {
    return new RegExp(pattern, "g");
  } catch {
    return null;
  }
}

/**
 * 依次把 edits 应用到 original。策略(优先安全,宁可跳过也不误伤):
 *  1) 精确匹配:原文中【唯一】出现该 find 才替换;多处出现 → 歧义,跳过(避免改错同名文本);
 *  2) 精确找不到时,空白宽松回退(吸收模型对空格/换行的改动),同样要求唯一命中;
 *  3) find === replace(无变化)仅当片段确实在文中才记为已满足,否则等同 not_found;空 find 记为 empty。
 * 逐条在「已应用前面 edits 的文本」上继续操作,故 edits 顺序有意义、可级联。
 * 注意级联的一个已知局限(安全但可能漏改):若前一条的 replace 恰好引入了后一条 find 的
 * 重复出现,后一条会被判为 ambiguous 而跳过(报 failed,不会误改)。模型被要求给出「唯一定位」
 * 的短 find,实际很少触发;真触发也只是少修一处,不会改错。
 */
export function applyOptimizeEdits(original: string, edits: OptimizeEdit[]): ApplyEditsResult {
  let text = original;
  let applied = 0;
  const failed: ApplyEditsResult["failed"] = [];
  for (const e of edits) {
    const find = typeof e.find === "string" ? e.find : "";
    const replace = typeof e.replace === "string" ? e.replace : "";
    if (!find.trim()) { failed.push({ find, reason: "empty" }); continue; }
    if (find === replace) {
      // 无变化:仅当原文确实含该片段才算「已满足」;否则等同定位失败 —— 否则一批「find===replace
      // 且都不在文中」会把 applied 抬到 >0,handler 的 applied===0 失败门失效,把原文当成功返回。
      if (text.includes(find)) applied++;
      else failed.push({ find, reason: "not_found" });
      continue;
    }

    // 1) 精确匹配优先,要求唯一。
    const first = text.indexOf(find);
    if (first >= 0) {
      if (text.indexOf(find, first + find.length) >= 0) { failed.push({ find, reason: "ambiguous" }); continue; }
      text = text.slice(0, first) + replace + text.slice(first + find.length);
      applied++;
      continue;
    }

    // 2) 空白宽松回退,同样要求唯一命中。
    const re = flexRegex(find);
    if (re) {
      const matches = [...text.matchAll(re)];
      if (matches.length === 1 && matches[0].index !== undefined) {
        const m = matches[0];
        text = text.slice(0, m.index!) + replace + text.slice(m.index! + m[0].length);
        applied++;
        continue;
      }
    }
    failed.push({ find, reason: "not_found" });
  }
  return { markdown: text, applied, failed };
}
