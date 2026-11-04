import { getAssistantName } from "@/lib/assistantName";
// Role labels that open each chat-export card. Shared by the builder
// (ShareToDocDialog.buildShareMarkdown, which writes them) and the
// read-view enhancer (useChatCardEnhancer, which detects them) so the
// card detection always matches what was generated.
export const CHAT_CARD_USER_LABEL = "🙋 用户";
// 助手卡片标签随 ASSISTANT_NAME 变化，生成时用函数取当前名；识别时只认固定前缀（历史文档里存的名字可能不同）。
export const CHAT_CARD_ASSISTANT_PREFIX = "🤖";
export const chatCardAssistantLabel = () => `${CHAT_CARD_ASSISTANT_PREFIX} ${getAssistantName()}`;
