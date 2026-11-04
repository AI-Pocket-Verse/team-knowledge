// Parse user @mentions out of a comment body. Mentions are stored inline as
// markdown user links `[@姓名](/u/<userId>)` (the composer inserts them); this
// extracts the unique target userIds. Callers must still validate the ids
// against real, authorized users before acting on them (anti @-injection).
//
// 显示名里的 `\` `[` `]` `(` `)` 由前端序列化时用反斜杠转义(见 web 端
// CommentMentionField 的 escapeMentionName);历史上未转义的数据不含反斜杠,
// 按同一规则解析结果不变。
const NAME = String.raw`((?:\\.|[^\]\\])+)`;
const MENTION_SRC = String.raw`\[@${NAME}\]\(\/u\/([A-Za-z0-9_-]+)\)`;

export function parseMentions(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(new RegExp(MENTION_SRC, "g"))) {
    if (m[2]) ids.add(m[2]);
  }
  return [...ids];
}

/** 把提及标记 `[@name](/u/id)` 还原成 `@name`(显示名去转义)。 */
export function mentionsToPlain(body: string): string {
  return body.replace(new RegExp(MENTION_SRC, "g"), (_m, name: string) => `@${name.replace(/\\(.)/g, "$1")}`);
}
