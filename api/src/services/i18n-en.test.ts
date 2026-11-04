// 英文渲染用例:APP_LANGUAGE=en 时共享内容(排期文字、卡片、体检)与 AI 输出语言指令生效;中文保持原样。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../env.js";
import { describeSchedule, normalizeSchedule } from "./automation/schedule.js";
import { automationTemplates, AUTOMATION_TEMPLATES } from "./automation/templates.js";
import { lintHeadingFormat } from "./article-review/formatLint.js";
import { reviewSystem, ARTICLE_REVIEW_SYSTEM } from "./article-review/prompt.js";
import { renderFindings, findingHash } from "./doc-audit/findings.js";
import { buildChangelogCard } from "./changelog/notify.js";
import { formatCronSchedule } from "./notify-test/index.js";
import { buildExpertSystem } from "./experts/expert.js";
import { CHANGELOG } from "@team-knowledge/shared";

const mutableEnv = env as { APP_LANGUAGE: "zh" | "en" };

describe("services 双语", () => {
  beforeEach(() => { mutableEnv.APP_LANGUAGE = "en"; });
  afterEach(() => { mutableEnv.APP_LANGUAGE = "zh"; });

  it("自动化排期文字与模板跟随语言", () => {
    expect(describeSchedule("cron", { weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 30 })).toBe("Weekdays 09:30");
    expect(describeSchedule("cron", { weekdays: [1], hour: 9, minute: 30 })).toBe("Every Mon 09:30");
    expect(describeSchedule("interval", { everyMs: 3_600_000 })).toBe("Every 1 h");
    expect(describeSchedule("cron", { weekdays: [1], hour: 9, minute: 30 }, "zh")).toBe("每周一 09:30");
    expect(() => normalizeSchedule("cron", { weekdays: [] })).toThrow(/must not be empty/);
    expect(automationTemplates()[0]!.title).toBe("Daily AI news digest");
    expect(automationTemplates("zh")).toBe(AUTOMATION_TEMPLATES);
  });

  it("文档校验:格式预检与提示词按语言", () => {
    const f = lintHeadingFormat("# A\n### **B**\n");
    expect(f.some((x) => x.problem.includes("skips a level"))).toBe(true);
    expect(f.some((x) => x.problem.includes("bold / link markup"))).toBe(true);
    expect(reviewSystem("en")).toContain("[Output language]");
    expect(reviewSystem("zh")).toBe(ARTICLE_REVIEW_SYSTEM);
    expect(lintHeadingFormat("# A\n### B\n", "zh")[0]!.problem).toContain("层级跳级");
  });

  it("文档体检渲染与版本播报卡片", () => {
    const f = { category: "logic" as const, docTitle: "Doc", problem: "p", suggestion: "s" };
    const text = renderFindings([{ ...f, hash: findingHash(f) }]);
    expect(text).toContain("## Logic errors within a doc");
    expect(text).toContain("(Suggestion: s)");
    const card = JSON.stringify(buildChangelogCard(CHANGELOG.slice(0, 1)));
    expect(card).toContain("View changelog");
  });

  it("通知控制台排期与专家提示词", () => {
    expect(formatCronSchedule({ weekdays: [5], hour: 21, minute: 0, repeat: true })).toBe("Scheduled: Every Fri 21:00 (Beijing time)");
    const sys = buildExpertSystem({ roleName: "R", instruction: "", skillMd: "", context: [] });
    expect(sys).toContain("[Output language]");
    mutableEnv.APP_LANGUAGE = "zh";
    expect(buildExpertSystem({ roleName: "R", instruction: "", skillMd: "", context: [] })).not.toContain("[Output language]");
  });
});
