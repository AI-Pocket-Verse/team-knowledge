// 界面文案字典：按区域拆成多个文件(各区域独立维护，避免多人同时改一个大文件)，这里合并。
// 新增区域：建 <area>.ts(导出 zh / en)，在下面两处各加一行。
import type { Lang } from "../lang";
import * as common from "./common";
import * as shell from "./shell";
import * as workspace from "./workspace";
import * as profile from "./profile";
import * as article from "./article";
import * as chat from "./chat";
import * as experts from "./experts";
import * as meeting from "./meeting";
import * as admin from "./admin";
import * as automation from "./automation";
import * as dashboard from "./dashboard";

const zhAll = {
  ...common.zh, ...shell.zh, ...workspace.zh, ...profile.zh, ...article.zh, ...chat.zh,
  ...experts.zh, ...meeting.zh, ...admin.zh, ...automation.zh, ...dashboard.zh,
};

export type MessageKey = keyof typeof zhAll;

const enAll: Record<MessageKey, string> = {
  ...common.en, ...shell.en, ...workspace.en, ...profile.en, ...article.en, ...chat.en,
  ...experts.en, ...meeting.en, ...admin.en, ...automation.en, ...dashboard.en,
};

export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { zh: zhAll, en: enAll };
