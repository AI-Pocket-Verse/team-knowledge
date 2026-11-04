// 按 key 串行的进程内互斥:同 key 的临界区排队依次执行,不同 key 互不阻塞。
// 服务是单进程 SQLite,进程内互斥足以保证「先查后写」的原子性;用完即删 key,不随 key 数量增长。
const tails = new Map<string, Promise<void>>();

/** 获取 key 的锁,返回释放函数(必须在 finally 里调用)。 */
export async function acquireKeyedLock(key: string): Promise<() => void> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = prev.then(() => mine);
  tails.set(key, tail);
  await prev;
  return () => {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  };
}
