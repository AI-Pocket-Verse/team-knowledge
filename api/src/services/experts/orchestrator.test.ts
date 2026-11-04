import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, disconnectDb } from "../../db.js";
import { resetDb, seedUser } from "../../../test-helpers/db.js";
import { setExpert } from "./config.js";
import { orchestrate } from "./orchestrator.js";

describe("experts/orchestrator", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("单专家:分诊→应答,trace 含 routed+answered", async () => {
    const prod = await prisma.role.create({ data: { name: "产品" } });
    const r = await orchestrate({
      question: "需求怎么拆",
      targetRoleIds: [prod.id],                       // 显式 → 跳过分诊
      runGeneralLlm: async () => "[[EXPERT]]",         // 门控判专用 → 交接给专家
      runExpertLlm: async () => "拆成 3 个验收点。",
    });
    expect(r.answer).toBe("拆成 3 个验收点。");
    expect(r.trace[0]).toEqual({ type: "routed", roleIds: [prod.id] });
    expect(r.trace.some((t) => t.type === "answered" && t.roleId === prod.id)).toBe(true);
  });

  it("多专家:并行应答 → 汇总,trace 含 summarized", async () => {
    const prod = await prisma.role.create({ data: { name: "产品" } });
    const tech = await prisma.role.create({ data: { name: "技术" } });
    const r = await orchestrate({
      question: "登录改造可行性",
      targetRoleIds: [prod.id, tech.id],
      runGeneralLlm: async () => "[[EXPERT]]",         // 门控判专用 → 交接给专家
      runExpertLlm: async (system) => (system.includes("技术") ? "技术上可行。" : "产品上合理。"),
      runSummaryLlm: async (_s, user) => `汇总:${user.length > 0 ? "可行且合理" : ""}`,
    });
    expect(r.answer).toBe("汇总:可行且合理");
    expect(r.trace.filter((t) => t.type === "answered")).toHaveLength(2);
    expect(r.trace.some((t) => t.type === "summarized")).toBe(true);
  });

  it("(F1 降级)部分专家不可用 → 用可用的那个,trace 只记作答的", async () => {
    const prod = await prisma.role.create({ data: { name: "产品" } });
    const tech = await prisma.role.create({ data: { name: "技术" } });
    const r = await orchestrate({
      question: "x",
      targetRoleIds: [prod.id, tech.id],
      runGeneralLlm: async () => "[[EXPERT]]",         // 门控判专用 → 交接给专家
      runExpertLlm: async (system) => (system.includes("技术") ? null : "产品答复"), // 技术专家 LLM 不可用
      runSummaryLlm: async () => "不该走到汇总",
    });
    expect(r.answer).toBe("产品答复");                                   // 退化为单专家
    expect(r.trace.filter((t) => t.type === "answered")).toHaveLength(1);
    expect(r.trace.some((t) => t.type === "summarized")).toBe(false);
  });

  it("主专家 CONSULT → 请教目标专家 → 回灌定稿,trace 记 consult", async () => {
    const prod = await prisma.role.create({ data: { name: "产品" } });
    const tech = await prisma.role.create({ data: { name: "技术" } });
    const r = await orchestrate({
      question: "登录改造",
      targetRoleIds: [prod.id],
      runGeneralLlm: async () => "[[EXPERT]]",         // 门控判专用 → 交接给专家
      runExpertLlm: async (_system, user) => {
        if (user.includes("技术专家的意见")) return "最终:可行,拆 3 个验收点。"; // 回灌后定稿
        if (user.includes("请只回答")) return "不影响视觉规范。";                  // 被请教的技术专家
        return "我先看下。\n[[CONSULT: 技术 | 这个改动影响架构吗?]]";            // 主专家(产品)
      },
    });
    expect(r.answer).toBe("最终:可行,拆 3 个验收点。");
    expect(r.trace.some((t) => t.type === "consult" && t.roleId === tech.id)).toBe(true);
  });

  it("(转交模型)主专家 ESCALATE → 升级单指派给提问者 + 返回决策卡详情(含 roleId)", async () => {
    const asker = await seedUser({ ssoId: "ou_asker" });
    const prod = await prisma.role.create({ data: { name: "产品" } });
    const r = await orchestrate({
      question: "续期时长",
      targetRoleIds: [prod.id],
      conversationId: "conv1",
      requestingUserId: asker.id,
      runGeneralLlm: async () => "[[EXPERT]]",         // 门控判专用 → 交接给专家
      runExpertLlm: async () => "我倾向 30 天。[[ESCALATE: 续期时长定不了 | 选 7 天还是 30 天 | 7 天;30 天]]",
    });
    expect(r.escalationId).toBeTruthy();
    expect(r.escalation).toMatchObject({ roleId: prod.id, question: "选 7 天还是 30 天", options: ["7 天", "30 天"] });
    expect(r.answer).toContain("决策卡");
    expect(r.trace.some((t) => t.type === "escalation")).toBe(true);
    const esc = await prisma.escalation.findUniqueOrThrow({ where: { id: r.escalationId! } });
    expect(esc.assigneeUserId).toBe(asker.id); // 初始指派给提问者
  });

  it("(转交模型)无 requestingUserId → 不升级(escalate 不触发)", async () => {
    const prod = await prisma.role.create({ data: { name: "产品" } });
    const r = await orchestrate({
      question: "续期时长",
      targetRoleIds: [prod.id],
      runGeneralLlm: async () => "[[EXPERT]]",         // 门控判专用 → 交接给专家
      runExpertLlm: async () => "我倾向 30 天。[[ESCALATE: 定不了 | 选哪个 | 7 天;30 天]]",
    });
    expect(r.escalationId).toBeUndefined();
    expect(await prisma.escalation.count()).toBe(0);
  });

  it("(F1 降级)全部专家不可用 → 如实告知,不崩", async () => {
    const prod = await prisma.role.create({ data: { name: "产品" } });
    const r = await orchestrate({ question: "x", targetRoleIds: [prod.id], runGeneralLlm: async () => "[[EXPERT]]", runExpertLlm: async () => null });
    expect(r.answer).toContain("暂不可用");
  });

  it("单专家流式:onEvent 实时收过程事件,onToken 收干净文本,标记不外泄", async () => {
    const prod = await prisma.role.create({ data: { name: "产品" } });
    const events: string[] = [];
    const tokens: string[] = [];
    const r = await orchestrate({
      question: "需求怎么拆",
      targetRoleIds: [prod.id],
      onEvent: (e) => events.push(e.type),
      onToken: (t) => tokens.push(t),
      runGeneralLlm: async () => "[[EXPERT]]",         // 门控判专用 → 交接给专家(标记被扣住不进打字机)
      // 模拟逐 token:推送干净文本 + 一个协作标记(应被 marker-safe 拦在打字机外)。
      runExpertLlm: async (_s, _u, _o, sinks) => {
        for (const t of ["拆成", "3 个", "验收点。", "[[CONSULT: 技术 | x]]"]) sinks?.onToken?.(t);
        return "拆成3 个验收点。[[CONSULT: 技术 | x]]";
      },
    });
    expect(events).toEqual(["routed", "answered"]);
    expect(tokens.join("")).toBe("拆成3 个验收点。"); // 标记被 marker-safe 拦下,未进打字机
    // consult 目标(技术)不存在于清单 → 不请教,clean 即终答
    expect(r.answer).toBe("拆成3 个验收点。");
  });

  it("正文里的普通 `[[` 不冻结打字机(只有真协作标记才扣)", async () => {
    const prod = await prisma.role.create({ data: { name: "产品" } });
    const tokens: string[] = [];
    await orchestrate({
      question: "引用怎么写",
      targetRoleIds: [prod.id],
      onToken: (t) => tokens.push(t),
      runGeneralLlm: async () => "[[EXPERT]]",         // 门控判专用 → 交接给专家
      runExpertLlm: async (_s, _u, _o, sinks) => {
        for (const t of ["见参考 ", "[[1]]", " 和 ", "[[2]]", "。"]) sinks?.onToken?.(t);
        return "见参考 [[1]] 和 [[2]]。";
      },
    });
    expect(tokens.join("")).toBe("见参考 [[1]] 和 [[2]]。"); // 普通 [[ 全部流式,未冻结
  });

  it("多专家:汇总文本经 onToken 流式", async () => {
    const prod = await prisma.role.create({ data: { name: "产品" } });
    const tech = await prisma.role.create({ data: { name: "技术" } });
    const tokens: string[] = [];
    const r = await orchestrate({
      question: "登录改造",
      targetRoleIds: [prod.id, tech.id],
      onToken: (t) => tokens.push(t),
      runGeneralLlm: async () => "[[EXPERT]]",         // 门控判专用 → 交接给专家
      runExpertLlm: async (system) => (system.includes("技术") ? "技术可行" : "产品合理"),
      runSummaryLlm: async (_s, _u, onToken) => { onToken?.("汇总:可行"); return "汇总:可行"; },
    });
    expect(r.answer).toBe("汇总:可行");
    expect(tokens.join("")).toBe("汇总:可行");
  });

  it("分诊选不出专家 → 总台 general 自答", async () => {
    await prisma.role.create({ data: { name: "产品" } });
    const r = await orchestrate({
      question: "今天天气",
      runTriageLlm: async () => '{"roleIds":[]}',
      runGeneralLlm: async () => "(总台)今天天气我答不了,但可以聊聊别的。",
    });
    expect(r.answer).toContain("总台");
    expect(r.trace[0]).toEqual({ type: "routed", roleIds: [] });
  });

  it("未显式选专家 → 即便给了分诊 LLM 也不自动调用专家(总台自答)", async () => {
    await prisma.role.create({ data: { name: "产品" } });
    let triageCalled = false;
    const r = await orchestrate({
      question: "帮我看下产品方案",                       // 内容明显该找产品专家
      runTriageLlm: async () => { triageCalled = true; return '{"roleIds":["产品"]}'; },
      runExpertLlm: async () => "(产品专家)不应被调用",
      runGeneralLlm: async () => "(总台)我用知识库答你。",
    });
    expect(triageCalled).toBe(false);                     // 分诊 LLM 不再被调用
    expect(r.trace[0]).toEqual({ type: "routed", roleIds: [] });
    expect(r.answer).toContain("总台");
  });

  it("无专家 + KB 命中 → 走 general,出处=doc,history/summary 注入 prompt", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.article.create({ data: { title: "登录改造方案", contentMarkdown: "免密 30 天。", roleId: role.id } });
    let seen = "";
    const r = await orchestrate({
      question: "登录改造",
      history: [{ role: "user", content: "上一句" }],
      summary: "此前聊过登录。",
      runTriageLlm: async () => '{"roleIds":[]}',
      runGeneralLlm: async (p) => { seen = p.systemPrompt; return "建议免密 30 天。"; },
    });
    expect(r.answer).toBe("建议免密 30 天。");
    expect(r.citations.some((c) => c.source === "doc" && c.title === "登录改造方案")).toBe(true);
    expect(seen).toContain("此前聊过登录。");
  });

  it("(出处精确化)通用问题声明 [[USED: none]] → 不列任何文档出处,且答复剥除标记", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    // 即便 FTS 顺带召回了这篇,模型声明没用到 → 不当出处展示(对应「你是什么模型」却挂无关文档)。
    await prisma.article.create({ data: { title: "登录改造方案", contentMarkdown: "免密 30 天。", roleId: role.id } });
    const r = await orchestrate({
      question: "登录改造",
      runTriageLlm: async () => '{"roleIds":[]}',
      runGeneralLlm: async () => "我是通用助手,直接回答。\n[[USED: none]]",
    });
    expect(r.answer).toBe("我是通用助手,直接回答。"); // 隐藏标记被剥除
    expect(r.citations).toEqual([]);                    // 通用问题不挂出处
  });

  it("(出处精确化)声明 [[USED: #1]] → 只列被实际引用的那条文档", async () => {
    const role = await prisma.role.create({ data: { name: "产品" } });
    await prisma.article.create({ data: { title: "登录改造方案", contentMarkdown: "免密 30 天。", roleId: role.id } });
    const r = await orchestrate({
      question: "登录改造",
      runTriageLlm: async () => '{"roleIds":[]}',
      runGeneralLlm: async () => "基于方案:免密 30 天。\n[[USED: #1]]",
    });
    expect(r.answer).toBe("基于方案:免密 30 天。");
    expect(r.citations.map((c) => c.title)).toEqual(["登录改造方案"]);
  });

  it("(门控)选了专家但问通用问题 → AI 直接答,不路由专家、不挂出处", async () => {
    const prod = await prisma.role.create({ data: { name: "测试" } });
    let expertCalled = false;
    const r = await orchestrate({
      question: "今天天气怎么样",
      targetRoleIds: [prod.id],
      runGeneralLlm: async () => "你想查哪个城市的天气?给我城市名即可。", // 通用 → 直接答(无 [[EXPERT]])
      runExpertLlm: async () => { expertCalled = true; return "不应被调用"; },
    });
    expect(expertCalled).toBe(false);                       // 通用问题不调用所选专家
    expect(r.answer).toBe("你想查哪个城市的天气?给我城市名即可。");
    expect(r.citations).toEqual([]);                        // 通用问题不挂出处
    expect(r.trace.filter((t) => t.type === "routed")).toEqual([{ type: "routed", roleIds: [] }]);
    expect(r.trace.some((t) => t.type === "answered")).toBe(false);
  });

  it("(门控)通用问题即便 KB 命中也不挂出处链接(修「文档·V1.3.0」答非所问)", async () => {
    const role = await prisma.role.create({ data: { name: "测试" } });
    await prisma.article.create({ data: { title: "版本说明 V1.3.0", contentMarkdown: "发布记录。", roleId: role.id } });
    const r = await orchestrate({
      question: "今天天气怎么样",
      targetRoleIds: [role.id],
      runGeneralLlm: async () => "你想查哪个城市的天气?\n[[USED: #1]]", // 即便模型误声明用到也强制清空
      runExpertLlm: async () => "不应被调用",
    });
    expect(r.answer).toBe("你想查哪个城市的天气?"); // 标记剥除
    expect(r.citations).toEqual([]);                // 答非所问的「版本说明 V1.3.0」链接不再出现
  });

  it("(门控)选了专家且确为专用 → gate 输出 [[EXPERT]] → 交接该专家应答", async () => {
    const tech = await prisma.role.create({ data: { name: "测试" } });
    const r = await orchestrate({
      question: "这个接口的回归用例怎么设计",
      targetRoleIds: [tech.id],
      runGeneralLlm: async () => "[[EXPERT]]",             // 门控判专用
      runExpertLlm: async () => "建议覆盖 5 个边界用例。",
    });
    expect(r.answer).toBe("建议覆盖 5 个边界用例。");
    expect(r.trace.find((t) => t.type === "routed")).toEqual({ type: "routed", roleIds: [tech.id] });
    expect(r.trace.some((t) => t.type === "answered" && t.roleId === tech.id)).toBe(true);
  });

  it("(门控)gate 阶段不流式(整段缓冲),即便模型在 [[EXPERT]] 前夹带正文也不外泄,只流式专家正文", async () => {
    const tech = await prisma.role.create({ data: { name: "测试" } });
    const tokens: string[] = [];
    let gateOnToken: ((t: string) => void) | undefined = () => {};
    await orchestrate({
      question: "回归用例",
      targetRoleIds: [tech.id],
      onToken: (t) => tokens.push(t),
      // 门控被关掉流式 → opts.onToken 为 undefined;即便模型违规先吐正文也无处泄漏。
      runGeneralLlm: async (_p, opts) => { gateOnToken = opts.onToken; opts.onToken?.("这个需要专业能力。[[EXPERT]]"); return "这个需要专业能力。[[EXPERT]]"; },
      runExpertLlm: async (_s, _u, _o, sinks) => { sinks?.onToken?.("正文"); return "正文"; },
    });
    expect(gateOnToken).toBeUndefined();  // 门控阶段未传 onToken(整段缓冲)
    expect(tokens.join("")).toBe("正文"); // 只有专家答复进打字机,无串字
  });

  it("(联网)总台自答联网命中 → 出处含 web(数据来源)", async () => {
    const r = await orchestrate({
      question: "今天北京天气",
      runTriageLlm: async () => '{"roleIds":[]}',
      runGeneralLlm: async (_p, opts) => { opts.onCitation?.({ url: "https://weather.cn/bj", title: "中国天气网北京预报" }); return "今天北京多云 21-34℃。"; },
    });
    expect(r.answer).toBe("今天北京多云 21-34℃。");
    expect(r.citations).toEqual([{ source: "web", title: "中国天气网北京预报", ref: "https://weather.cn/bj" }]);
  });

  it("(门控+联网)选了专家问天气 → AI 直接答,不挂团队文档但保留联网数据来源", async () => {
    const prod = await prisma.role.create({ data: { name: "测试" } });
    await prisma.article.create({ data: { title: "无关文档", contentMarkdown: "x", roleId: prod.id } });
    const r = await orchestrate({
      question: "今天北京天气",
      targetRoleIds: [prod.id],
      runGeneralLlm: async (_p, opts) => { opts.onCitation?.({ url: "https://weather.cn/bj", title: "中国天气网北京预报" }); return "今天北京多云 21-34℃。"; },
      runExpertLlm: async () => "不应被调用",
    });
    expect(r.answer).toBe("今天北京多云 21-34℃。");
    expect(r.citations).toEqual([{ source: "web", title: "中国天气网北京预报", ref: "https://weather.cn/bj" }]); // 只 web,无 doc
  });

  it("(生图)AI 判定要画图 → 调 runImageGen 回灌图片 + trace 含 image", async () => {
    let seenPrompt = "";
    const r = await orchestrate({
      question: "帮我画一只橘猫",
      runTriageLlm: async () => '{"roleIds":[]}',
      runGeneralLlm: async () => "[[IMAGE: a cute orange cat, watercolor]]",
      runImageGen: async (prompt) => { seenPrompt = prompt; return ["/uploads/gen1.png"]; },
    });
    expect(seenPrompt).toContain("orange cat");
    expect(r.images).toEqual(["/uploads/gen1.png"]);
    expect(r.trace.some((t) => t.type === "image")).toBe(true);
  });

  it("(生图)前言(思路/构图说明)归入 thinking、答复正文留空、[[IMAGE]] 行被剥除", async () => {
    const r = await orchestrate({
      question: "把项目内容总结生成一张介绍图",
      runTriageLlm: async () => '{"roleIds":[]}',
      // 模型按两段输出:① 思路前言(归入「思考过程」折叠区)② [[IMAGE]](给绘图引擎,隐藏)
      runGeneralLlm: async () => "我把项目要点整理为签到/任务/礼物三大模块,这就为你画一张简洁科技感的介绍图。\n[[IMAGE: a clean tech intro poster, white bg]]",
      runImageGen: async () => ["/uploads/intro.png"],
    });
    expect(r.images).toEqual(["/uploads/intro.png"]);
    expect(r.answer).toBe(""); // 最终只展示图 → 正文留空
    expect(r.thinking).toContain("签到/任务/礼物"); // 前言归入「思考过程」折叠区(用户可展开看「如何总结的」)
    expect(r.thinking).not.toContain("[[IMAGE"); // 绘图提示词不外泄
  });

  it("(生图兜底)模型没吐 [[IMAGE]] 却口头说『已生成』+ 诉求明显要图 → 聚焦重试拿提示词后真生图", async () => {
    let calls = 0;
    const r = await orchestrate({
      question: "把项目中的内容总结一下生成一个介绍的图片",
      runTriageLlm: async () => '{"roleIds":[]}',
      // 第一次:模型违规——只写了总结正文、谎称"已生成"、没有 [[IMAGE]];第二次(聚焦重试):吐出提示词。
      runGeneralLlm: async () => { calls++; return calls === 1 ? "已生成一张 AI 项目介绍图,概括了签到/任务/礼物。" : "[[IMAGE: a clean assistant intro poster, white bg]]"; },
      runImageGen: async () => ["/uploads/fallback.png"],
    });
    expect(calls).toBe(2); // 触发了聚焦重试
    expect(r.images).toEqual(["/uploads/fallback.png"]); // 兜底真生了图
    expect(r.answer).toBe(""); // 最终只展示图 → 正文留空
    expect(r.thinking).toContain("签到/任务/礼物"); // 模型的总结归入「思考过程」折叠区
  });

  it("(生图)主调用失败(LLM 返回 null)→ 不兜底生图,直接把失败信息作正文返回", async () => {
    let imgCalled = false;
    const r = await orchestrate({
      question: "把项目中的内容总结一下生成一个介绍的图片", // imageIntent=true
      runTriageLlm: async () => '{"roleIds":[]}',
      runGeneralLlm: async () => null, // 主调用失败/超时/空
      runImageGen: async () => { imgCalled = true; return ["/uploads/should-not.png"]; },
    });
    expect(imgCalled).toBe(false);          // 失败时绝不硬生图
    expect(r.images).toBeUndefined();
    expect(r.answer).toContain("没查到");   // 返失败信息(作正文,而非折叠思考 + 废图)
    expect(r.thinking).toBeUndefined();
  });

  it("(生图兜底)非生图诉求即便正文含『图』也不误触发兜底生图", async () => {
    let calls = 0;
    const r = await orchestrate({
      question: "项目里图片上传的大小限制是多少", // 无「生成/画…图」搭配 → 不算生图诉求
      runTriageLlm: async () => '{"roleIds":[]}',
      runGeneralLlm: async () => { calls++; return "图片上传上限是 20MB。"; },
      runImageGen: async () => ["/uploads/should-not.png"],
    });
    expect(calls).toBe(1); // 没有聚焦重试
    expect(r.images).toBeUndefined(); // 没误生图
  });

  it("(生图)选了专家也由 AI 直接生图(画图是通用能力,不交接专家)", async () => {
    const prod = await prisma.role.create({ data: { name: "测试" } });
    let expertCalled = false;
    const r = await orchestrate({
      question: "画一张 logo",
      targetRoleIds: [prod.id],
      runGeneralLlm: async () => "[[IMAGE: a minimal logo]]",
      runImageGen: async () => ["/uploads/logo.png"],
      runExpertLlm: async () => { expertCalled = true; return "不应被调用"; },
    });
    expect(expertCalled).toBe(false);
    expect(r.images).toEqual(["/uploads/logo.png"]);
  });

  it("(生图)未配置/失败(runImageGen 返回 null)→ 回一句暂不可用,不崩", async () => {
    const r = await orchestrate({
      question: "画一只猫",
      runTriageLlm: async () => '{"roleIds":[]}',
      runGeneralLlm: async () => "[[IMAGE: a cat]]",
      runImageGen: async () => null,
    });
    expect(r.images).toBeUndefined();
    expect(r.answer).toContain("暂时不可用");
  });

  it("(标记不泄漏)模型只输出 [[USED: #4]](无正文)→ 不把裸标记当答复,给友好兜底", async () => {
    const r = await orchestrate({
      question: "把项目内容生成一张图描述一下",
      runTriageLlm: async () => '{"roleIds":[]}',
      runGeneralLlm: async () => "[[USED: #4]]", // 模型misfire:只给标记没正文(复现截图里的泄漏)
    });
    expect(r.answer).not.toContain("[[USED"); // 绝不把原始标记漏到气泡
    expect(r.answer).not.toContain("[["); // 任何残留标记都不出现
    expect(r.answer.length).toBeGreaterThan(0); // 不是空泡
  });

  it("(思考过程)general 路径把模型 thinking 逐字回推给 onThinking", async () => {
    const thinks: string[] = [];
    await orchestrate({
      question: "你好",
      runTriageLlm: async () => '{"roleIds":[]}',
      runGeneralLlm: async (_p, opts) => { opts.onThinking?.(""); opts.onThinking?.("先判断意图…"); return "你好呀!"; },
      onThinking: (t) => thinks.push(t),
    });
    expect(thinks).toEqual(["", "先判断意图…"]); // 含「开始思考」空信号 + 思考文本
  });

  it("(思考过程)门控阶段的思考【不】透传(避免把路由决策思考挂到专家答复 / 泄漏判断过程)", async () => {
    const prod = await prisma.role.create({ data: { name: "测试" } });
    const thinks: string[] = [];
    await orchestrate({
      question: "帮我排查这个线上故障",
      targetRoleIds: [prod.id], // 选了专家 → 走门控
      // 门控阶段助手边思考边判断要不要转专家;最终判专用([[EXPERT]])→ 这段(含思考)应被丢弃
      runGeneralLlm: async (_p, opts) => { opts.onThinking?.("用户在问技术故障,应转技术专家…"); return "[[EXPERT]]"; },
      runExpertLlm: async () => "我是技术专家,排查步骤如下…",
      onThinking: (t) => thinks.push(t),
    });
    expect(thinks).toEqual([]); // 门控思考不外泄
  });

  it("(联网状态)首次联网命中 → 发一个 websearch 过程事件(供状态行显示)", async () => {
    const events: string[] = [];
    await orchestrate({
      question: "今天北京天气",
      runTriageLlm: async () => '{"roleIds":[]}',
      runGeneralLlm: async (_p, opts) => {
        opts.onCitation?.({ url: "https://weather.cn/bj", title: "中国天气网" });
        opts.onCitation?.({ url: "https://weather.cn/bj2", title: "其它" }); // 第二次不应再发
        return "今天北京多云。";
      },
      onEvent: (e) => events.push(e.type),
    });
    expect(events.filter((t) => t === "websearch")).toHaveLength(1); // 只发一次
  });
});
