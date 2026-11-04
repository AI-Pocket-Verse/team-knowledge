// 「飞书群通知」各场景当前是否正在执行(进程内定时任务触发,或后台「发送
// 测试」的异步任务)。内存态、单实例;后台控制台轮询它来显示「运行中」动画。
// 计数而非布尔:定时触发与手动测试可能重叠,任一仍在跑就算运行中。
const runningCounts = new Map<string, { n: number; since: number }>();

/** 标记开始执行;返回结束回调(务必 finally 调用)。 */
export function markScenarioRunning(key: string): () => void {
  const cur = runningCounts.get(key);
  if (cur) cur.n += 1;
  else runningCounts.set(key, { n: 1, since: Date.now() });
  let released = false;
  return () => {
    if (released) return; // 幂等,防 double-release 把并行任务的计数扣穿
    released = true;
    const e = runningCounts.get(key);
    if (!e) return;
    if (e.n <= 1) runningCounts.delete(key);
    else e.n -= 1;
  };
}

/** 该场景是否在执行;返回开始时间(ms),未执行返回 null。 */
export function scenarioRunningSince(key: string): number | null {
  return runningCounts.get(key)?.since ?? null;
}

/** 仅供测试:清空。 */
export function clearAllRunning(): void {
  runningCounts.clear();
}
