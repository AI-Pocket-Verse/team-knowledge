import { create } from "zustand";

// 助手显示名的唯一真值源：由 api 的 /api/me 下发（服务端 ASSISTANT_NAME），
// auth bootstrap 成功后写入；未取到前用默认值 "AI"。
// 非 React 代码用 getAssistantName()，必须在渲染时调用，不能在模块顶层缓存。
const DEFAULT_ASSISTANT_NAME = "AI";

const useAssistantNameStore = create<{ name: string }>(() => ({ name: DEFAULT_ASSISTANT_NAME }));

export function setAssistantName(name: string | undefined | null): void {
  useAssistantNameStore.setState({ name: name?.trim() || DEFAULT_ASSISTANT_NAME });
}

export function getAssistantName(): string {
  return useAssistantNameStore.getState().name;
}
