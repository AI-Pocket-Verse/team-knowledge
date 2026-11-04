import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type ArticleWithEditing } from "@/lib/api";
import { usePageChrome } from "@/stores/pageChrome";
import { useAuth } from "@/stores/auth";
import { Input } from "@/components/ui/input";
import { ArticleActionSidebar } from "@/components/article/ArticleActionSidebar";
import { ArticleTOC, OutlineToggleIcon, hasHeadings } from "@/components/article/ArticleTOC";
import { ArticleDetailsDialog } from "@/components/article/ArticleDetailsDialog";
import { VersionHistoryDrawer } from "@/components/article/VersionHistoryDrawer";
import { ReviewIssuesDialog } from "@/components/article/ReviewIssuesDialog";
import type { ReviewFinding } from "@team-knowledge/shared";
import { CollaboratorsDialog } from "@/components/profile/CollaboratorsDialog";
import { UserName } from "@/components/UserName";
import { DelayedLoader } from "@/components/DelayedLoader";
import { fmtDateTime } from "@/lib/relativeTime";
import { BackToTopButton } from "@/components/article/BackToTopButton";
import { CommentSection, type CommentSectionHandle } from "@/components/article/CommentSection";
import { MilkdownEditor } from "@/components/article/MilkdownEditor";
import { useChatCardEnhancer } from "@/components/article/useChatCardEnhancer";
import { toast } from "@/components/Toaster";
import { useNotifyBadge } from "@/stores/notifyBadge";
import { usePersistedBool } from "@/lib/usePersistedBool";
import { useFullscreen, FULLSCREEN_CONTAINER_CLASS } from "@/lib/useFullscreen";
import { useAutosave } from "@/lib/useAutosave";
import { useEditLock } from "@/lib/useEditLock";
import { useWorkspaceTree } from "@/stores/workspaceTree";
import { useUnsavedGuard } from "@/stores/unsavedGuard";

// Server-side sentinel for "no title typed yet" (see normalizeTitle in
// api/src/routes/articles.ts). Map it to an empty input so the editor
// shows a placeholder rather than literal text the user must delete.
const UNTITLED = "未命名文档";
const fromServer = (t: string) => (t === UNTITLED ? "" : t);

// 统一文档页(看即可改):打开即只读浏览;有 canEdit 的人点正文/标题(懒锁)进入
// 编辑,改动经 useAutosave 防抖自动保存。无权限的人恒只读。并发沿用单写软锁。
export function ArticlePage() {
  const { docId: articleId } = useParams<{ docId: string }>();
  const justCreated = !!(useLocation().state as { justCreated?: boolean } | null)?.justCreated;
  const nav = useNavigate();
  const currentUserId = useAuth((s) => s.user?.id ?? null);
  const requestRoleRefresh = useWorkspaceTree((s) => s.requestRoleRefresh);
  const setGuardDirty = useUnsavedGuard((s) => s.setDirty);

  const [article, setArticle] = useState<ArticleWithEditing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [likeBusy, setLikeBusy] = useState(false);
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const [outlineOpen, setOutlineOpen] = usePersistedBool("tm.outline.open", true);
  const [outlineToggled, setOutlineToggled] = useState(false);
  const hasOutline = useMemo(() => (article ? hasHeadings(article.contentMarkdown) : false), [article]);
  const effectiveOutlineOpen = outlineToggled ? outlineOpen : hasOutline;
  const commentsRef = useRef<CommentSectionHandle | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Bump to remount the mount-once editor after its body changes out from
  // under it (version restore). Keyed into the editor's `key`.
  const [bodyRev, setBodyRev] = useState(0);
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(articleId ? `d:${articleId}` : undefined);

  // ---- 编辑内容状态(与 article 分离,避免点赞/收藏刷新 article 时被清掉) ----
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [baseline, setBaseline] = useState({ title: "", body: "" });
  // 乐观锁版本令牌用 ref:冲突解决后能同步读到最新值,不受 setState 异步影响。
  const expectedRef = useRef<string | undefined>(undefined);

  const canEdit = !!article?.permissions.canEdit;
  // AI 入库前置校验:仅有编辑权限者可见问题卡与感叹号。
  const reviewFindings = (article?.reviewFindings ?? []) as ReviewFinding[];
  const hasReviewIssues = canEdit && article?.reviewStatus === "issues" && reviewFindings.length > 0;
  const { editing, lockedByOther, beginEdit } = useEditLock({ articleId: articleId ?? null, canEdit, autoStart: justCreated });
  // 有编辑权限的人:编辑器一打开即可写(飞书式「看即可改」——工具栏在、点哪儿光标
  // 落哪儿、原生输入无残字);聚焦/点正文那一下才真正抢锁,仅当他人持锁时切回只读。
  const readOnly = !canEdit || lockedByOther;

  // 保存:仅提交相对 baseline 变化的字段,带乐观锁;成功刷新令牌 + article 元信息。
  const save = useCallback(async (d: { title: string; body: string }) => {
    if (!article) return;
    const update: Parameters<typeof api.articles.update>[1] = { expectedUpdatedAt: expectedRef.current };
    if (d.title !== baseline.title) update.title = d.title;
    if (d.body !== baseline.body) update.contentMarkdown = d.body;
    if (update.title === undefined && update.contentMarkdown === undefined) return;
    const r = await api.articles.update(article.id, update);
    expectedRef.current = r.article.updatedAt;
    setArticle(r.article); // 刷新 updatedAt 等元信息;id 不变 → 内容初始化 effect 不会重跑
    requestRoleRefresh(r.article.roleId);
  }, [article, baseline, requestRoleRefresh]);

  const autosave = useAutosave({
    enabled: editing,
    data: { title, body },
    baseline,
    save,
    onSaved: (d) => setBaseline(d),
  });
  const { state: autosaveState, lastSavedAt, dirty: autosaveDirty, flush: flushNow, overwrite } = autosave;

  // 「已保存」只闪现:保存成功后显示 2 秒即隐藏;下次改动重新走「保存中…→已保存」。
  // 非 saved 态(saving/conflict/error/初始)立即隐藏,交给各自的文案。
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (autosaveState !== "saved") { setShowSaved(false); return; }
    setShowSaved(true);
    const t = window.setTimeout(() => setShowSaved(false), 2000);
    return () => window.clearTimeout(t);
  }, [autosaveState, lastSavedAt]);

  // 冲突解决:拉最新版本令牌(保留用户编辑),再覆盖保存。
  const resolveConflict = useCallback(async () => {
    if (!article) return;
    try {
      const r = await api.articles.get(article.id);
      expectedRef.current = r.article.updatedAt;
    } catch { /* 忽略:overwrite 用当前令牌再试 */ }
    overwrite();
  }, [article, overwrite]);

  // 顶栏:面包屑 + 右侧(保存指示 + ⋯ 菜单)。无「编辑」按钮(改内联)、无「取消归档」。
  usePageChrome({
    breadcrumb: article
      ? [
          { label: article.role.name, to: `/r/${article.roleId}` },
          ...(article.folder ? [{ label: article.folder.name, to: `/f/${article.folderId}` }] : []),
          { label: article.title || "未命名文档" },
        ]
      : undefined,
    title: article ? undefined : "文档",
    rightActions: article
      ? (() => {
          const a = article;
          return (
            <div className="flex items-center gap-2">
              {canEdit && lockedByOther && (
                <span className="text-xs text-amber-600">他人正在编辑，暂为只读</span>
              )}
              {canEdit && !lockedByOther && editing && (
                <span className="text-xs text-muted">
                  {autosaveState === "saving" ? (
                    "保存中…"
                  ) : autosaveState === "conflict" ? (
                    <button type="button" onClick={() => void resolveConflict()} className="text-amber-600 hover:underline">
                      文档已更新，点此覆盖保存
                    </button>
                  ) : autosaveState === "error" ? (
                    <button type="button" onClick={() => flushNow()} className="text-red-600 hover:underline">
                      保存失败，点此重试
                    </button>
                  ) : showSaved ? (
                    "已保存"
                  ) : !lastSavedAt ? (
                    "可编辑"
                  ) : null}
                </span>
              )}
              <ActionsMenu
                open={menuOpen}
                onOpenChange={setMenuOpen}
                items={[
                  a.permissions.canManageEditors && {
                    key: "collab", label: "协同编辑",
                    onClick: () => { setMenuOpen(false); setCollabOpen(true); },
                  },
                  { key: "details", label: "文档详情", onClick: () => { setMenuOpen(false); setDetailsOpen(true); } },
                  a.permissions.canView && {
                    key: "history", label: "历史记录",
                    // 先 flush 未存编辑:版本回滚会以「服务端当前内容」为基准做快照/替换,
                    // 不先存会把防抖窗口内的编辑丢掉(回滚后被覆盖)。
                    onClick: () => { setMenuOpen(false); flushNow(); setHistoryOpen(true); },
                  },
                ]}
              />
            </div>
          );
        })()
      : undefined,
  });

  // 当前路由里的文档 id:慢响应晚到时据此丢弃,避免 A 的内容显示在 B 的 URL 下。
  const routeIdRef = useRef(articleId);
  routeIdRef.current = articleId;

  const refetch = useCallback(async () => {
    if (!articleId) return;
    try {
      const r = await api.articles.get(articleId);
      if (routeIdRef.current !== articleId) return;
      setError(null);
      setArticle(r.article);
      api.notifications
        .readByArticle(articleId)
        .then((res) => useNotifyBadge.getState().pushUnread(res.unread))
        .catch(() => {});
    } catch (err) {
      if (routeIdRef.current !== articleId) return;
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setError("该文档不存在或无权访问。");
      } else {
        setError((err as Error).message);
      }
    }
  }, [articleId]);

  // 同一组件实例内切换文档(/d/:docId 不卸载):先清掉上一篇的错误与内容,再拉新文档。
  useEffect(() => { setError(null); setArticle(null); }, [articleId]);
  useEffect(() => { void refetch(); }, [refetch]);
  useEffect(() => { setOutlineToggled(false); }, [articleId]);

  // 首次查看(飞书点进 / 任意首次)有问题的文档 → 自动弹一次问题卡。按 (id, updatedAt)
  // 记 localStorage,同一内容版本只自动弹一次;关闭后不再自动弹(感叹号仍在,可手动点开)。
  useEffect(() => {
    if (!hasReviewIssues || !article) return;
    const key = `tm-review-seen:${article.id}:${article.updatedAt}`;
    // localStorage 可能不可用/超额:用 try 包裹,失败时降级为「弹一次」而非崩溃。
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch { /* 忽略:降级处理 */ }
    setReviewOpen(true);
  }, [hasReviewIssues, article?.id, article?.updatedAt]);
  // 仅在【只读】时把聊天导出的引用块增强成卡片 —— 它直接改 ProseMirror DOM,
  // 在可编辑的编辑器上跑会破坏光标/编辑(引用等块点不出光标)。可写态不增强,
  // 引用块保持为原生可编辑节点。
  useChatCardEnhancer(!!article && readOnly, [article?.id, readOnly]);

  // 初始化编辑内容:仅在「换文档(id)」或「正文被整体替换(bodyRev,版本回滚)」时重置,
  // 不在点赞/收藏导致的 article 引用变更时重置(那时 id 不变)。
  useEffect(() => {
    if (!article) return;
    const t = fromServer(article.title);
    setTitle(t);
    setBody(article.contentMarkdown);
    setBaseline({ title: t, body: article.contentMarkdown });
    expectedRef.current = article.updatedAt;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article?.id, bodyRev]);

  // dirty 镜像进全局守卫,拦截「带未保存编辑离开」。仅在【编辑态】才镜像:纯查看态
  // (未进入编辑 / 未持锁)下根本无从产生用户改动,此时的 autosaveDirty 只会是编辑器
  // 加载归一化(尾换行/列表符号等,见 MilkdownEditor)的噪声 —— 不是要保护的编辑,
  // 不应触发「有未保存的修改,确定离开?」弹窗(实时保存 + 切档 flush 已兜底真正的编辑)。
  useEffect(() => {
    setGuardDirty(editing && autosaveDirty);
    return () => setGuardDirty(false);
  }, [editing, autosaveDirty, setGuardDirty]);

  const dirtyRef = useRef(false);
  dirtyRef.current = autosaveDirty;
  const flushRef = useRef(flushNow);
  flushRef.current = flushNow;

  // 页面卸载(关标签/刷新)专用的 keepalive 保存:普通 autosave fetch 会被卸载中断,
  // 这里按 baseline 算出变更字段、用 keepalive 发出,保住防抖窗口内的编辑。
  const beaconSave = useCallback(() => {
    if (!article) return;
    const update: Parameters<typeof api.articles.update>[1] = { expectedUpdatedAt: expectedRef.current };
    if (title !== baseline.title) update.title = title;
    if (body !== baseline.body) update.contentMarkdown = body;
    if (update.title === undefined && update.contentMarkdown === undefined) return;
    api.articles.updateBeacon(article.id, update);
  }, [article, title, body, baseline]);
  const beaconRef = useRef(beaconSave);
  beaconRef.current = beaconSave;

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ""; } };
    // 卸载走 keepalive beacon(普通 fetch 会被中断);SPA 路由卸载走下面的 flush。
    const onPageHide = () => beaconRef.current();
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
      flushRef.current();
    };
  }, []);

  // 切换文档(/d/:docId 同路由不卸载,上面的卸载 flush 不触发)前,先 flush 上一篇:
  // 否则防抖窗口内的编辑会被下一篇的初始化 effect 覆盖丢失。cleanup 在 articleId 变化时跑。
  useEffect(() => () => { flushRef.current(); }, [articleId]);

  async function toggleLike() {
    if (!article) return;
    setLikeBusy(true);
    const wasLiked = article.isLiked;
    try {
      const res = wasLiked ? await api.likes.remove(article.id) : await api.likes.add(article.id);
      setArticle({ ...article, isLiked: res.isLiked, likeCount: res.likeCount });
      toast.success(wasLiked ? "已取消点赞" : "点赞成功");
    } catch (err) {
      toast.error(`操作失败：${(err as Error).message}`);
    } finally {
      setLikeBusy(false);
    }
  }

  async function toggleBookmark() {
    if (!article) return;
    setBookmarkBusy(true);
    const wasBookmarked = article.isBookmarked;
    try {
      const res = wasBookmarked ? await api.bookmarks.remove(article.id) : await api.bookmarks.add(article.id);
      setArticle({ ...article, isBookmarked: res.isBookmarked, bookmarkCount: res.bookmarkCount });
      toast.success(wasBookmarked ? "已取消收藏" : "收藏成功");
    } catch (err) {
      toast.error(`操作失败：${(err as Error).message}`);
    } finally {
      setBookmarkBusy(false);
    }
  }

  async function copyLink() {
    if (!article) return;
    const url = window.location.origin + `/d/${article.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("链接已复制");
    } catch {
      toast.error("复制失败，请手动复制链接");
    }
  }

  async function onRestored() {
    await refetch();
    setBodyRev((n) => n + 1);
  }

  // 上传 / 提及 —— 编辑时透传给 MilkdownEditor(迁移自原编辑页)。
  const onPasteImage = useCallback(async (file: File) => (await api.uploads.image(file)).url, []);
  const onPasteFile = useCallback(async (file: File) => {
    const r = await api.uploads.file(file);
    return { url: r.url, displayName: r.originalName };
  }, []);
  const onMentionQuery = useCallback(async (q: string) => {
    if (q.length === 0) return [];
    return (await api.articles.search(q)).hits;
  }, []);

  // 懒锁:在编辑区(标题/正文)按下指针时,若有权限且尚未编辑则抢锁进入编辑。
  // 纯阅读(滚动)/点评论区不触发。
  const onEditIntent = useCallback(() => {
    if (canEdit && !editing) void beginEdit();
  }, [canEdit, editing, beginEdit]);

  const wrapFullscreen = (node: ReactElement) =>
    isFullscreen ? <div className={FULLSCREEN_CONTAINER_CLASS}>{node}</div> : node;

  if (error) return wrapFullscreen(<div className="text-red-600">{error}</div>);
  if (!article) return wrapFullscreen(<DelayedLoader />);

  const perms = article.permissions;

  return (
    <div className={"flex gap-4 -mx-4" + (isFullscreen ? ` ${FULLSCREEN_CONTAINER_CLASS}` : "")}>
      <div className="min-w-0 flex-1 flex flex-col gap-6">
        <div className="tm-article-card relative bg-white">
          <div className={`flex ${effectiveOutlineOpen ? "gap-[20px]" : ""}`}>
            {/* pt-2:大纲顶部与文章标题(同 pt-2)对齐。 */}
            <div className={`hidden xl:block shrink-0 pt-2 ${effectiveOutlineOpen ? "w-[260px] max-w-[260px]" : "w-[60px]"}`}>
              {/* pl-2(8px):卡片因 -mx-4 左缘在「右栏左 +16px」,顶栏角色面包屑在
                  px-6(+24px),故 16+8=24 → 大纲左缘对齐左上角「角色」左缘。
                  sticky -top-8(= -2rem):与编辑器工具栏(.milkdown-top-bar 同样
                  top:-2rem)一致,置顶时大纲与文章编辑框对齐。
                  max-h + flex-col:置顶时大纲恰好填满「可视区顶→底」,折叠按钮固定、
                  TOC 在容器内独立滚动到底(原来 TOC 盒底超出视口,滚不到最后几项)。
                  非全屏扣「头部 4rem + main 底 padding 2rem = 6rem」;全屏容器无头部、
                  仅 p-8,扣 2rem。 */}
              <div className={`sticky -top-8 flex flex-col pl-2 pb-4 ${isFullscreen ? "max-h-[calc(100vh-2rem)]" : "max-h-[calc(100vh-6rem)]"}`}>
                <button
                  type="button"
                  onClick={() => { setOutlineToggled(true); setOutlineOpen(!effectiveOutlineOpen); }}
                  title={effectiveOutlineOpen ? "隐藏大纲" : "显示大纲"}
                  aria-label={effectiveOutlineOpen ? "隐藏大纲" : "显示大纲"}
                  aria-pressed={effectiveOutlineOpen}
                  className={
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition " +
                    (effectiveOutlineOpen ? "bg-accent-soft text-primary" : "text-muted hover:bg-surface hover:text-primary")
                  }
                >
                  <OutlineToggleIcon open={effectiveOutlineOpen} />
                </button>
                {effectiveOutlineOpen && (
                  <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
                    <ArticleTOC markdown={body} />
                  </div>
                )}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              {/* 编辑区:标题 + 正文。懒锁触发挂在外层(捕获阶段),点评论区不触发。 */}
              <div data-testid="editor-shell" onPointerDownCapture={onEditIntent}>
                <div className="pr-4 pt-2">
                  {/* 标题 + AI 校验感叹号:编辑/只读两种态都显示感叹号,关弹窗后仍可点它再次打开。 */}
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      {editing ? (
                        <Input
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          placeholder={UNTITLED}
                          className="text-3xl font-semibold tracking-[-0.02em] h-auto rounded-none bg-transparent border-0 shadow-none focus-visible:ring-0 pl-0 pr-4 pt-0 pb-0 placeholder:text-muted/40"
                          maxLength={255}
                        />
                      ) : (
                        <h1 className="text-3xl font-semibold tracking-[-0.02em]">{title || UNTITLED}</h1>
                      )}
                    </div>
                    {hasReviewIssues && (
                      <button
                        type="button"
                        onClick={() => setReviewOpen(true)}
                        title="AI 校验发现待优化问题,点击查看"
                        aria-label="查看待优化问题"
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-500 text-sm font-bold text-white hover:bg-rose-600"
                      >
                        !
                      </button>
                    )}
                  </div>
                  <div className="mt-5 flex items-center gap-4 text-sm text-muted">
                    <UserName userId={article.createdBy?.id} name={article.createdBy?.displayName ?? "（已删除）"} />
                    <span>{fmtDateTime(article.updatedAt)}</span>
                  </div>
                </div>
                <MilkdownEditor
                  // mount-once on initialMarkdown; key by id:bodyRev so it remounts
                  // per doc and on version restore. readOnly hot-toggles via setReadonly.
                  key={`${article.id}:${bodyRev}`}
                  initialMarkdown={article.contentMarkdown}
                  readOnly={readOnly}
                  onChange={setBody}
                  // 编辑器加载后把基线对齐到「归一化后的实际内容」:否则 parse→serialize
                  // 的微小出入(尾换行/列表符号等)会让文档「加载即变脏」,即便只是查看
                  // 也触发「未保存修改,确定离开?」拦截弹窗(见 useUnsavedGuard)。
                  onReady={(md) => { setBody(md); setBaseline((b) => ({ ...b, body: md })); }}
                  onPasteImage={onPasteImage}
                  onPasteFile={onPasteFile}
                  onMentionQuery={onMentionQuery}
                />
              </div>

              {article.inboundRefs.length > 0 && (
                <section className="mt-8 pr-4">
                  <h2 className="text-sm font-semibold text-fg">被引用 ({article.inboundRefs.length})</h2>
                  <ul className="mt-2 flex flex-col gap-1 text-sm">
                    {article.inboundRefs.map((ref) => (
                      <li key={ref.id}>
                        <Link to={`/d/${ref.id}`} className="text-primary hover:underline">{ref.title}</Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <div className="pr-4">
                <CommentSection
                  articleId={article.id}
                  ref={commentsRef}
                  onCountChange={(n) => setArticle((prev) => (prev ? { ...prev, commentCount: n } : prev))}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <ArticleActionSidebar
        isLiked={article.isLiked}
        likeCount={article.likeCount}
        isBookmarked={article.isBookmarked}
        bookmarkCount={article.bookmarkCount ?? 0}
        commentCount={article.commentCount}
        canExport={article.permissions.canExport}
        exportHref={api.articles.exportUrl(article.id)}
        onLike={toggleLike}
        onBookmark={toggleBookmark}
        onComment={() => commentsRef.current?.focus()}
        onCopyLink={copyLink}
        likeBusy={likeBusy}
        bookmarkBusy={bookmarkBusy}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
      />

      <BackToTopButton />

      {perms.canManageEditors && (
        <CollaboratorsDialog
          open={collabOpen}
          onOpenChange={setCollabOpen}
          articleId={article.id}
          articleTitle={article.title || "（未命名）"}
        />
      )}
      <ArticleDetailsDialog open={detailsOpen} onOpenChange={setDetailsOpen} article={article} />
      {historyOpen && (
        <VersionHistoryDrawer
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          articleId={article.id}
          canRestore={perms.canEdit}
          onRestored={() => { void onRestored(); }}
        />
      )}
      {hasReviewIssues && article && (
        <ReviewIssuesDialog
          open={reviewOpen}
          articleId={article.id}
          findings={reviewFindings}
          currentMarkdown={article.contentMarkdown}
          expectedUpdatedAt={article.updatedAt}
          onClose={() => setReviewOpen(false)}
          onResolved={() => {
            // 忽略/一键优化后:刷新左侧目录树,让标题旁的红色感叹号及时同步消失
            // (目录树缓存里带 reviewStatus,不刷新就会残留 issues 徽标)。
            requestRoleRefresh(article.roleId);
            void refetch().then(() => setBodyRev((n) => n + 1));
          }}
        />
      )}
    </div>
  );
}

// Self-contained ⋯ actions menu — click-to-open popover with click-outside +
// Escape to dismiss. Falsy items are filtered so callers can inline permission gates.
interface ActionMenuItem {
  key: string;
  label: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
}

function ActionsMenu({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: (ActionMenuItem | false | null | undefined)[];
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const visible = items.filter((i): i is ActionMenuItem => Boolean(i));

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        title="更多操作"
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-primary"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {open && visible.length > 0 && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 min-w-[10rem] overflow-hidden rounded-xl border border-line bg-white py-1 shadow-glassLg"
        >
          {visible.map((item) =>
            item.href ? (
              <a
                key={item.key}
                href={item.href}
                download
                role="menuitem"
                onClick={() => onOpenChange(false)}
                className="block px-3 py-2 text-left text-sm text-fg transition hover:bg-surface hover:text-primary"
              >
                {item.label}
              </a>
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={item.onClick}
                className="block w-full px-3 py-2 text-left text-sm text-fg transition hover:bg-surface hover:text-primary disabled:opacity-50"
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
