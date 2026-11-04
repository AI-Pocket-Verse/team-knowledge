import { Outlet } from "react-router-dom";
import { AuroraBackground } from "./AuroraBackground";
import { AdminSidebar } from "./AdminSidebar";
import { RightTopBar } from "./RightTopBar";

// 飞书式两栏:左栏 AdminSidebar(品牌 + 分组导航)+ 右栏(RightTopBar 顶栏 + 主体)。
export function AdminShell() {
  return (
    <AuroraBackground>
      <div className="flex h-screen">
        <AdminSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <RightTopBar />
          <main className="flex-1 overflow-y-auto px-8 py-8">
            <Outlet />
          </main>
        </div>
      </div>
    </AuroraBackground>
  );
}
