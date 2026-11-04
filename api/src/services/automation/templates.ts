// 「从模板添加」的内置模板(代码内置;点模板 → 预填添加表单 → 用户改 → 保存)。
// 每个模板自带默认调度与提示词;webhook 地址留给用户填(独立字段)。icon 为前端图标 key。
import type { ScheduleKind, ScheduleConfig } from "./schedule.js";
import { appLang, type Lang } from "../../utils/lang.js";

export interface AutomationTemplate {
  key: string;
  icon: string;          // 前端图标 key(见 web 的图标映射)
  title: string;
  description: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  scheduleConfig: ScheduleConfig;
}

// 统一的产出/投递格式约定,拼进每个模板提示词末尾:让 AI 产出飞书 interactive 卡片 JSON。
const CARD_OUTPUT = [
  "",
  "【输出格式】",
  "- 将结果整理为一条飞书 interactive 卡片,直接输出该卡片的 JSON(飞书自定义机器人 webhook 请求体)。",
  "- 结构:{ \"msg_type\": \"interactive\", \"card\": { \"header\": {…标题…}, \"elements\": [ …markdown 内容… ] } }。",
  "- 卡片内容用 markdown 呈现;标题含日期。",
  "- 只输出该卡片 JSON 本身,并用 ```json 代码块包裹,不要任何额外解释文字。",
  "- 输出前自查 JSON 合法。",
].join("\n");

const daily = (hour: number, minute = 0): { scheduleKind: ScheduleKind; scheduleConfig: ScheduleConfig } => ({
  scheduleKind: "cron", scheduleConfig: { weekdays: [1, 2, 3, 4, 5, 6, 7], hour, minute },
});

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    key: "ai_news", icon: "news", title: "每日 AI 新闻推送",
    description: "关注当天 AI 领域的重要动态,侧重 AI 产品、模型、行业大事。",
    prompt: [
      "联网检索并整理 AI 领域的重要动态,分「产品/模型、行业/公司、研究/技术」三个维度,每维度最多 3 条。",
      "筛选规则:优先最近 1~2 天(含今天,北京时间)发布的资讯,并在摘要中注明日期;无法确认确切发布日期但确为近期重要资讯的也可纳入,标注「近期」;优先影响范围大、信息密度高、与 AI 直接相关的内容;去重(同一事件保留更权威的一条);不要编造资讯、链接或来源;确实检索不到时某维度不足 3 条按实际输出并注明「近期该维度高价值资讯不足」。",
      "每条以「标题 + 一句话摘要(含日期)」呈现。",
    ].join("\n") + CARD_OUTPUT,
    ...daily(7),
  },
  {
    key: "weekly_report", icon: "report", title: "每周工作周报",
    description: "每周五汇总本周进展,输出结构化周报。",
    prompt: "整理一份本周工作周报:分「本周完成、进行中、下周计划、风险与阻塞」四部分,条目简洁、可读。" + CARD_OUTPUT,
    scheduleKind: "cron", scheduleConfig: { weekdays: [5], hour: 18, minute: 0 },
  },
  {
    key: "english_words", icon: "word", title: "每日 5 个英语单词",
    description: "每天推荐 5 个高频实用英语单词,含释义与例句。",
    prompt: "推荐 5 个高频实用英语单词。每个给出:单词、音标、词性、中文释义、一个地道例句(附中文)。难度中等偏实用。" + CARD_OUTPUT,
    ...daily(8),
  },
  {
    key: "why_today", icon: "why", title: "每日一个为什么",
    description: "每天抛出一个有趣问题,先提问再解答。",
    prompt: "抛出一个有趣的科普问题(科学/生活/历史皆可),先用一句话提出问题,再用 3~5 句话通俗解答,结尾给一个延伸小知识。" + CARD_OUTPUT,
    ...daily(9),
  },
  {
    key: "today_in_history", icon: "history", title: "历史上的今天",
    description: "从科技、电影、音乐等领域挑选今天发生过的一件大事。",
    prompt: "以北京时间【今天】的日期,选取历史上的今天发生过的 1~3 件有意思的大事(优先科技/文化/电影/音乐领域),每件给出年份、事件与一句点评。" + CARD_OUTPUT,
    ...daily(8),
  },
  {
    key: "meeting_prep", icon: "meeting", title: "会议前准备",
    description: "会前生成一份实用的准备清单:目标、议程、材料、分工、待决策与关键问题。",
    prompt: [
      "为即将召开的团队会议做会前准备,输出一份实用、可直接套用的会前准备清单,帮助主持人与参会者高效开会。包含以下部分:",
      "① 会议目标:1~2 句,明确本次会议要达成什么;",
      "② 建议议程与时间分配:3~6 项,每项含时长;",
      "③ 需提前准备 / 提前发送的材料与数据;",
      "④ 参会人与角色分工:主持、记录、决策人等;",
      "⑤ 需要现场做出的决策 / 待确认事项;",
      "⑥ 建议提出的关键问题:推动讨论、避免遗漏;",
      "⑦ 潜在分歧或风险及应对预案;",
      "⑧ 会后跟进事项模板:负责人 + 截止时间占位。",
      "内容简洁可执行;若未指定具体会议主题,就给出通用但可直接落地的清单。",
    ].join("\n") + CARD_OUTPUT,
    scheduleKind: "cron", scheduleConfig: { weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
  },
];

// ── 英文模板(界面语言为英文时由路由返回;key / icon / 默认调度与中文模板一致)──
const CARD_OUTPUT_EN = [
  "",
  "[Output format]",
  "- Format the result as a single Feishu interactive card and output the card JSON directly (the request body for a Feishu custom-bot webhook).",
  "- Structure: { \"msg_type\": \"interactive\", \"card\": { \"header\": {…title…}, \"elements\": [ …markdown content… ] } }.",
  "- Write the card content in markdown; include the date in the title.",
  "- Output only the card JSON itself, wrapped in a ```json code block, with no extra explanation.",
  "- Check that the JSON is valid before outputting.",
].join("\n");

const EN_TEXT: Record<string, { title: string; description: string; prompt: string }> = {
  ai_news: {
    title: "Daily AI news digest",
    description: "Track the day's important AI developments: products, models and industry news.",
    prompt: [
      "Search the web and compile important AI developments in three dimensions: products / models, industry / companies, and research / technology. At most 3 items per dimension.",
      "Selection rules: prefer news published in the last 1-2 days (including today, Beijing time) and state the date in the summary; recent but undated items that are clearly important may be included and marked \"recent\"; prefer broad impact, high information density and direct relevance to AI; deduplicate (keep the more authoritative source for the same event); never invent news, links or sources; if a dimension has fewer than 3 solid items, output what you have and note \"not enough high-value recent news in this dimension\".",
      "Present each item as \"title + one-sentence summary (with date)\".",
    ].join("\n") + CARD_OUTPUT_EN,
  },
  weekly_report: {
    title: "Weekly work report",
    description: "Summarize the week's progress every Friday in a structured report.",
    prompt: "Write this week's work report in four parts: Completed, In progress, Next week's plan, and Risks and blockers. Keep items concise and readable." + CARD_OUTPUT_EN,
  },
  english_words: {
    title: "5 English words a day",
    description: "Five useful, high-frequency English words every day, with definitions and examples.",
    prompt: "Recommend 5 high-frequency, practical English words. For each give: the word, phonetic transcription, part of speech, a clear definition, and one natural example sentence. Medium difficulty, practical focus." + CARD_OUTPUT_EN,
  },
  why_today: {
    title: "A daily \"why\"",
    description: "One interesting question a day: the question first, then the answer.",
    prompt: "Pose one interesting popular-science question (science, daily life or history). State the question in one sentence, answer it in 3-5 plain sentences, and finish with a related fun fact." + CARD_OUTPUT_EN,
  },
  today_in_history: {
    title: "On this day in history",
    description: "One notable event from tech, film, music and more that happened on today's date.",
    prompt: "Using today's date in Beijing time, pick 1-3 interesting events that happened on this day in history (prefer technology, culture, film and music). For each give the year, the event and a one-line comment." + CARD_OUTPUT_EN,
  },
  meeting_prep: {
    title: "Pre-meeting preparation",
    description: "A practical prep checklist before a meeting: goals, agenda, materials, roles, decisions and key questions.",
    prompt: [
      "Prepare for an upcoming team meeting with a practical, ready-to-use checklist that helps the host and attendees run an efficient meeting. Include:",
      "1. Meeting goal: 1-2 sentences on what the meeting should achieve;",
      "2. Suggested agenda and time allocation: 3-6 items, each with a duration;",
      "3. Materials and data to prepare or send in advance;",
      "4. Attendees and roles: host, note-taker, decision-makers, etc.;",
      "5. Decisions to make / items to confirm in the meeting;",
      "6. Key questions to raise: to drive discussion and avoid gaps;",
      "7. Potential disagreements or risks, with contingency plans;",
      "8. Follow-up template: owner + due date placeholders.",
      "Keep it concise and actionable; if no specific meeting topic is given, provide a generic but directly usable checklist.",
    ].join("\n") + CARD_OUTPUT_EN,
  },
};

/** 按语言返回模板列表;中文原样返回 AUTOMATION_TEMPLATES。 */
export function automationTemplates(lang: Lang = appLang()): AutomationTemplate[] {
  if (lang !== "en") return AUTOMATION_TEMPLATES;
  return AUTOMATION_TEMPLATES.map((t) => ({ ...t, ...(EN_TEXT[t.key] ?? {}) }));
}
