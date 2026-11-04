// 群聊智能答疑:每个群最近 N 条消息的内存环形缓冲。机器人开了「读取群消息」后会收到
// 群里所有文本消息,这里只在内存里留最近几条,用于让答疑判定理解「正在讨论的问题」。
// 不落库(隐私);进程重启即清空(冷启动时由 observe 兜底从飞书历史接口补,见 spec)。

export interface GroupMsg {
  messageId: string;
  openId: string;
  senderName: string;
  text: string;
  ts: number;
}

const CAP = 8; // 每群保留的最近消息条数
const buffers = new Map<string, GroupMsg[]>();

/** 追加一条到该群缓冲(超过 CAP 丢最旧)。 */
export function appendMessage(chatId: string, msg: GroupMsg): void {
  const arr = buffers.get(chatId) ?? [];
  arr.push(msg);
  if (arr.length > CAP) arr.splice(0, arr.length - CAP);
  buffers.set(chatId, arr);
}

/** 该群最近消息(旧 → 新),含刚追加的这条。返回副本,避免调用方误改内部缓冲。 */
export function recentMessages(chatId: string): GroupMsg[] {
  return [...(buffers.get(chatId) ?? [])];
}

/** 机器人「见过消息」的群 chat_id(本进程内)。供控制台把这些群也列为可勾选目标,
 *  这样不在 FEISHU_CHAT_NAMES 里、但机器人确在的群也能开启答疑(重启后随新消息重建)。 */
export function observedChatIds(): string[] {
  return [...buffers.keys()];
}

/** 测试用:清空所有缓冲。 */
export function _resetBuffers(): void {
  buffers.clear();
}
