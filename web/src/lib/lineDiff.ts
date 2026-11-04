// 极简行级 diff(LCS),供「一键优化」diff 预览用。不引第三方依赖。
export type DiffRow = { type: "equal" | "add" | "del"; text: string };

export function lineDiff(before: string, after: string): DiffRow[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS 长度表
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i] });
      i++;
    } else {
      rows.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ type: "del", text: a[i++] });
  while (j < m) rows.push({ type: "add", text: b[j++] });
  return rows;
}

// 把逐行 diff 归并成「块」:context(未改动)与 hunk(一处改动:before=原行,after=新行)。
// 每个 hunk 可被用户独立勾选/取消;勾选→采用 after,取消→保留 before。
export type DiffBlock =
  | { kind: "context"; lines: string[] }
  | { kind: "hunk"; before: string[]; after: string[] };

export function toBlocks(rows: DiffRow[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let ctx: string[] = [];
  let before: string[] = [];
  let after: string[] = [];
  const flushCtx = () => { if (ctx.length) { blocks.push({ kind: "context", lines: ctx }); ctx = []; } };
  const flushHunk = () => { if (before.length || after.length) { blocks.push({ kind: "hunk", before, after }); before = []; after = []; } };
  for (const r of rows) {
    if (r.type === "equal") { flushHunk(); ctx.push(r.text); }
    else { flushCtx(); if (r.type === "del") before.push(r.text); else after.push(r.text); }
  }
  flushCtx();
  flushHunk();
  return blocks;
}

/** 按勾选重建文档:context 原样;第 k 个 hunk 勾选→after,未勾选→before。
 *  selected 长度应等于 hunk 数;缺省项按 true(采用优化)处理。 */
export function applySelection(blocks: DiffBlock[], selected: boolean[]): string {
  const out: string[] = [];
  let h = 0;
  for (const b of blocks) {
    if (b.kind === "context") {
      out.push(...b.lines);
    } else {
      const take = selected[h] ?? true;
      out.push(...(take ? b.after : b.before));
      h++;
    }
  }
  return out.join("\n");
}

export function countHunks(blocks: DiffBlock[]): number {
  return blocks.reduce((n, b) => n + (b.kind === "hunk" ? 1 : 0), 0);
}
