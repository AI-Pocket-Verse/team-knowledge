// 群聊智能答疑的「判定 + 作答」:一次 LLM 调用,既判断「最新一条是不是知识库能答的
// 问题」,又(若能答)产出简短答案。隐私同 runGroupChatTurn:只用 search() 的检索结果
// (文档库没有草稿状态,search 也不做按人的可见性过滤),不传 history / articleId / mentions
// (杜绝私有上下文泄漏)。检索为空 → 直接不答(省 LLM)。
import type { FastifyBaseLogger } from "fastify";
import { search, type SearchHit } from "../retrieval/fts5.js";
import { getProvider } from "../llm/registry.js";
import { chatSemaphore } from "../../utils/concurrency.js";
import type { GroupMsg } from "./buffer.js";
import { ASSISTANT_NAME } from "../../utils/assistant.js";

export interface DecideResult {
  answer: string;
  sourceTitle?: string;
  sourceArticleId?: string;
}

const ANSWER_CAP_FALLBACK = 160; // 答案硬上限(字)默认值。「不宜过长」;可由后台配置覆盖。
const AGGRESSIVENESS_FALLBACK = 2; // 答疑积极度默认档(1 保守 / 2 适中 / 3 积极;不传配置时的兜底)。
const NO = "NO_ANSWER";

/** 积极度(1-3)→ 检索候选文档数:越积极给越多候选,增加「找到能搭话依据」的机会。三档各不同。 */
export function retrieveLimit(aggressiveness: number): number {
  return aggressiveness >= 3 ? 8 : aggressiveness >= 2 ? 6 : 5;
}

// 答案字数上限、答疑积极度均后台可配(见 group-qa/config.ts),故 prompt 按运行值动态拼装。
// 积极度只调「该不该答」的判定松紧(主闸门),始终保留「只依据文档、不编造」的底线 —— 不会
// 因为积极就允许瞎编或答文档里没有的内容。三档(保守/适中/积极)各对应不同判定条款。
function buildSystem(answerCap: number, aggressiveness: number): string {
  const eager = aggressiveness >= 3;
  const strict = aggressiveness <= 1;

  // 拿不准时是否收口:保守档「拿不准就不答」;适中/积极档去掉「拿不准」这条,鼓励尝试。
  const bailRule = strict
    ? `- 若只是闲聊 / 个人动态 / 情绪宣泄 / 文档没覆盖 / 你拿不准 → **只输出** ${NO}(不要任何别的字符)。`
    : `- 若只是纯闲聊 / 个人动态 / 情绪宣泄 / 文档里完全没有相关内容 → **只输出** ${NO}(不要任何别的字符)。`;

  // 文档匹配门槛:保守=必须确实对题、宁可不答;适中=相关有用即可;积极=沾边能帮忙就答。
  const matchRule = strict
    ? `- ⚠️ 只有当给的文档**确实在讲这个问题的主题**时才回答:若文档主题与问题对不上(例如问「隐私政策/会员协议」却只给到测试用例、版本说明之类不相干的文档),或问题问的是文档里根本没有的信息(如「还需要补充/新增哪些」这种面向未来的规划判断),一律 ${NO} —— 宁可不答,也绝不用不相关的文档硬凑答案。`
    : eager
    ? `- 尽量帮上忙:只要检索到的文档**可能与问题相关、能提供一点有用信息或线索**,就用文档里的内容给个简短回答或指个方向(把握不大时可点明「可能相关,供参考」);只有当文档跟问题**完全不相干**、或问的是文档里根本没有的信息时才 ${NO}。绝不脱离文档凭空编造。`
    : `- 文档只要**与问题相关、能提供有用信息**就可以回答;仅当文档明显跟问题不是一回事、或问的是文档里没有的内容时才 ${NO}。不脱离文档编造。`;

  return (
    `你是知识库助手 ${ASSISTANT_NAME},正在一个工作群里旁听大家聊天。下面给你「最近对话」和几篇【已发布】知识库文档片段。\n` +
    `请判断「最新一条消息」是不是在**寻求知识库能提供的信息** —— 不限于带问号的问句,还包括:\n` +
    `  ① 无问号的疑问句(如「隐私协议需要哪些第三方SDK」);\n` +
    `  ② 对文档内容的求证 / 推测(如「…是不是这样」「sql 脚本应该包含全部建表语句吧」);\n` +
    `  ③ 索取 / 请求某份资料(如「会员协议发我一下」「要份接入文档」)。\n` +
    `- 若是、且文档能支撑 → 用**一两句、口语、直接给结论**的中文简短回答(不超过 ${answerCap} 字),不复述问题、不寒暄、不加前缀;若对方是索取资料,就用一两句概括关键要点(卡片会另附文档链接)。\n` +
    bailRule + `\n` +
    matchRule + `\n` +
    `只依据给定文档,不编造。`
  );
}

function buildUserMessage(recent: GroupMsg[], question: string, hits: SearchHit[]): string {
  const convo = recent.map((m) => `${m.senderName}：${m.text}`).join("\n") || question;
  const docs = hits
    .map((h, i) => `【文档${i + 1}·${h.title}】\n${(h.snippet || h.body || "").slice(0, 600)}`)
    .join("\n\n");
  return `最近对话:\n${convo}\n\n相关文档片段:\n${docs}\n\n最新一条消息:「${question}」\n\n请按规则:要么给出简短回答,要么只回 ${NO}。`;
}

/** 返回简短答案(+来源)或 null(不该答 / 答不了 / 出错)。失败一律 null —— 群里宁可不发。 */
export async function decideAndAnswer(args: { recent: GroupMsg[]; question: string; signal: AbortSignal; answerCap?: number; aggressiveness?: number; log?: FastifyBaseLogger }): Promise<DecideResult | null> {
  const question = args.question.trim();
  if (!question) return null;
  const answerCap = args.answerCap ?? ANSWER_CAP_FALLBACK;
  const aggressiveness = args.aggressiveness ?? AGGRESSIVENESS_FALLBACK;

  // 只用 search() 检索(无草稿状态,也无按人的可见性过滤)。无命中 → 不调 LLM。
  // 候选数随积极度增加(retrieveLimit),给更积极档更多「能搭话」的依据。
  const hits = await search({ query: question, userId: "", isAdmin: false, limit: retrieveLimit(aggressiveness) });
  if (hits.length === 0) { args.log?.info("group-qa skip:无相关已发布文档(检索 0 命中)"); return null; }

  let release: () => void;
  try {
    release = await chatSemaphore.acquire(15_000);
  } catch {
    return null; // AI 繁忙 → 这轮安静跳过
  }
  try {
    const provider = await getProvider();
    const iter = provider.chat(
      { systemPrompt: buildSystem(answerCap, aggressiveness), history: [], userMessage: buildUserMessage(args.recent, question, hits) },
      args.signal,
    );
    let full = "";
    for await (const chunk of iter) {
      if (chunk.type === "token") full += chunk.text;
      else if (chunk.type === "error") return null;
      // done / thinking / cited 等忽略
    }
    const out = full.trim();
    if (!out || out.toUpperCase().includes(NO)) { args.log?.info({ source: hits[0]?.title }, "group-qa skip:LLM 判定不答(文档主题不符/闲聊/拿不准)"); return null; }
    const top = hits[0];
    return {
      answer: out.length > answerCap ? out.slice(0, answerCap).trimEnd() + "…" : out,
      sourceTitle: top?.title,
      sourceArticleId: top?.articleId,
    };
  } catch {
    return null;
  } finally {
    release();
  }
}
