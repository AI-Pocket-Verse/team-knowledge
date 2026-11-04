// 工作日早 9 点(北京时间)知识库文档体检:用内置 LLM 通读全部已发布文档,找出
// 文档间不一致 / 文档内逻辑错误 / 可优化点,组装飞书卡片推送到
// FEISHU_DOC_AUDIT_NOTIFY_CHAT_IDS 的群。
//
// 服务器上跑(prod DB + 已配置 LLM):
//   node --env-file=$INSTALL_DIR/api/.env.prod --import tsx \
//     $INSTALL_DIR/api/scripts/doc-audit.ts
// 本地预览(发测试群,读 dev 库):
//   node --env-file=.env.dev --import tsx scripts/doc-audit.ts
//
// 发送复用 feishu-sso 的内部机器人接口(机器人须在目标群)。失败逐群记日志。
import { env, AUTH_API_BASE } from "../src/env.js";
import { disconnectDb } from "../src/db.js";
import { runDocAudit } from "../src/services/doc-audit/run.js";
import { getScenarioNotifyConfig } from "../src/services/notify-config/index.js";
import { applyLlmBinPathsToEnv } from "../src/services/settings.js";

if (!AUTH_API_BASE) {
  console.error("需要先接入 feishu-sso：在 .env 里配置 WHOAMI_URL（飞书群推送经由它发送）");
  process.exit(1);
}

async function notifyChat(chatId: string, card: unknown): Promise<void> {
  const res = await fetch(`${AUTH_API_BASE}/feishu/notify`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_API_TOKEN },
    body: JSON.stringify({ chatId, card }),
  });
  if (!res.ok) throw new Error(`notify ${chatId} → HTTP ${res.status} ${await res.text().catch(() => "")}`);
}

async function main(): Promise<void> {
  // 管理后台「AI 提供方」配置的 CLI 路径存 DB,优先于 env 文件里的占位值 ——
  // 服务进程启动时会注入,独立脚本必须自己加载,否则 LLM spawn 走占位路径。
  await applyLlmBinPathsToEnv();
  // 目标群与开关来自管理后台「飞书群通知」(默认 = FEISHU_DOC_AUDIT_NOTIFY_CHAT_IDS)。
  const cfg = await getScenarioNotifyConfig("doc_audit");
  if (!cfg.enabled) {
    console.log("[doc-audit] 自动任务已在后台关闭,跳过。");
    return;
  }
  const chatIds = cfg.chatIds;
  if (chatIds.length === 0) {
    console.log("[doc-audit] 未勾选目标群,跳过。");
    return;
  }

  const now = new Date();
  const { card, report, docCount, truncated } = await runDocAudit(now);
  console.log(`[doc-audit] 检查 ${docCount} 篇文档(截断 ${truncated}),报告 ${report ? "有" : "无"} → 发 ${chatIds.length} 个群`);

  for (const chatId of chatIds) {
    try {
      await notifyChat(chatId, card);
      console.log(`[doc-audit] ✓ ${chatId}`);
    } catch (e) {
      console.error(`[doc-audit] ✗ ${(e as Error).message}`);
    }
  }
}

main()
  .catch((e) => {
    console.error("[doc-audit] 失败:", e);
    process.exitCode = 1;
  })
  .finally(() => void disconnectDb());
