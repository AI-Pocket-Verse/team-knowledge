interface Props {
  isLiked: boolean;
  likeCount: number;
  isBookmarked: boolean;
  bookmarkCount: number;
  commentCount: number;
  canExport: boolean;
  exportHref: string;
  onLike: () => void;
  onBookmark: () => void;
  onComment: () => void;
  onCopyLink: () => void;
  /** Disable just the like button (the bookmark stays clickable, and
   *  vice-versa). Previously a single `busy` blocked both, making the
   *  bar feel locked for the entire round-trip of either action. */
  likeBusy: boolean;
  bookmarkBusy: boolean;
  /** 全屏浏览(浏览器原生全屏)。按钮在「导出 Markdown」下方;全屏中
   *  图标/文案切换为退出态,再点一次或 Esc 都能退出。 */
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}

interface ActionConfig {
  key: string;
  label: string;
  active?: boolean;
  badge?: number;
  icon: React.ReactNode;
  onClick?: () => void;
  href?: string;
  hide?: boolean;
  disabled?: boolean;
}

// Solid-stroked SVG icons sized to fit the column. Inlined rather
// than pulling lucide-react so the action bar stays a single
// self-contained component.
//
// Filled variants intentionally keep the same `stroke` + `strokeWidth`
// as their outline counterparts. Without that stroke a filled glyph
// occupies just the path's natural bounding box, while the outline
// version's 2px stroke extends ~1px past every edge — so the moment
// the user clicks "like" or "bookmark", the icon visually *shrinks*.
// Sharing the stroke keeps the on/off pair pixel-identical in outer
// dimensions.
const ICON_THUMB_FILL = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 10v12" />
    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z" />
  </svg>
);
const ICON_THUMB = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 10v12" />
    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z" />
  </svg>
);
// Two overlapping speech bubbles — a "messaging conversation" glyph
// rather than the prior single tear-drop bubble. Reads as 聊天 / 评论
// at a glance because the second bubble implies someone replied.
const ICON_COMMENT = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z" />
    <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
  </svg>
);
const ICON_STAR_FILL = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01z" />
  </svg>
);
const ICON_STAR = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01z" />
  </svg>
);
const ICON_LINK = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);
const ICON_DOWNLOAD = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);
// 全屏(四角向外)/ 退出全屏(四角向内)。
const ICON_EXPAND = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </svg>
);
const ICON_COMPRESS = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M8 3v3a2 2 0 0 1-2 2H3" />
    <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
    <path d="M3 16h3a2 2 0 0 1 2 2v3" />
    <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
  </svg>
);

/**
 * Renders one row of the vertical action bar. Pure shell so each
 * action just declares label/icon/state in the parent's config list.
 */
function ActionButton({ item }: { item: ActionConfig }) {
  const className =
    "group relative flex h-12 w-12 flex-col items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-primary " +
    (item.active ? "text-primary " : "") +
    // Visual + interaction lock when the action is in-flight. Mirrors
    // `aria-disabled` so assistive tech and pointer behavior agree.
    (item.disabled ? "pointer-events-none opacity-50 cursor-not-allowed " : "");
  const inner = (
    <>
      {item.icon}
      {item.badge !== undefined && item.badge > 0 && (
        // Notification-style pill anchored to the icon's top-right.
        // Used to render BELOW the icon as a separate row — that
        // pushed the icon off-center and made the count compete with
        // the glyph for attention. As a corner badge it reads as a
        // count without disturbing the icon's hit-target geometry.
        <span className="pointer-events-none absolute top-0.5 right-0.5 inline-flex min-w-[12px] h-[12px] items-center justify-center rounded-full bg-primary px-1 text-[8px] font-medium leading-none text-white">
          {item.badge}
        </span>
      )}
      <span className="pointer-events-none absolute right-full top-1/2 z-30 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-fg/90 px-2 py-1 text-xs text-white opacity-0 shadow-sm transition group-hover:opacity-100">
        {item.label}
      </span>
    </>
  );
  if (item.href) {
    return (
      <a href={item.href} download className={className} title={item.label} aria-label={item.label}>
        {inner}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={item.onClick}
      className={className}
      title={item.label}
      aria-label={item.label}
      aria-pressed={item.active}
      aria-disabled={item.disabled || undefined}
      disabled={item.disabled}
    >
      {inner}
    </button>
  );
}

/**
 * Vertical action column shown on the left of the article detail
 * page. Mirrors the affordance set the user expects from doc tools
 * (Feishu / Notion): like / comment / bookmark / copy link / export.
 * 悬浮停留:sticky 垂直居中(top-1/2 -translate-y-1/2),滚动长文时
 * 操作栏始终浮在视口中部、不随正文滚走。
 */
export function ArticleActionSidebar(props: Props) {
  const items: ActionConfig[] = [
    {
      key: "like",
      label: props.isLiked ? "取消点赞" : "点赞",
      active: props.isLiked,
      badge: props.likeCount,
      icon: props.isLiked ? ICON_THUMB_FILL : ICON_THUMB,
      onClick: props.onLike,
      disabled: props.likeBusy,
    },
    {
      key: "comment",
      label: "评论",
      badge: props.commentCount,
      icon: ICON_COMMENT,
      onClick: props.onComment,
    },
    {
      key: "bookmark",
      label: props.isBookmarked ? "取消收藏" : "收藏",
      active: props.isBookmarked,
      badge: props.bookmarkCount,
      icon: props.isBookmarked ? ICON_STAR_FILL : ICON_STAR,
      onClick: props.onBookmark,
      disabled: props.bookmarkBusy,
    },
    {
      key: "copy",
      label: "复制链接",
      icon: ICON_LINK,
      onClick: props.onCopyLink,
    },
    {
      key: "export",
      label: "导出 Markdown",
      icon: ICON_DOWNLOAD,
      href: props.canExport ? props.exportHref : undefined,
      hide: !props.canExport,
    },
    {
      key: "fullscreen",
      label: props.isFullscreen ? "退出全屏" : "全屏浏览",
      active: props.isFullscreen,
      icon: props.isFullscreen ? ICON_COMPRESS : ICON_EXPAND,
      onClick: props.onToggleFullscreen,
    },
  ];
  return (
    // `relative z-20` creates a stacking context above the sibling
    // article card so the hover label tooltip (which extends to the
    // left of each button via `right-full`, over the card) doesn't
    // get painted underneath the card.
    <aside className="relative z-20 shrink-0 self-start sticky top-1/2 -translate-y-1/2">
      <div className="tm-article-actionbar flex flex-col items-center gap-1 rounded-3xl border border-line bg-white/90 p-1.5 shadow-glassLg backdrop-blur">
        {items.filter((i) => !i.hide).map((item) => (
          <ActionButton key={item.key} item={item} />
        ))}
      </div>
    </aside>
  );
}
