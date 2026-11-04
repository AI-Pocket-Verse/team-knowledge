// 顶栏搜索弹窗的「搜索历史」—— 纯本机 localStorage,不入后端。
// 去重(同词移到最前)、上限 MAX 条、空白词不存;全程容错:隐私模式 /
// 配额满 / 数据损坏一律静默降级(读返回空、写放弃),绝不抛错打断搜索。

const KEY = "assistant.searchHistory";
const MAX = 8;

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, MAX);
  } catch {
    return [];
  }
}

function write(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* 隐私模式 / 配额满:静默放弃,历史功能降级为不可用 */
  }
}

/** 读取搜索历史(最近在前)。 */
export function readSearchHistory(): string[] {
  return read();
}

/** 记录一次搜索词:去重后置顶,返回新列表。空白词忽略。 */
export function addSearchHistory(term: string): string[] {
  const t = term.trim();
  if (!t) return read();
  const next = [t, ...read().filter((x) => x !== t)].slice(0, MAX);
  write(next);
  return next;
}

/** 删除某条历史,返回新列表。 */
export function removeSearchHistory(term: string): string[] {
  const next = read().filter((x) => x !== term);
  write(next);
  return next;
}

/** 清空全部历史。 */
export function clearSearchHistory(): string[] {
  write([]);
  return [];
}
