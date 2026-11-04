/** 进入助手检索 / 角色技能 / 文档体检 / 聊天检索的最低正文长度(可见字符数)。 */
export const RETRIEVABLE_MIN_CHARS = 10;

/**
 * 文章正文是否「有可检索内容」。去掉草稿态后,空/过短文档不应污染检索库;
 * 用这个判定替代过去的 `status === "published"` 过滤。
 * 剥离代码块/图片/链接/markdown 标点与空白后,可见文本长度 ≥ 阈值即可检索。
 */
export function hasRetrievableContent(markdown: string): boolean {
  const text = (markdown ?? "")
    .replace(/```[\s\S]*?```/g, " ")        // 代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")   // 图片 ![alt](url)
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")    // 链接 [text](url)(整体剔除,从严)
    .replace(/[#>*_~`\-|=+]/g, " ")          // markdown 标点
    .replace(/\s+/g, " ")
    .trim();
  return text.length >= RETRIEVABLE_MIN_CHARS;
}
