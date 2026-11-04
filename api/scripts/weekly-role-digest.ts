// 周五周报:统计本周(北京自然周)各角色知识库文档变动 + 管理后台配置的 GitHub
// 仓库的本周提交(不含本仓库),用 LLM 写一段简评,组装飞书
// 卡片推送到 FEISHU_WEEKLY_DIGEST_CHAT_IDS 的群。
//
// 在服务器上跑(有 prod DB + token + GitHub 配置):
//   node --env-file=$INSTALL_DIR/api/.env.prod --import tsx \
//     $INSTALL_DIR/api/scripts/weekly-role-digest.ts
// 本地预览(发测试群,读 dev 库):
//   node --env-file=.env.dev --import tsx scripts/weekly-role-digest.ts
//
// 发送复用 feishu-sso 的内部机器人接口(机器人须在目标群)。失败逐群记日志。
import { env, AUTH_API_BASE } from "../src/env.js";
import { disconnectDb } from "../src/db.js";
import { generateWeeklyDigest } from "../src/services/role-digest/run.js";
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
  // 目标群与开关来自管理后台「飞书群通知」(默认 = FEISHU_WEEKLY_DIGEST_CHAT_IDS)。
  const cfg = await getScenarioNotifyConfig("weekly_digest");
  if (!cfg.enabled) {
    console.log("[weekly-digest] 自动任务已在后台关闭,跳过。");
    return;
  }
  const chatIds = cfg.chatIds;
  if (chatIds.length === 0) {
    console.log("[weekly-digest] 未勾选目标群,跳过。");
    return;
  }

  const now = new Date();
  const { card, digest, repos, review } = await generateWeeklyDigest(now);

  const repoTotal = repos.reduce((n, r) => n + r.count, 0);
  console.log(
    `[weekly-digest] ${digest.weekLabel}:角色变动 ${digest.roles.length} 个(新增 ${digest.totals.created}/更新 ${digest.totals.updated}),` +
    `GitHub ${repos.length} 仓库共 ${repoTotal} 提交,简评 ${review ? "有" : "无"} → 发 ${chatIds.length} 个群`,
  );

  for (const chatId of chatIds) {
    try {
      await notifyChat(chatId, card);
      console.log(`[weekly-digest] ✓ ${chatId}`);
    } catch (e) {
      console.error(`[weekly-digest] ✗ ${(e as Error).message}`);
    }
  }
}

main()
  .catch((e) => {
    console.error("[weekly-digest] 失败:", e);
    process.exitCode = 1;
  })
  .finally(() => void disconnectDb());
