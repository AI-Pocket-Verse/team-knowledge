import { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { useChatStore } from "@/stores/chat";
import { HomeChatPanel } from "./HomeChatPanel";

// 会话装载的单一入口(路由驱动):
//   - `/` 或 `/c/new`  → 新对话空态(助手落地页只输入、不预载历史;发送后由后端建
//                        会话并回传 id,onDone 跳到 /c/:id,自然落进左栏行对话)
//   - `/c/:id`         → 切到该会话
//
// 回复中也能自由切换:本轮流式按草稿 id 定向写入(见 store),切走会话不会被污染,也不会
// 把别的会话置成 streaming;故这里不再用 idle 守卫去「推迟切换 / 拦住新对话」。
// 左栏点选会先「乐观 switchConversation」再 navigate,这里对 :id 主要是深链直达 / 兜底;
// 每个路由意图只处理一次(handled),避免后台流式触发的重渲染反复重切。
export function HomeChatRoute() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    const store = useChatStore.getState();
    void store.loadConversations(); // 左栏列表保持新鲜(幂等)

    if (!conversationId || conversationId === "new") {
      // 首页 / 新对话:清空成空输入框(即便上一条还在后台流式也清 —— 切到助手就该看到新对话,
      // 而不是仍显示正在回复的那条;后台轮次按草稿 id 静默完成、落库)。每个意图只清一次。
      if (handled.current !== "") { handled.current = ""; store.newConversation(); }
      return;
    }
    if (handled.current === conversationId) return; // 该会话意图已处理(避免后台流式重渲染反复重切)
    handled.current = conversationId;
    if (store.conversationId !== conversationId) void store.switchConversation(conversationId);
  }, [conversationId]);

  return <HomeChatPanel />;
}
