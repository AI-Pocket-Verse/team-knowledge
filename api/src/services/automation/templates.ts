// 「从模板添加」的内置模板(代码内置;点模板 → 预填添加表单 → 用户改 → 保存)。
// 每个模板自带默认调度与提示词;webhook 地址留给用户填(独立字段)。icon 为前端图标 key。
import type { ScheduleKind, ScheduleConfig } from "./schedule.js";

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
