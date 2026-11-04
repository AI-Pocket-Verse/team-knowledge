import { useEffect, useState, useCallback } from "react";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { CollapseChevron } from "@/components/ui/CollapseChevron";
import { getAssistantName } from "@/lib/assistantName";

type Excluded = { roleIds: Set<string>; folderIds: Set<string>; articleIds: Set<string> };
// 树形结构直接复用工作区接口(api.workspace.tree),类型从其返回值推导,避免另引 shared 类型。
type Tree = Awaited<ReturnType<typeof api.workspace.tree>>;
type FolderNode = Tree["folders"][number];
type DocNode = Tree["directArticles"][number];
type TreeState = { status: "loading" } | { status: "loaded"; tree: Tree } | { status: "error" };

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

export function AdminAssistantFilterPage() {
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [excl, setExcl] = useState<Excluded>({ roleIds: new Set(), folderIds: new Set(), articleIds: new Set() });
  // 已排除的文件夹 / 文档(带展示名),用于左侧「已排除概览」回显 + 一键移除——即便
  // 对应角色未展开,也能看到并移除被排除项,不会出现「已排除但界面看不到」。
  const [exFolders, setExFolders] = useState<{ id: string; name: string }[]>([]);
  const [exArticles, setExArticles] = useState<{ id: string; title: string }[]>([]);
  // 每个角色的子树懒加载(展开时才拉);角色多时避免一次性 N 个请求。
  const [trees, setTrees] = useState<Record<string, TreeState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const applyExcl = (ex: Awaited<ReturnType<typeof api.admin.assistantFilter.get>>) => {
    setExcl({
      roleIds: new Set(ex.roles.map((r) => r.id)),
      folderIds: new Set(ex.folders.map((f) => f.id)),
      articleIds: new Set(ex.articles.map((a) => a.id)),
    });
    setExFolders(ex.folders.map((f) => ({ id: f.id, name: f.name })));
    setExArticles(ex.articles.map((a) => ({ id: a.id, title: a.title })));
  };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // 管理页要列「全部角色」→ 用 api.admin.listRoles()(管理员全量),
      // 不是 api.workspace.listRoles()(只返回当前用户自己的角色)。
      const [allRoles, ex] = await Promise.all([api.admin.listRoles(), api.admin.assistantFilter.get()]);
      setRoles(allRoles.roles.map((r) => ({ id: r.id, name: r.name })));
      applyExcl(ex);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // 勾选变化后只刷新「排除清单」,不整页 reload(否则树会被 loading 态闪没)。
  const refreshExcl = useCallback(async () => {
    try { applyExcl(await api.admin.assistantFilter.get()); }
    catch (e) { toast.error(errMsg(e)); }
  }, []);

  const loadTree = useCallback(async (roleId: string) => {
    setTrees((t) => ({ ...t, [roleId]: { status: "loading" } }));
    try {
      const tree = await api.workspace.tree(roleId);
      setTrees((t) => ({ ...t, [roleId]: { status: "loaded", tree } }));
    } catch (e) {
      setTrees((t) => ({ ...t, [roleId]: { status: "error" } }));
      toast.error(errMsg(e));
    }
  }, []);

  const toggleExpand = (roleId: string) => {
    const willExpand = !expanded.has(roleId);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willExpand) next.add(roleId); else next.delete(roleId);
      return next;
    });
    // 首次展开或上次加载失败 → (重新)拉取。
    if (willExpand && (!trees[roleId] || trees[roleId].status === "error")) void loadTree(roleId);
  };

  const toggle = async (type: "role" | "folder" | "article", id: string, on: boolean) => {
    try {
      if (on) await api.admin.assistantFilter.add(type, id);
      else await api.admin.assistantFilter.remove(type, id);
      await refreshExcl();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  // 去状态后:所有文档都可作为排除对象列出(空/过短文档不进检索由后端兜底)。
  const listDocs = (docs: DocNode[]) => docs;

  // 文档行。ancestorExcluded = 角色或所在文件夹链上有任一被(直接)排除 → 继承屏蔽,
  // 复选框置灰且不可单独取消(需取消其祖先)。缩进由父级容器的 pl-5 负责(逐层右移)。
  function renderDoc(doc: DocNode, ancestorExcluded: boolean) {
    const direct = excl.articleIds.has(doc.id);
    const on = ancestorExcluded || direct;
    return (
      <li key={`doc-${doc.id}`} className="flex items-center gap-2 py-0.5 text-sm">
        <input
          type="checkbox"
          aria-label={`对 ${getAssistantName()} 隐藏文档 ${doc.title}`}
          checked={on}
          disabled={ancestorExcluded}
          onChange={(e) => void toggle("article", doc.id, e.target.checked)}
        />
        <span className="text-muted">📄</span>
        <span className={ancestorExcluded ? "text-muted line-through" : ""}>{doc.title}</span>
        {ancestorExcluded && <span className="text-xs text-muted">已继承屏蔽</span>}
      </li>
    );
  }

  // 文件夹行(含其下子文件夹 + 已发布文档)。文件夹最多两级,renderFolder 递归即可。
  // 子级用 `pl-5` 容器再缩进一层,形成 角色 → 文件夹 → 子文件夹 → 文档 的上下级阶梯
  // (与工作区左栏树同一种「每层容器左缩进」的做法)。
  function renderFolder(folder: FolderNode, ancestorExcluded: boolean) {
    const direct = excl.folderIds.has(folder.id);
    const on = ancestorExcluded || direct;
    const docs = listDocs(folder.articles);
    return (
      <li key={`folder-${folder.id}`}>
        <div className="flex items-center gap-2 py-0.5 text-sm">
          <input
            type="checkbox"
            aria-label={`对 ${getAssistantName()} 隐藏文件夹 ${folder.name}`}
            checked={on}
            disabled={ancestorExcluded}
            onChange={(e) => void toggle("folder", folder.id, e.target.checked)}
          />
          <span className="text-muted">📁</span>
          <span className={ancestorExcluded ? "text-muted line-through" : "font-medium"}>{folder.name}</span>
          {ancestorExcluded ? <span className="text-xs text-muted">已继承屏蔽</span>
            : direct ? <span className="text-xs text-amber-600">已隐藏(含其下全部)</span> : null}
        </div>
        {(folder.children.length > 0 || docs.length > 0) && (
          <ul className="border-l border-line pl-5">
            {folder.children.map((sub) => renderFolder(sub, on))}
            {docs.map((d) => renderDoc(d, on))}
          </ul>
        )}
      </li>
    );
  }

  const excludedRoles = roles.filter((r) => excl.roleIds.has(r.id));
  const nothingExcluded = excludedRoles.length === 0 && exFolders.length === 0 && exArticles.length === 0;

  return (
    <div>
      <p className="text-sm text-muted">勾选角色 / 文件夹 / 文档,{getAssistantName()} 将不再读取和分析(问答 / 会议 / 群聊答疑 / 文档体检);不影响用户正常浏览。排除某角色或文件夹会级联其下全部内容,文档仅列出「已发布」的。</p>

      <div className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-start">
        {/* 左侧模块:已排除概览(角色 / 文件夹 / 文档),跨所有角色集中查看与移除。 */}
        <aside className="w-full shrink-0 rounded-xl border border-line bg-white p-4 shadow-glass lg:w-72">
          <h2 className="text-sm font-semibold text-fg">已排除内容</h2>
          {loading ? (
            <div className="mt-3 text-sm text-muted">加载中…</div>
          ) : nothingExcluded ? (
            <div className="mt-3 text-sm text-muted">暂无排除项。在右侧勾选即可。</div>
          ) : (
            <div className="mt-3 space-y-4">
              {excludedRoles.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted">角色</div>
                  <ul className="mt-1 space-y-1">
                    {excludedRoles.map((r) => (
                      <li key={`ex-role-${r.id}`} className="flex items-center gap-2 text-sm">
                        <span className="text-muted">🏷️</span>
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        <button type="button" className="shrink-0 text-xs text-primary hover:underline" onClick={() => void toggle("role", r.id, false)}>移除</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {exFolders.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted">文件夹(含其子文件夹)</div>
                  <ul className="mt-1 space-y-1">
                    {exFolders.map((f) => (
                      <li key={`ex-folder-${f.id}`} className="flex items-center gap-2 text-sm">
                        <span className="text-muted">📁</span>
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        <button type="button" className="shrink-0 text-xs text-primary hover:underline" onClick={() => void toggle("folder", f.id, false)}>移除</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {exArticles.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted">文档</div>
                  <ul className="mt-1 space-y-1">
                    {exArticles.map((a) => (
                      <li key={`ex-article-${a.id}`} className="flex items-center gap-2 text-sm">
                        <span className="text-muted">📄</span>
                        <span className="min-w-0 flex-1 truncate">{a.title}</span>
                        <button type="button" className="shrink-0 text-xs text-primary hover:underline" onClick={() => void toggle("article", a.id, false)}>移除</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </aside>

        {/* 右侧模块:角色 → 文件夹 → 子文件夹 → 已发布文档 树,任意层级可勾选排除。 */}
        <section className="min-w-0 flex-1 rounded-xl border border-line bg-white p-4 shadow-glass">
          {loading ? (
            <div className="text-sm text-muted">加载中…</div>
          ) : roles.length === 0 ? (
            <div className="text-sm text-muted">暂无角色</div>
          ) : (
            <ul className="space-y-1">
              {roles.map((r) => {
                const roleOn = excl.roleIds.has(r.id);
                const isOpen = expanded.has(r.id);
                const ts = trees[r.id];
                const emptyTree = ts?.status === "loaded" && ts.tree.folders.length === 0 && listDocs(ts.tree.directArticles).length === 0;
                return (
                  <li key={r.id}>
                    <div className="flex items-center gap-2 text-sm">
                      <button
                        type="button"
                        aria-label={`${isOpen ? "收起" : "展开"} ${r.name}`}
                        className="flex h-5 w-5 shrink-0 items-center justify-center text-muted hover:text-fg"
                        onClick={() => toggleExpand(r.id)}
                      >
                        <CollapseChevron open={isOpen} />
                      </button>
                      <input
                        type="checkbox"
                        aria-label={`对 ${getAssistantName()} 隐藏角色 ${r.name}`}
                        checked={roleOn}
                        onChange={(e) => void toggle("role", r.id, e.target.checked)}
                      />
                      <span className="font-medium">{r.name}</span>
                      {roleOn && <span className="text-xs text-amber-600">已隐藏(含其下全部文档)</span>}
                    </div>
                    {isOpen && (
                      // 角色的子树整体向右缩进一层(对齐到角色复选框右侧),形成上下级阶梯。
                      // 角色行有 20px 的展开箭头(文件夹行没有),所以这里 ml-7(≈箭头+间距宽)
                      // 把引导线落到角色复选框下方,子项再 pl-5,刚好比角色复选框右移一个层级,
                      // 与更深层 文件夹→子文件夹→文档 的 pl-5 步进保持一致。
                      <div className="ml-7 mt-0.5 border-l border-line pl-5">
                        {!ts || ts.status === "loading" ? (
                          <div className="py-0.5 text-xs text-muted">加载中…</div>
                        ) : ts.status === "error" ? (
                          <div className="py-0.5 text-xs text-rose-600">加载失败,点箭头重试</div>
                        ) : emptyTree ? (
                          <div className="py-0.5 text-xs text-muted">该角色下暂无已发布文档</div>
                        ) : (
                          <ul>
                            {ts.tree.folders.map((f) => renderFolder(f, roleOn))}
                            {listDocs(ts.tree.directArticles).map((d) => renderDoc(d, roleOn))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
