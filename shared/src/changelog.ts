// Product changelog — single source of truth shared by web(关于页 /about)and
// api(版本播报:部署后向飞书群推送新版本内容,见 api services/changelog)。
//
// 版本号 a.b.c：
//   a (major)  — large releases / breaking shifts
//   b (minor)  — new features
//   c (patch)  — bug fixes only
// After each code commit, prepend a new entry here summarizing the change and
// bump the right digit. CHANGELOG[0] is always the latest = CURRENT_VERSION.
//
// ⚠️ 关于页/更新日志 文案铁律（每次新增或修改条目都必须遵守）：
//
// 1) 全角标点：中文文案一律用全角（：，、；（）「」？！），不得出现任何半角
//    , ; : ? ! ( ) 。半角【仅】允许出现在:时间(09:00)、版本号(v5.0.0)、英文/
//    标识符(助手、Markdown、skill.md、GitHub 等)中。
// 2) 通俗易懂：面向【全体成员】用大白话写,让人人都看得懂。禁用内部术语与实现
//    名词（如「徽标／字段／状态机／hash／reviewedAt／schema」等),能不用专有名词
//    就不用;必要时用比喻或「人人看得懂」的说法替代。
// 3) 简洁:一条一件事,用尽量少的字说清「做了什么、对我有什么用」;做过的能力都要
//    写到,但别为求短而漏内容。
// 4) 不写后台/管理员专属:「管理员特权」与「系统设置／管理后台配置」类条目一律不进
//    日志(更新日志面向全体成员);权限差异(如个人明细仅管理员)只在确有必要时一句带过。
// 5) 常规书面口吻(去口语化):通俗但要用标准、平实的书面表达,读起来像正式的产品
//    说明,而不是随口一说。不要口语化填充词、夸张语气、网络用语与语病;避免「不用盯着／
//    顺手好点／更顺手／动辄／治理了／说出／作图／切走／一次看全／不会丢／打扰你」这类
//    口语或内部味措辞,改用「无需手动操作／更易操作／更便捷／经常／修复／描述／生成／
//    离开后返回／完整展开／不会丢失／不再提示」等常规说法。

export type ChangelogKind = "major" | "minor" | "patch";

export interface ChangelogEntry {
  version: string;
  kind: ChangelogKind;
  /** 发布时间,展示格式「yyyy-MM-dd HH:mm」(北京时间)。早期条目可缺省。 */
  date?: string;
  /** 内部用(关于页 /about 不展示):该版本对应的最新 commit 短 id。留作下次整理更新
   *  日志时的对比基线——对 CHANGELOG[0].commit 跑 `git log <commit>..HEAD` 即可列出之后
   *  的全部改动,不必凭记忆。新增版本时把这里填成当时的 HEAD。 */
  commit?: string;
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.0.1",
    kind: "patch",
    date: "2026-11-04 18:31",
    items: [
      "删除目录时，如果目录里有其他成员的文档，需要由管理员删除，避免误删他人文档。",
      "添加协作者时不再显示对方的邮箱。",
      "加强 AI 助手的安全防护，AI 回答问题时无法读取服务器上的文件。",
    ],
  },
  {
    version: "1.0.0",
    kind: "major",
    date: "2026-10-30 22:00",
    items: [
      "知识库：角色、目录、文档三级组织，打开即可编辑并自动保存；支持历史版本回滚、回收站与全文检索。",
      "AI 智能问答：基于知识库检索回答并标注引用来源，支持多轮对话、图片提问与生成图片。",
      "会议助手：实时语音转写，AI 结合知识库参与讨论并朗读回答，会后自动生成纪要。",
      "文档体检：AI 定期通读知识库文档，找出文档间矛盾、逻辑错误与可优化之处。",
      "角色 Skill：把每个角色的文档汇总为 skill.md，可直接用于 Claude 与 Codex。",
      "自动化：设定定时任务，到时间自动整理内容并推送。",
      "数据看板、站内通知、个人主页与动态。",
      "可选接入飞书：飞书登录、导入飞书文档、飞书机器人问答与群聊答疑、飞书群通知。",
    ],
  },
];

export const CURRENT_VERSION = CHANGELOG[0]?.version ?? "0.0.0";
