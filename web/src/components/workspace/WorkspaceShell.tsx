import { Outlet } from "react-router-dom";
import { useChatStore } from "@/stores/chat";
import { AuroraBackground } from "@/components/shell/AuroraBackground";
import { RightTopBar } from "@/components/shell/RightTopBar";
import { BrandStrip } from "@/components/shell/Brand";
import { WorkspaceLeftRail } from "./WorkspaceLeftRail";
import { AiBubble } from "@/components/chat/AiBubble";
import { useChatUpdates } from "@/components/chat/useChatUpdates";

// 飞书式两栏 shell:左栏(品牌 + 目录树,或无树页的细品牌条)+ 右栏(自带顶栏
// RightTopBar + 主体 main)+ 全局 AI 浮层。
//
// AI 浮层两种模式(chat store 管理):
//   - unpinned → 浮动气泡 + 居中弹层(默认)
//   - pinned   → 固定全高右侧面板;此时给 main 右侧留出该宽度,内容不被遮。
//
// 挂在此 shell 的路由:/(首页对话)、/r /f(角色/目录)、/d(文档)、/bookmarks、
// /me/profile、/meeting、/dashboard、/recycle-bin、/about 等。
//
// `showRail`:有目录树的页用 WorkspaceLeftRail;无树全宽页(个人主页/回收站/关于/
// 看板)用 BrandStrip 细品牌条,保证品牌始终在左上角。
export function WorkspaceShell({ showRail = true }: { showRail?: boolean }) {
  // AI dock 可见时给 main 预留右内边距 —— 必须与 AiBubble pinned 宽度(w-[360px])一致。
  const aiDocked = useChatStore((s) => s.isOpen && s.isPinned);
  // 飞书单聊 /助手通知落库后实时刷新网页聊天(挂在 shell 上:首页 AiBubble 不
  // 渲染、由 HomeChatPanel 接管,订阅必须比两者都长寿)。
  useChatUpdates();

  return (
    <AuroraBackground>
      {/* h-screen 两栏:左栏 full-height 固定;右栏 flex-col(顶栏 + 可滚动 main)。
          main 仍是唯一 overflow-y-auto 滚动容器 —— 文档大纲 scrollspy / 回到顶部 /
          AI dock padding 都依赖它。 */}
      <div className="flex h-screen">
        {showRail ? <WorkspaceLeftRail /> : <BrandStrip />}
        <div className="flex min-w-0 flex-1 flex-col">
          <RightTopBar />
          <main
            // `relative` 供首页 HomeChatPanel 的 absolute inset-5 定位。
            className="relative flex-1 overflow-y-auto overflow-x-hidden px-8 py-8 transition-[padding] duration-200"
            style={aiDocked ? { paddingRight: "calc(360px + 2rem)" } : undefined}
          >
            <Outlet />
          </main>
        </div>
      </div>
      <AiBubble />
    </AuroraBackground>
  );
}
