// 专家地基:一次对话的编排。总台分诊 → 选中的专家(并行应答)→ 多专家则汇总 → 产出带出处
// 回答 + 步骤 trace(谁被路由/谁答了/是否汇总)。请教(consult)与升级(escalation)是已建好的能力
// (见 consult.ts / escalation.ts),在此可被接入;当前编排先覆盖「分诊 + 多专家并行 + 汇总」这条主链。
import { prisma } from "../../db.js";
import { triage, type TriageRole, type RunTriageLlm } from "./triage.js";
import { answerAsExpert, newRetrievalCache, type RunExpertLlm, type ExpertCitation, type RetrievalCache } from "./expert.js";
import { getExpertsByRoleIds } from "./config.js";
import { parseMarkers, parseUsedMarker, hasExpertMarker, parseImageMarker, stripResidualMarkers } from "./markers.js";
import { consult, newConsultContext } from "./consult.js";
import { createEscalation } from "./escalation.js";
import { prepareGeneralPrompt, type ResolvedMentions } from "../chat/prompt-core.js";
import { getProvider } from "../llm/registry.js";
import { chatSemaphore } from "../../utils/concurrency.js";
import { L, appLang, type Lang } from "../../utils/lang.js";
import { outputLanguageInstruction } from "../llm/language.js";

// 生图决策链的服务端日志(便于运维定位为何走/没走生图;按 [image] 前缀可 grep)。
function imgLog(msg: string): void { console.log(msg); }

export type RunGeneralLlm = (
  prompt: { systemPrompt: string; history: { role: "user" | "assistant"; content: string }[]; userMessage: string },
  opts: {
    images?: string[];
    onToken?: (t: string) => void;
    onCitation?: (c: { url: string; title?: string }) => void;
    // 思考过程:模型的逐字推理(text 非空)或「开始思考」信号(text="")。仅 claude + 调高 effort 时出现。
    onThinking?: (t: string) => void;
    // 思考块结束:让前端把「深度思考中」脉冲收起为「已深度思考(可展开)」,而不是一直脉冲到答复结束。
    onThinkingEnd?: () => void;
    // 抢占聊天并发闸(chatSemaphore)的等待上限。交互聊天默认 30s(抢不到即降级);
    // 后台任务(自动化)可传更长,避免同一刻多条到点时被 30s 误判失败。
    acquireTimeoutMs?: number;
    // 单次调用的整体超时。默认 180s(交互聊天);后台重任务(如自动化联网检索多轮)可传更长,
    // 避免被 180s 中断(aborted)。后台异步执行、无网关/前端在等,放长安全。
    timeoutMs?: number;
    // 覆盖 webTools 的 --max-turns(默认 6);后台联网检索重任务可调高,避免过早 error_max_turns。
    maxTurns?: number;
  },
) => Promise<string | null>;

//助手自答(总台/门控)的思考强度。【默认关闭】:实测当前 claude CLI/模型在 --effort high 下
// 并不吐出可展示的思考正文(只签名思考块、无 thinking_delta),却会显著增加时延、并在「理解文档+
// 总结+作图」这类重活上更易耗尽 web 工具轮次/触发 idle 超时 → 整轮返回空(回「我没查到相关资料」)。
// 故默认不传 --effort(行为同加思考特性之前);想试思考态可设 ASSISTANT_EFFORT=high/medium(自担时延)。
// 「中间环节可见」改由 imageDirective 的前言(思路/构图说明)承载 —— 任何 effort 下都稳定可见。
const ASSISTANT_EFFORT = process.env.ASSISTANT_EFFORT ?? "";

// 无专家(总台/门控)路径的真实流式 LLM(并发闸 + 超时 + 可选图片)。镜像 callExpertLlm:
// 放开联网(WebSearch/WebFetch)→助手能答实时类问题(天气/新闻),命中的网页 URL 经
// onCitation 回灌为出处(source:web)。这样「今天北京天气」总台也能给出实时答案 + 数据来源。
const GENERAL_TIMEOUT_MS = 180_000;
export const callGeneralLlm: RunGeneralLlm = async (prompt, opts) => {
  let release: () => void;
  try { release = await chatSemaphore.acquire(opts.acquireTimeoutMs ?? 30_000); } catch { return null; }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? GENERAL_TIMEOUT_MS);
  try {
    const provider = await getProvider();
    let text = "";
    for await (const chunk of provider.chat(prompt, ac.signal, { webTools: true, effort: ASSISTANT_EFFORT || undefined, ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}), ...(opts.images?.length ? { images: opts.images } : {}) })) {
      if (chunk.type === "token") { text += chunk.text; opts.onToken?.(chunk.text); }
      else if (chunk.type === "thinking") opts.onThinking?.(chunk.text); // 思考过程逐字回推(含「开始思考」空信号)
      else if (chunk.type === "thinking_end") opts.onThinkingEnd?.(); // 思考结束 → 收起脉冲
      else if (chunk.type === "citation") opts.onCitation?.({ url: chunk.url, title: chunk.title });
      else if (chunk.type === "error") throw new Error(chunk.message);
    }
    return text.trim() || null;
  } catch (e) {
    console.warn("[experts] general LLM 调用失败:", (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
    release();
  }
};

export type RunSummaryLlm = (system: string, user: string, onToken?: (t: string) => void) => Promise<string | null>;

export interface TraceEvent { type: "routed" | "answered" | "summarized" | "consult" | "escalation" | "image" | "websearch"; roleIds?: string[]; roleId?: string; note?: string }
// escalation:发生升级时返回决策卡详情(含 roleId 供「转交」选人),供前端在对话内渲染决策卡。
export interface EscalationDetail { id: string; roleId: string; background: string; question: string; options: string[] }
export interface OrchestrateResult { answer: string; trace: TraceEvent[]; citations: ExpertCitation[]; images?: string[]; escalationId?: string; escalation?: EscalationDetail;
  // 生图场景:模型生成图前写的「讲思路」叙述 —— 归到「思考过程」折叠区(参考 Claude/GPT),
  // 不作为答复正文(正文 answer 留空,只展示图)。普通文本答复不设此字段。
  thinking?: string }

export interface OrchestrateInput {
  lang?: Lang;                        // 界面语言(路由传 requestLang(req);缺省 appLang()):回答语言与提示文案
  question: string;
  targetRoleIds?: string[];
  conversationId?: string;            // 升级单引用
  requestingUserId?: string;          // 升级单初始 assignee = 提问者本人
  runExpertLlm?: RunExpertLlm;
  runTriageLlm?: RunTriageLlm;
  runSummaryLlm?: RunSummaryLlm;
  runGeneralLlm?: RunGeneralLlm;       // 无专家(总台)路径的流式 LLM;默认走真实 provider
  runImageGen?: (prompt: string) => Promise<string[] | null>; // 文生图(助手判定要画图时调);返回 /uploads url 或 null
  // 连续对话上下文(由路由加载传入):无专家路径拿完整记忆;专家路径只拿 summary(轻量)。
  mentions?: ResolvedMentions;         // 已 resolve 的 @引用
  images?: string[];                   // 图片绝对路径(已校验归属)
  history?: { role: "user" | "assistant"; content: string }[];
  summary?: string;
  chatPreference?: string;
  articleId?: string;                  // 文档内问答置顶(由路由 loadActiveArticle 后置入 mentions/检索)
  // 流式回调(SSE 打字机):onEvent=过程事件实时推送(分诊/作答/请教/升级/汇总);
  // onToken=最终答复逐 token 推送。两者都可缺省(缺省 = 一次性返回,行为同前)。
  onEvent?: (e: TraceEvent) => void;
  onToken?: (text: string) => void;
  onThinking?: (text: string) => void; //助手自答的思考过程逐字回推(前端「思考过程」区);text="" = 开始思考信号
  onThinkingEnd?: () => void;           // 思考块结束 → 前端收起「深度思考中」脉冲
}

// 把 trace 事件入栈并实时回推给 onEvent。
function makeEmit(trace: TraceEvent[], onEvent?: (e: TraceEvent) => void) {
  return (e: TraceEvent) => { trace.push(e); onEvent?.(e); };
}

// 协作标记安全的 token 转发:逐 token 累积,把「干净」文本推给 onToken,只扣住可能构成
// 协作标记([[CONSULT/ESCALATE ...]])的片段——正文里普通的 `[[`(如 `[[1]]`、代码)照常流式,
// 不会冻结预览。最终权威文本仍由 done 事件给出。
const MARKER_HEADS = ["[[CONSULT", "[[ESCALATE", "[[USED", "[[EXPERT", "[[IMAGE"];
// 给定从某个 `[[` 起的子串,判断它是否「可能是」协作标记(已是标记头 / 还太短无法判定)。
// 返回 false 表示这个 `[[` 后面接的是普通内容,可安全外泄。
function couldBeMarker(fromBracket: string): boolean {
  const up = fromBracket.toUpperCase();
  return MARKER_HEADS.some((h) => up.startsWith(h) || h.startsWith(up));
}
function markerSafeSink(onToken?: (t: string) => void): ((t: string) => void) | undefined {
  if (!onToken) return undefined;
  let full = "";
  let emitted = 0;
  return (t: string) => {
    full += t;
    // 找到第一个「可能是标记」的 `[[`,从它开始扣住;普通 `[[` 跳过继续找。
    let cut = -1;
    for (let i = full.indexOf("[["); i >= 0; i = full.indexOf("[[", i + 1)) {
      if (couldBeMarker(full.slice(i))) { cut = i; break; }
    }
    const safe = cut >= 0 ? full.slice(0, cut) : full;
    if (safe.length > emitted) { onToken(safe.slice(emitted)); emitted = safe.length; }
  };
}

/** 可被分诊的专家角色清单(只含 enabled 的)。一次性批量读专家设定,避免按角色 N+1。 */
export async function listExpertRoles(): Promise<TriageRole[]> {
  const roles = await prisma.role.findMany({ select: { id: true, name: true } });
  const cfgs = await getExpertsByRoleIds(roles.map((r) => r.id));
  const out: TriageRole[] = [];
  for (const r of roles) {
    const cfg = cfgs.get(r.id)!;
    if (cfg.enabled) out.push({ roleId: r.id, name: r.name, instruction: cfg.instruction });
  }
  return out;
}

// 门控指令:用户选了专家时,先让总台助手判一手——通用问题它自己答,确需专家才交接。
// 追加到 general systemPrompt 末尾;判专用时只输出 [[EXPERT]](markerSafeSink 扣住不外泄)。
function gateDirective(expertNames: string[]): string {
  return `\n\n[路由判断(仅内部判断,不要在回答里提及)]\n用户本次指定了专家:${expertNames.join("、")}。先在心里判断这个问题:\n` +
    `- 若是通用问题(打招呼、寒暄、常识、实时信息如天气/新闻/时事、与上述专家专长无关的事),你【直接给出答案本身】,自然、完整;需要实时信息就联网查。\n` +
    `  ——【不要】说明你的判断,不要出现"这是通用问题""不需要转专家""转接专家"之类的话,也不要引用团队文档。\n` +
    `- 若确实需要上述专家的专业能力才能答好,请【只输出一行 \`[[EXPERT]]\`】,不要给出任何回答、解释或文档——系统会把这轮转交给该专家。`;
}

// 生图指令:画图是助手的通用能力(底层模型不产图,由系统接文生图)。追加到 general systemPrompt。
function imageDirective(): string {
  return `\n\n[生成图片(最高优先)]\n只要用户的意图是要你【画 / 生成 / 做 / 出 / 配一张图片或图】` +
    `(如"画一张…""生成一张图""做张图""把…生成一张图""给…配张图""出张图描述一下"等,即便句中同时提到"项目/内容/资料"也算),按【两段】输出:\n` +
    `① 先自然地说明你的思路 —— 你对相关内容的理解 / 要点总结,以及你打算画一张怎样的图(主体、风格、关键元素)。这段【会展示给用户看】,让用户知道你如何理解与构图。\n` +
    `   表达上【分成 2~3 个短段,段与段之间空一行】(例如:先讲对内容的理解,再讲构图与风格各一段),不要全挤在一段里。每段一两句、简洁。\n` +
    `② 紧接着另起一行输出 \`[[IMAGE: 详细的绘画提示词]]\`:把意图扩写成具体可画的画面描述(主体 / 风格 / 构图 / 配色,中英文均可)。这一行是给绘图引擎的,用户看不到。\n` +
    `【关键】② 这一行是真正生成图片的【唯一方式】,缺了它就【不会】有图;绝不能用文字描述代替,也【不得】只口头声称"已生成 / 已画好"却不输出该行。\n` +
    `除这两段外不要再输出别的;【不要】引用团队文档。本条优先于「引用资料作答」。若用户并非要图(只是想了解 / 查询信息),忽略本条,正常回答。`;
}

// 用户诉求是否明显「要一张图」。用于兜底:模型没按指令吐 [[IMAGE]] 时,据此判定该不该补生图。
// 收紧到「生成/画/做/设计…」等动词 + 「图/图片/插画/海报…」名词的搭配,避免「图片上传/这张图」误命中。
const IMAGE_INTENT_RE = /(生成|绘制|画|做|设计|配|出|搞|整|来)[一二三两\s]{0,2}?[张幅个组套]?[^。;\n]{0,8}?(图片|图像|图|插画|海报|配图|示意图|封面|图标|logo|banner)/i;
function imageIntent(question: string): boolean {
  return IMAGE_INTENT_RE.test(question);
}

// 兜底「只产提示词」的聚焦系统提示:不带文档/usageMarker 干扰,逼模型只吐 [[IMAGE]] 一行。
const IMAGE_PROMPT_SYS =
  "你是绘画提示词助手。根据用户诉求与给定要点,【只输出一行】 `[[IMAGE: 详细绘画提示词]]`:" +
  "把要画的主体 / 风格 / 构图 / 配色写具体(中英文均可)。不要输出任何别的文字、不要解释、不要引用文档。";

// 总台 =助手平价:知识库检索 + 出处 + 人设 + 连续记忆 + @引用 + 图片。
//   gate=null:普通总台自答(没选专家)。
//   gate={experts}:门控模式——通用问题直接答(强制不挂出处),判专用则 routeToExpert=true 由调用方交接。
async function runGeneralAnswer(
  input: OrchestrateInput,
  trace: TraceEvent[],
  gate: { experts: string[] } | null,
): Promise<{ routeToExpert: boolean; result: OrchestrateResult | null }> {
  const prepared = await prepareGeneralPrompt({
    userId: input.requestingUserId ?? "system", isAdmin: true,
    chatPreference: input.chatPreference, question: input.question,
    resolvedMentions: input.mentions ?? { hits: [], snapshot: [], skillBlocks: [] },
    history: input.history ?? [], summary: input.summary, conversationId: input.conversationId,
    usageMarker: true, // 让模型声明实际引用的参考资料 → 只列真正用到的出处
    lang: input.lang,
  });
  const systemPrompt = (gate ? prepared.systemPrompt + gateDirective(gate.experts) : prepared.systemPrompt) + imageDirective();
  const run = input.runGeneralLlm ?? callGeneralLlm;
  // 联网命中的网页出处(source:web):助手答天气/实时类问题时,把数据来源回灌为出处。去重。
  const webCitations: ExpertCitation[] = [];
  const webSeen = new Set<string>();
  // 联网命中首次出现时,发一个「正在联网查询资料」过程事件(live-only,不入最终 trace):
  // 让等待期(尚无 token)的状态行从「助手思考中…」更新为更具体的「正在联网查询资料…」。
  let webAnnounced = false;
  const raw = await run(
    { systemPrompt, history: prepared.history, userMessage: prepared.userMessage },
    // 门控阶段不流式:模型若违规在 [[EXPERT]] 前夹带正文,会泄漏到打字机预览、随后又被专家答复
    // 追加 → 串字。故门控整段缓冲(通用答复经 done.answer 落地;判专用则交由专家流式接管)。
    // 非门控(总台自答)照常流式:markerSafeSink 扣住结尾 [[USED ...]] 标记(普通 `[[` 不冻结)。
    {
      images: input.images,
      // 非门控(总台自答)照常流式:让用户实时看到助手的「讲思路」过程(生图场景尤其重要——
      // codex 非流式,总结完才一次性吐出,这段叙述是生图前唯一可见的中间态)。done 时它会被归入
      // 「思考过程」折叠区(answer 留空、只留图)。markerSafeSink 扣住结尾标记不外泄。
      onToken: gate ? undefined : markerSafeSink(input.onToken),
      // 思考过程仅在【非门控】自答时透传。门控阶段的「思考」是助手在判断要不要转专家——
      // 一旦判专用,这段答复(含思考)会被丢弃、由专家重新作答,把它透出去会:① 把路由决策的
      // 思考错误地挂到专家答复上;② 泄漏 gateDirective 明确要求「不要提及」的判断过程。故与 onToken 同策略扣住。
      onThinking: gate ? undefined : input.onThinking,
      onThinkingEnd: gate ? undefined : input.onThinkingEnd,
      onCitation: ({ url, title }) => {
        if (!webAnnounced) { webAnnounced = true; input.onEvent?.({ type: "websearch" }); }
        if (!webSeen.has(url)) { webSeen.add(url); webCitations.push({ source: "web", title: title || url, ref: url }); }
      },
    },
  );
  // raw===null = 主调用失败/超时/空(非「模型说没找到」)。此时只回失败信息,【绝不生图】——
  // 否则会拿兜底文案憋出一张和项目内容无关的废图(用户明确反馈:没拿到内容就该返信息,而不是图)。
  const runOk = raw !== null;
  const answer = raw ?? L(input.lang ?? appLang(), "我没查到相关资料,换个问法或补充些背景试试。", "I could not find anything relevant. Try rephrasing or adding some context.");
  // 生图(优先于专家交接与 [[USED]]):
  //   ① 模型按指令吐了 [[IMAGE: 提示词]] → 直接生图;
  //   ② 模型【没吐标记】但诉求明显是要图(甚至口头说"已生成"却没真生)→ 兜底:用它刚写的正文当素材,
  //      做一次【只产提示词】的聚焦调用,拿到提示词再生图。彻底兜住「光说不画」。
  //   即便选了专家,画图也由助手直接生成(画图是通用能力,不属于某专家专长)。
  const tryGenerate = async (p: string): Promise<string[] | null> => {
    trace.push({ type: "image" });
    input.onEvent?.({ type: "image" }); // 前端显示「正在生成图片…」
    return input.runImageGen ? input.runImageGen(p) : null;
  };
  const img = parseImageMarker(answer);
  imgLog(`[image] gate=${!!gate} hasMarker=${!!img.prompt} intent=${imageIntent(input.question)} hasRunImageGen=${!!input.runImageGen}`);
  if (img.prompt) {
    const urls = await tryGenerate(img.prompt);
    imgLog(`[image] marker path → ${urls?.length ? "ok " + urls[0] : "生成失败(null)"}`);
    if (urls && urls.length > 0) {
      // 最终只展示图;模型这段叙述(剥掉 [[IMAGE]] 标记后的正文)作为「思考过程」折叠展示,不进答复正文。
      return { routeToExpert: false, result: { answer: "", thinking: img.clean || undefined, trace, citations: [], images: urls } };
    }
    return { routeToExpert: false, result: { answer: L(input.lang ?? appLang(), "抱歉,图片生成暂时不可用(可能未配置图像服务或调用失败),稍后再试。", "Sorry, image generation is unavailable right now (the image service may not be configured, or the call failed). Please try again later."), trace, citations: [] } };
  }
  // 门控判专用 → 不展示这段(交接给专家重新作答),由调用方路由。
  if (gate && hasExpertMarker(answer)) return { routeToExpert: true, result: null };
  // 兜底②:模型没吐 [[IMAGE]],但用户诉求明显是要图 → 聚焦再问一次只产提示词(去掉文档/usageMarker 干扰),拿到就生图。
  // 仅在主调用【成功】时才走兜底生图:失败(runOk=false)说明没真正读懂/总结到内容,不能拿废文案硬画图。
  if (runOk && input.runImageGen && imageIntent(input.question)) {
    const leadIn = stripResidualMarkers(parseUsedMarker(answer).clean);
    imgLog(`[image] no marker but intent=true → 聚焦重试拿提示词`);
    const focused = await run(
      { systemPrompt: IMAGE_PROMPT_SYS, history: [], userMessage: `用户诉求:${input.question}\n\n可参考的要点(据此构图):${leadIn.slice(0, 1200)}` },
      {},
    );
    const p2 = parseImageMarker(focused ?? "");
    imgLog(`[image] 聚焦重试 → ${focused === null ? "LLM 返回 null" : p2.prompt ? "拿到提示词" : "仍无 [[IMAGE]] 标记;原文前80字:" + (focused ?? "").slice(0, 80)}`);
    if (p2.prompt) {
      const urls = await tryGenerate(p2.prompt);
      imgLog(`[image] 兜底生图 → ${urls?.length ? "ok " + urls[0] : "生成失败(null)"}`);
      if (urls && urls.length > 0) {
        // 最终只展示图;模型刚写的总结/思路作为「思考过程」折叠展示,不进答复正文。
        return { routeToExpert: false, result: { answer: "", thinking: leadIn || undefined, trace, citations: [], images: urls } };
      }
    }
    // 兜底也没成 → 落回下方正常文本答复(至少把总结给用户)。
  }
  // 解析 [[USED]]:剥除标记得到展示正文;据「实际用到的编号」精确列出处。
  //   - 门控的通用答:不挂「团队文档」出处(答非所问的文档链接彻底不出现),但【保留联网出处】
  //     —— 天气这类实时答案的「数据来源:中国天气网」要展示。
  //   - 显式 @引用/文档内问答:出处恒为这些(用户主动引用),不受 [[USED]] 影响。
  //   - 否则按 usedNs 过滤命中文档:none → 不列;给了编号 → 只列那几条;没给标记 → 回退原口径。
  const { clean, usedNs } = parseUsedMarker(answer);
  let docCitations = prepared.citations;
  if (gate) {
    docCitations = [];
  } else if (!prepared.hadExplicitRefs && usedNs !== null) {
    docCitations = prepared.includedHits
      .filter((_, i) => usedNs.includes(i + 1))
      .map((h) => ({ source: "doc" as const, title: h.title, ref: h.articleId }));
  }
  // 最终展示文本:再过一道残留标记兜底(防「只有标记没正文」时漏出原始 [[...]]);
  // 若剥完为空(模型只给了标记、无实质内容),给一句友好兜底而非空泡/裸标记。
  const finalAnswer = stripResidualMarkers(clean || answer) || L(input.lang ?? appLang(), "嗯,这次我没组织出有效回答,换个说法再问我一次?", "Hmm, I could not put together a useful answer this time. Could you ask again in a different way?");
  return { routeToExpert: false, result: { answer: finalAnswer, trace, citations: [...docCitations, ...webCitations] } };
}

export async function orchestrate(input: OrchestrateInput): Promise<OrchestrateResult> {
  const roles = await listExpertRoles();
  // 总台不再按问题自动分诊调用专家:仅当用户【显式选中】专家(targetRoleIds)才走专家路径;
  // 否则总台用自己的知识库/知识体系自答(不传 runLlm → triage 对空选直接返回 [])。
  const selected = await triage(input.question, roles, { targetRoleIds: input.targetRoleIds });
  const trace: TraceEvent[] = [];
  const emit = makeEmit(trace, input.onEvent);

  // 本轮共享的检索缓存:多专家并行应答时,同一 question 的 kbDocs/跨模块检索只打一次库。
  const cache = newRetrievalCache();

  // 没选专家 → 总台助手自答(原行为)。routed 在自答前发,前端即时显示「助手思考中…」。
  if (selected.length === 0) {
    emit({ type: "routed", roleIds: [] });
    return (await runGeneralAnswer(input, trace, null)).result!;
  }

  const nameOf = (rid: string) => roles.find((r) => r.roleId === rid)?.name ?? rid;

  // 选了专家 → 先让总台助手门控:通用问题它直接答(不调用专家、不挂出处);
  // 确需专业能力时(gate 输出 [[EXPERT]])才把这轮交接给所选专家。无独立分类调用——
  // 复用总台主模型,靠标记声明。
  const gate = await runGeneralAnswer(input, trace, { experts: selected.map(nameOf) });
  if (!gate.routeToExpert) {
    emit({ type: "routed", roleIds: [] }); // 通用:本轮由 AI 应答
    return gate.result!;
  }

  // 专用 → 路由所选专家。routed 此刻才发(带专家 ids)→ 前端翻成「xx 专家应答中…」。
  emit({ type: "routed", roleIds: selected });

  // 单专家 → 走「可协作」回合(答→可请教别角色 / 卡住升级人工);多专家 → 并行 + 汇总。
  const roleIds = selected;
  if (roleIds.length === 1) return runPrimaryWithCollab(roleIds[0]!, input, roles, nameOf, trace, emit, cache);

  const settled = await Promise.all(
    roleIds.map(async (rid) => ({ rid, a: await answerAsExpert(rid, input.question, { runLlm: input.runExpertLlm, cache, summary: input.summary, images: input.images, mentionHits: input.mentions?.hits, lang: input.lang }) })),
  );
  const ok = settled.filter((x): x is { rid: string; a: NonNullable<typeof x.a> } => x.a !== null);
  for (const x of ok) emit({ type: "answered", roleId: x.rid });
  const citations = ok.flatMap((x) => x.a.citations);

  const lang = input.lang ?? appLang();
  if (ok.length === 0) return { answer: L(lang, "专家暂不可用,请稍后再试。", "The experts are unavailable right now. Please try again later."), trace, citations: [] };
  if (ok.length === 1) { input.onToken?.(ok[0].a.answer); return { answer: ok[0].a.answer, trace, citations }; }

  // 多专家 → 汇总成一份带出处的连贯答复(汇总文本逐 token 流式)。
  const merged = ok.map((x) => `【${nameOf(x.rid)}专家】${x.a.answer}`).join("\n\n");
  const summary = input.runSummaryLlm
    ? await input.runSummaryLlm("把多位专家的意见合成一份连贯、带出处的答复,保留各自结论与分歧;但若各专家只是寒暄/问候或都没给出实质内容,就直接用一句自然的话回应,不要罗列「综合专家意见」「出处」之类框架。" + outputLanguageInstruction(lang), merged, input.onToken)
    : null;
  emit({ type: "summarized" });
  return { answer: summary ?? merged, trace, citations };
}

// 单专家「可协作」回合:先答(允许它输出 [[CONSULT]]/[[ESCALATE]] 标记)→ 解析:
//   升级 → 建升级单并指派给【提问者】(提问者优先,可在对话/待办里定夺或转交);
//   请教 → consult 对应专家后,把意见回灌再让本专家定稿。
async function runPrimaryWithCollab(
  roleId: string,
  input: OrchestrateInput,
  roles: TriageRole[],
  nameOf: (id: string) => string,
  trace: TraceEvent[],
  emit: (e: TraceEvent) => void,
  cache: RetrievalCache,
): Promise<OrchestrateResult> {
  const peers = roles.filter((r) => r.roleId !== roleId).map((r) => r.name);
  // 升级总是指派给提问者(不再依赖配置负责人);有提问者即可升级。
  const allowEscalate = !!input.requestingUserId;

  // 首答可能含协作标记 → 用 marker-safe 转发器:干净文本边生成边打字机,标记本身不外泄。
  // 若随后要请教/升级而改写答复,done 事件携带的权威文本会覆盖预览。
  const first = await answerAsExpert(roleId, input.question, { runLlm: input.runExpertLlm, collab: { peers, allowEscalate }, onToken: markerSafeSink(input.onToken), cache, summary: input.summary, images: input.images, mentionHits: input.mentions?.hits, lang: input.lang });
  const lang = input.lang ?? appLang();
  if (!first) return { answer: L(lang, "专家暂不可用,请稍后再试。", "The expert is unavailable right now. Please try again later."), trace, citations: [] };
  emit({ type: "answered", roleId });
  const parsed = parseMarkers(first.answer);

  // 升级:专家拍不了板 → 建升级单,初始 assignee = 提问者。提问者可在对话里直接定夺或转交他人。
  if (parsed.escalate && allowEscalate && input.requestingUserId) {
    const esc = await createEscalation({
      conversationId: input.conversationId ?? "",
      roleId,
      background: parsed.escalate.background,
      question: parsed.escalate.question,
      options: parsed.escalate.options,
      assigneeUserId: input.requestingUserId,
    });
    emit({ type: "escalation", roleId, note: esc.id });
    return {
      answer: `${parsed.clean}\n\n${L(lang, `(此事需要拍板,已生成决策卡。你可以在对话里直接定夺,或转交给「${nameOf(roleId)}」负责人/其他人。)`, `(This needs a decision. A decision card has been created. You can decide right here in the chat, or hand it to the ${nameOf(roleId)} owner or someone else.)`)}`,
      trace,
      citations: first.citations,
      escalationId: esc.id,
      escalation: { id: esc.id, roleId, background: parsed.escalate.background, question: parsed.escalate.question, options: parsed.escalate.options },
    };
  }

  // 请教别角色专家:拿到其专长意见后,回灌让本专家定稿。
  if (parsed.consult) {
    const target = roles.find((r) => r.name === parsed.consult!.target || parsed.consult!.target.includes(r.name));
    if (target) {
      const c = await consult(target.roleId, parsed.consult.question, newConsultContext(), { runLlm: input.runExpertLlm, cache, summary: input.summary, lang: input.lang });
      if (c.ok) {
        emit({ type: "consult", roleId: target.roleId });
        const followUp = `原问题:${input.question}\n\n【${target.name}专家的意见】:${c.answer}\n\n请据此给出最终答复,不要再输出协作标记。`;
        // 定稿不再流式(预览已展示首答;done 携带权威终稿覆盖)。
        const finalAns = await answerAsExpert(roleId, followUp, { runLlm: input.runExpertLlm, cache, summary: input.summary, lang: input.lang });
        return { answer: finalAns?.answer ?? parsed.clean, trace, citations: [...first.citations, ...(finalAns?.citations ?? [])] };
      }
      return { answer: `${parsed.clean}\n\n${L(lang, `(想请教「${target.name}专家」但未成功:${c.reason})`, `(Tried to consult the ${target.name} expert but it did not work: ${c.reason})`)}`, trace, citations: first.citations };
    }
  }

  return { answer: parsed.clean, trace, citations: first.citations };
}
