export class Semaphore {
  private inFlight = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  acquire(timeoutMs?: number): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const tryGrant = (): boolean => {
        if (this.inFlight < this.capacity) {
          this.inFlight++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.inFlight--;
            const next = this.waiters.shift();
            if (next) next();
          });
          return true;
        }
        return false;
      };
      if (tryGrant()) return;
      let timer: NodeJS.Timeout | null = null;
      const waiter = () => {
        // If another waiter beat us to the slot, re-queue ourselves so we
        // don't silently drop off and starve until acquire's timeout.
        if (!tryGrant()) {
          this.waiters.push(waiter);
          return;
        }
        if (timer) clearTimeout(timer);
      };
      this.waiters.push(waiter);
      if (timeoutMs != null) {
        timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error("semaphore acquire timeout"));
        }, timeoutMs);
      }
    });
  }
}

// Global cap shared across all chat requests.
export const chatSemaphore = new Semaphore(5);

// DEDICATED cap for meeting-assistant LLM generation (chimes + manual asks).
// Each fired chime spawns an LLM CLI process; with NO cap, M concurrent
// meetings = M uncapped processes (the per-meeting assistantBusy flag only
// serializes WITHIN a meeting, not across them). We use a SEPARATE semaphore
// from chatSemaphore — not the shared chat cap — so a burst of HTTP chat
// traffic can't starve live meetings of their voice, and a roomful of busy
// meetings can't 429 the web chat. Cap 4: enough to keep several meetings
// lively in parallel while bounding the total CLI fan-out. No deadlock with
// the per-meeting assistantBusy serialization: each meeting holds at most ONE slot
// at a time (assistantBusy gates a second concurrent acquire in the same meeting),
// and the acquire is bounded by a timeout so a saturated cap degrades to a
// skipped chime rather than a hung generation.
export const meetingAssistantSemaphore = new Semaphore(4);

// Global cap for concurrent TTS synthesis WebSockets. Each finished assistant
// sentence opens a fresh outbound volc TTS WS; a long comment has N sentences
// and there are up to M concurrent meetings → without a cap that's N×M
// simultaneous outbound sockets. Sentences are PLAYED back FIFO on the client
// anyway, so bounded synthesis parallelism (cap 6) preserves the
// stream-as-you-go feel while capping the outbound-socket fan-out. Each
// dispatchSentence acquires before opening the WS and releases when synthesis
// settles; a saturated cap just makes later sentences queue briefly.
export const ttsSynthesisSemaphore = new Semaphore(6);

// 后台「助手生成通知文案」的 LLM 并发上限。背景任务可能批量触发(如周报后
// 给每人发个性化提醒),用独立小 cap 避免抢占交互聊天的 chatSemaphore(5)。
export const notifyAuthorSemaphore = new Semaphore(3);

// 自动化(定时 AI 任务)后台执行的并发上限。调度到点可能同一刻触发多条(如都设 07:00),
// 若全部并发 → 一次性吃满交互聊天的 chatSemaphore(5)、把真人聊天拖慢/顶掉,且第 6+ 条
// 抢不到槽会误判失败。用【独立小 cap=2】限制后台并发:最多同时 2 条自动化在跑,其余排队等待
//(acquire 不设超时 → 背景任务耐心等,不误失败),同时给交互聊天留足 chat 槽位。
export const automationSemaphore = new Semaphore(2);

// AI 文生图(OpenAI 图像 API)的并发上限。每次生图是一条 outbound HTTP,最长 120s;
// 用【独立】小 cap(不挂 chatSemaphore)避免一串慢生图把交互聊天的 5 个槽位占满,
// 同时给 outbound OpenAI 调用一个全局上限(每用户 10/min 限流之上再兜一层)。
// 满载时 acquire 超时 → 生图优雅降级为「暂不可用」,而不是无界并发打爆网关。
export const imageGenSemaphore = new Semaphore(3);

// 对话分享图同一时间只渲染一张:每张可占用一个 libuv 线程数秒,而线程池(默认 4 个)
// 还要服务文件读写、DNS 等,不能被成员连点占满。
export const shareImageSemaphore = new Semaphore(1);

// Per-conversation serialization. The global chatSemaphore caps TOTAL
// concurrent LLM calls (5) but happily runs two sends to the SAME
// conversation in parallel — which persists them as user1→user2→
// asst1→asst2 (mismatched turn order). This keyed mutex forces sends
// to one conversationId to run strictly in order (user1→asst1, THEN
// user2→asst2) while still letting different conversations proceed
// concurrently under the semaphore.
//
// Implementation: a Map<key, Promise> chain. `runExclusive` appends its
// work to the tail of the conversation's promise chain; the next caller
// for the same key awaits that tail before starting. This is correct
// ONLY for a single process — the chain lives in this process's heap.
// team-knowledge runs as one API process, so that assumption holds; a
// multi-process deploy would need a DB-level lock (e.g. a per-
// conversation sequenceNumber) instead.
const conversationLocks = new Map<string, Promise<unknown>>();

/** True while some runExclusive(key) work (or its queued successors) is still
 *  running — i.e. a new caller for this key would have to wait in line. Lets
 *  the Feishu bridge show「上一条回答还在生成,已排队」instead of an
 *  indistinguishable「思考中」card during the wait. */
export function isExclusiveBusy(key: string): boolean {
  return conversationLocks.has(key);
}

export async function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Chain onto whatever is currently queued for this key. We swallow the
  // predecessor's rejection (`.catch(() => {})`) so one failed turn
  // doesn't poison the chain for the next caller — they only wait for
  // ordering, not for success.
  const prev = conversationLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  // Store the settled tail (errors absorbed) so the NEXT waiter chains
  // off a never-rejecting promise.
  const tail = run.catch(() => {});
  conversationLocks.set(key, tail);
  try {
    return await run;
  } finally {
    // Release the map entry once we're the last in line, so the Map
    // doesn't grow unbounded across the process lifetime. If another
    // caller has already chained on (replacing the tail), leave theirs.
    if (conversationLocks.get(key) === tail) conversationLocks.delete(key);
  }
}
