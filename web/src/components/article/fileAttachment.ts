// 附件文档的「原子卡片」节点(inline atom)。
//
// 背景:附件此前是「文本 + 链接标记」,本质是可编辑文本 —— 能被逐字删、
// 光标能进内部。改成一个真正的 ProseMirror 原子节点后:内部完全不可编辑、
// 选中即整体、删除必然整块。
//
// 存储仍是普通 markdown 链接 `[📎 名称 (大小)](/uploads/x)`(导出 .md、老文档
// 都不变)。往返靠两段:
//   1) 解析:remark transformer 在 mdast 阶段把「指向 /uploads/ 的 link」改成
//      我们的节点类型 `file-attachment`,从而只有本节点的 parseMarkdown 命中,
//      不与 commonmark 的 link 标记抢匹配(避免歧义)。
//   2) 序列化:本节点的 toMarkdown 再吐回一个标准 link 节点 → `[label](url)`。
// 图片是 `image` 节点(不是 link)、提及是 `/d/*`(非 /uploads/),都不受影响。
import { $nodeSchema, $remark } from "@milkdown/utils";
import type { DOMOutputSpec } from "prosemirror-model";

export const FILE_ATTACHMENT_ID = "file-attachment";

// 最小 mdast 形状(只用到这几个字段),避免引入 mdast 类型依赖。
interface MdastNode {
  type: string;
  url?: string;
  value?: string;
  children?: MdastNode[];
}

// 站内上传路径:以 `/uploads/` 或 `<BASE_URL>uploads/` 开头(不是「包含」),
// 外站链接、javascript: 等一律不当附件。
const SITE_UPLOAD_PREFIX = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/") + "uploads/";
export function isSafeUploadSrc(src: unknown): src is string {
  return typeof src === "string" && (src.startsWith("/uploads/") || src.startsWith(SITE_UPLOAD_PREFIX));
}

// 点击时的二次核对:解析后必须与当前站点同源,返回可打开的绝对地址,否则 null。
export function openableUploadUrl(src: string, origin: string): string | null {
  if (!isSafeUploadSrc(src)) return null;
  try {
    const url = new URL(src, origin);
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

// 递归拼出 link 的可见文本,如 `📎 名称.后缀 (10 KB)`。
function extractText(children: MdastNode[] | undefined): string {
  if (!Array.isArray(children)) return "";
  return children
    .map((c) => (typeof c.value === "string" ? c.value : extractText(c.children)))
    .join("");
}

// 把 `📎 名称.后缀 (10 KB)` 拆成 { name, size }。名称里可能自带括号,故用
// 「锚定到结尾的最后一组括号」当大小,其余当名称;拆不出大小就整体当名称。
export function splitLabel(label: string): { name: string; size: string } {
  const withoutIcon = label.replace(/^\s*📎\s*/u, "");
  const m = withoutIcon.match(/^(.*?)\s*(?:\(([^()]*)\))?\s*$/u);
  return {
    name: (m?.[1] ?? withoutIcon).trim(),
    size: (m?.[2] ?? "").trim(),
  };
}

// 由 { name, size } 拼回存储用的可见文本(含 📎),与历史格式一致。
export function attachmentLabelText(name: string, size: string): string {
  return size ? `📎 ${name} (${size})` : `📎 ${name}`;
}

// remark transformer:把「指向 /uploads/ 的 link」改类型为 file-attachment。
// 只改 type,保留 url / children 供 parseMarkdown 读取。
export const remarkFileAttachment = $remark("remark-file-attachment", () => () => (tree: MdastNode) => {
  const walk = (node: MdastNode) => {
    if (!node || typeof node !== "object" || !Array.isArray(node.children)) return;
    for (const child of node.children) {
      if (child.type === "link" && typeof child.url === "string" && isSafeUploadSrc(child.url)) {
        child.type = FILE_ATTACHMENT_ID;
      }
      walk(child);
    }
  };
  walk(tree);
});

export const fileAttachmentSchema = $nodeSchema(FILE_ATTACHMENT_ID, () => ({
  inline: true,
  group: "inline",
  selectable: true,
  draggable: true,
  atom: true,
  marks: "",
  attrs: {
    src: { default: "", validate: "string" },
    name: { default: "", validate: "string" },
    size: { default: "", validate: "string" },
  },
  // 仅认我们自己渲染的 chip(带 .tm-file-chip 类),这样从别处粘贴的普通
  // /uploads/ 链接仍走 markdown 通道(remark transformer),不会在 DOM 层
  // 与之打架。
  parseDOM: [
    {
      tag: "a.tm-file-chip",
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === "string") return false;
        const src = dom.getAttribute("data-src") || dom.getAttribute("href") || "";
        if (!isSafeUploadSrc(src)) return false;
        return {
          src,
          name: dom.getAttribute("data-name") || "",
          size: dom.getAttribute("data-size") || "",
        };
      },
    },
  ],
  toDOM: (node): DOMOutputSpec => {
    const { src: rawSrc, name, size } = node.attrs as { src: string; name: string; size: string };
    const src = isSafeUploadSrc(rawSrc) ? rawSrc : "";
    const children: DOMOutputSpec[] = [
      ["span", { class: "tm-file-chip-icon" }, "📎"],
      ["span", { class: "tm-file-chip-name" }, name],
    ];
    if (size) children.push(["span", { class: "tm-file-chip-size" }, size]);
    // 悬浮出现的「×」删除按钮:点它整块删除该附件(见 MilkdownEditor 的
    // handleClick);点卡片其余部分则是预览。只读态由 CSS 隐藏。
    children.push(["span", { class: "tm-file-chip-remove", "aria-hidden": "true" }, "×"]);
    // 刻意【不设 href】:否则在 contenteditable=false 的原子里,原生 <a> 会把
    // 【当前页】也导航过去(表现为原页面刷新)。地址存 data-src,点击一律由
    // handleClick 走 window.open 开【新页】,当前页不动。
    return [
      "a",
      {
        class: "tm-file-chip",
        "data-src": src,
        "data-name": name,
        "data-size": size,
        // 原子节点内部完全不可编辑;点击由编辑器的 handleClick 接管(预览)。
        contenteditable: "false",
      },
      ...children,
    ];
  },
  parseMarkdown: {
    match: (node: MdastNode) => node.type === FILE_ATTACHMENT_ID,
    runner: (state, node: MdastNode, type) => {
      const { name, size } = splitLabel(extractText(node.children));
      state.addNode(type, { src: node.url ?? "", name, size });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === FILE_ATTACHMENT_ID,
    runner: (state, node) => {
      const { src, name, size } = node.attrs as { src: string; name: string; size: string };
      // 吐回标准 markdown 链接,存储/.md 导出保持 `[📎 名称 (大小)](url)`。
      state.addNode("link", [{ type: "text", value: attachmentLabelText(name, size) }], undefined, {
        url: src,
      });
    },
  },
}));

// 供 .use() 注册的插件集合(节点 schema + remark transformer)。
export const fileAttachmentPlugins = [fileAttachmentSchema, remarkFileAttachment].flat();
