// 「忽略」的持久化:复用 doc-audit 的 Setting 抑制套路,但按文章隔离。忽略某条问题后
// 记录其 hash,以后每轮 review 把命中的问题过滤掉(永不复检),除非问题内容变化(hash 变)。
// 已知局限:hash 取 category + 归一化 problem 文本(见 reviewFindingHash)。若文档内容变化
// 触发再校验、且模型把同一问题换了措辞(problem 文本变),hash 变 → 忽略失效会重新报。
// 这是文本级抑制的固有取舍;不引入语义匹配以保持确定性。
import { getSetting, setSetting } from "../settings.js";
import type { HashedReviewFinding } from "./findings.js";

const DISMISS_KEY = "article-review.dismissed";
const PER_ARTICLE_CAP = 200;

export interface DismissedItem { category: string; problem: string; dismissedAt: number; dismissedBy: string; }
export type DismissedMap = Record<string, Record<string, DismissedItem>>;

// 整块 JSON 覆盖写非原子;多人同时忽略不同条会丢更新。单进程内串行化(与 acks 同理)。
let writeChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

async function getMap(): Promise<DismissedMap> {
  return getSetting<DismissedMap>(DISMISS_KEY, {});
}

export async function getDismissedHashes(articleId: string): Promise<Set<string>> {
  const map = await getMap();
  return new Set(Object.keys(map[articleId] ?? {}));
}

/** 把若干 findings 的 hash 记入该文章的忽略集(幂等);超上限按时间丢最旧。 */
export async function addDismissed(articleId: string, findings: HashedReviewFinding[], by: string): Promise<void> {
  if (findings.length === 0) return;
  await withLock(async () => {
    const map = await getMap();
    const forArticle = { ...(map[articleId] ?? {}) };
    const now = Date.now();
    for (const f of findings) {
      forArticle[f.hash] = { category: f.category, problem: f.problem, dismissedAt: now, dismissedBy: by };
    }
    const keys = Object.keys(forArticle);
    if (keys.length > PER_ARTICLE_CAP) {
      const keep = keys.sort((a, b) => forArticle[a].dismissedAt - forArticle[b].dismissedAt).slice(keys.length - PER_ARTICLE_CAP);
      const trimmed: Record<string, DismissedItem> = {};
      for (const k of keep) trimmed[k] = forArticle[k];
      map[articleId] = trimmed;
    } else {
      map[articleId] = forArticle;
    }
    await setSetting(DISMISS_KEY, map, by);
  });
}

/** 全量忽略集(管理后台列表用)。 */
export async function getAllDismissed(): Promise<DismissedMap> {
  return getMap();
}

/** 撤销某文章某条问题的忽略(串行写;不存在则幂等无操作)。 */
export async function removeDismissed(articleId: string, hash: string, by: string): Promise<void> {
  await withLock(async () => {
    const map = await getMap();
    const forArticle = map[articleId];
    if (!forArticle || !(hash in forArticle)) return;
    delete forArticle[hash];
    if (Object.keys(forArticle).length === 0) delete map[articleId];
    await setSetting(DISMISS_KEY, map, by);
  });
}
