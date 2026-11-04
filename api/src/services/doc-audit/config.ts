// 知识库「文档体检」(doc-audit)运行参数(管理后台可配;复用 Setting 键值存储)。
//   strength         检测强度评级 1-10(注入 prompt 调整严格程度与条目数量)
//   maxPerCategory   每种类型最多显示的条数(每类问题上限,无硬上限、最小 1)
import { getSetting, setSetting } from "../settings.js";

const STRENGTH_KEY = "doc-audit.strength";
const MAX_PER_CATEGORY_KEY = "doc-audit.max_per_category";

// 默认与边界。
export const STRENGTH_DEFAULT = 4;
export const STRENGTH_MIN = 1;
export const STRENGTH_MAX = 10;
// 「每类上限」无产品上限,给个安全值防脏数据/爆量渲染。
export const MAX_PER_CATEGORY_DEFAULT = 10;
export const MAX_PER_CATEGORY_MIN = 1;
export const MAX_PER_CATEGORY_MAX = 9999;

/** 取整 + 夹到 [min,max];非法值(布尔/数组/空串/null 等)回退默认。纯函数,便于测。 */
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  // 只接受数字或「非空数字字符串」;其余(boolean/null/[]/""/对象)一律回退默认,
  // 避免 Number(true)=1 / Number("")=0 这类强转把垃圾值悄悄夹成 min。
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export interface DocAuditTuning {
  strength: number;       // 1-10
  maxPerCategory: number; // ≥1
}

export async function getDocAuditStrength(): Promise<number> {
  return clampInt(await getSetting(STRENGTH_KEY, STRENGTH_DEFAULT), STRENGTH_MIN, STRENGTH_MAX, STRENGTH_DEFAULT);
}

export async function getDocAuditMaxPerCategory(): Promise<number> {
  return clampInt(await getSetting(MAX_PER_CATEGORY_KEY, MAX_PER_CATEGORY_DEFAULT), MAX_PER_CATEGORY_MIN, MAX_PER_CATEGORY_MAX, MAX_PER_CATEGORY_DEFAULT);
}

export async function getDocAuditTuning(): Promise<DocAuditTuning> {
  const [strength, maxPerCategory] = await Promise.all([
    getDocAuditStrength(),
    getDocAuditMaxPerCategory(),
  ]);
  return { strength, maxPerCategory };
}

/** 部分更新(只写传入的字段);数值越界自动夹紧。返回更新后的完整设置。 */
export async function setDocAuditTuning(
  patch: { strength?: number; maxPerCategory?: number },
  by: string,
): Promise<DocAuditTuning> {
  if (patch.strength !== undefined) {
    await setSetting(STRENGTH_KEY, clampInt(patch.strength, STRENGTH_MIN, STRENGTH_MAX, STRENGTH_DEFAULT), by);
  }
  if (patch.maxPerCategory !== undefined) {
    await setSetting(MAX_PER_CATEGORY_KEY, clampInt(patch.maxPerCategory, MAX_PER_CATEGORY_MIN, MAX_PER_CATEGORY_MAX, MAX_PER_CATEGORY_DEFAULT), by);
  }
  return getDocAuditTuning();
}
