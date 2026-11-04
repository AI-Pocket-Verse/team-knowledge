// 各区域共用的通用文案(只放真正通用的词)。翻译各区域时只读不改；需要新的通用词放进自己区域的文件。
// 中文必须与改造前逐字一致，en 逐条对应(缺一条会编译失败)。变量用 {name} 占位；英文单复数用 {n|doc|docs}。
export const zh = {
  "app.title": "团队知识库",
  "app.productName": "团队知识库",

  "menu.language": "语言：{name}",
  "menu.language.system": "跟随系统",
  "menu.language.zh": "中文",
  "menu.language.en": "English",

  "common.save": "保存",
  "common.saving": "保存中…",
  "common.cancel": "取消",
  "common.confirm": "确定",
  "common.close": "关闭",
  "common.delete": "删除",
  "common.edit": "编辑",
  "common.copy": "复制",
  "common.copied": "已复制",
  "common.download": "下载",
  "common.retry": "重试",
  "common.loading": "加载中…",
  "common.refresh": "刷新",
  "common.search": "搜索",
  "common.none": "暂无",
  "common.listSep": "、",

  "error.network": "无法连接到服务器，请检查网络或稍后重试",
  "error.loadFailed": "加载失败",
  "error.saveFailed": "保存失败",
  "error.deleteFailed": "删除失败",
  "error.actionFailed": "操作失败，请重试",
} satisfies Record<string, string>;

export const en: Record<keyof typeof zh, string> = {
  "app.title": "Team Knowledge",
  "app.productName": "Team Knowledge",

  "menu.language": "Language: {name}",
  "menu.language.system": "System",
  "menu.language.zh": "中文",
  "menu.language.en": "English",

  "common.save": "Save",
  "common.saving": "Saving…",
  "common.cancel": "Cancel",
  "common.confirm": "OK",
  "common.close": "Close",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.download": "Download",
  "common.retry": "Retry",
  "common.loading": "Loading…",
  "common.refresh": "Refresh",
  "common.search": "Search",
  "common.none": "None",
  "common.listSep": ", ",

  "error.network": "Can't reach the server. Check your network or try again later.",
  "error.loadFailed": "Failed to load",
  "error.saveFailed": "Failed to save",
  "error.deleteFailed": "Failed to delete",
  "error.actionFailed": "Something went wrong. Please try again.",
};
