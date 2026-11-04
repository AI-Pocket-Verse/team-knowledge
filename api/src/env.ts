import { z } from "zod";
import { MODEL_ID_PATTERN } from "./services/llm/model-choice.js";

// TRUST_PROXY：true / false，或 proxy-addr 支持的 loopback / IP / 网段列表（逗号分隔）。
// 留空按默认 loopback。原样把 "true" 交给 Fastify 会被当成 IP 地址而启动失败或不生效。
// 纯数字（跳数）不再支持：Fastify 5.12 起跳数无法校验直连对端，一律不信任，
// 与其静默失效不如启动时报错。
export function parseTrustProxy(v: string): boolean | string | null {
  const s = v.trim() || "loopback";
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
  if (/^\d+$/.test(s)) return null;
  return s;
}

// 可选项留空（`X=`）当作未设置，否则 .env 里写了空值的可选 URL 会让校验失败。
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const DEV_DEFAULT_DATA_DIR = "./data";
const DEV_INTERNAL_TOKEN = "dev-internal-token-change-in-prod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  PORT: z.coerce.number().default(4030),
  // 本地模式不鉴权，默认只监听本机；由同机的反向代理对外提供服务。
  HOST: z.string().default("127.0.0.1"),
  // 信任哪些反向代理传来的 X-Forwarded-*，直接交给 Fastify 的 trustProxy(proxy-addr 语法：
  // loopback、IP/网段、逗号分隔列表)。默认只信本机的反代；不要写 true，否则客户端能伪造来源 IP 绕过限流。
  TRUST_PROXY: z
    .string()
    .default("loopback")
    .transform((v, ctx) => {
      const r = parseTrustProxy(v);
      if (r === null) {
        ctx.addIssue({ code: "custom", message: "TRUST_PROXY 不支持跳数，请写 loopback、IP/网段或逗号分隔列表" });
        return z.NEVER;
      }
      return r;
    }),
  // No default: a missing DATABASE_URL means dotenv wasn't loaded
  // (e.g. tsx run directly instead of via `pnpm dev`). Failing fast
  // here is better than silently writing to a phantom prisma/dev.db.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required — start via `pnpm dev` (loads .env.dev) or `pnpm start` (loads .env.prod)"),
  // feishu-sso 的 whoami 地址。设置后启用飞书登录，并通过 feishu-sso 使用飞书能力
  // （通知、读文档、机器人）；不设置为本地单用户模式，飞书相关功能不可用。
  WHOAMI_URL: optional(z.string().url()),
  // Comma-separated bootstrap-admin allowlists (SSO mode only). A freshly
  // JIT-provisioned local user is created with isAdmin=true when their SSO
  // open_id / (lowercased) email / phone matches. After bootstrap, admins
  // assign roles / admin in-app. In local mode the single local user is admin.
  ADMIN_OPEN_IDS: z.string().default(""),
  ADMIN_EMAILS: z.string().default(""),
  ADMIN_PHONES: z.string().default(""),
  WEB_ORIGIN: z.string().default("http://localhost:5030"),
  // 通知卡片里文档深链(/d/<id>)的【公开访问基址】：用户实际访问前端的地址，部署在子路径下时
  // 要带上路径前缀（如 https://example.com/kb）。与 WEB_ORIGIN 区分：WEB_ORIGIN 是 CORS
  // origin（不含路径）。
  WEB_PUBLIC_URL: z.string().default("http://localhost:5030"),
  // Filesystem location for runtime-generated data (uploads today, anything
  // else stateful added later). Dev defaults to ./data (cwd-relative);
  // production MUST set this to a stable path outside the source tree
  // (e.g. /var/lib/team-knowledge) or startup throws below.
  DATA_DIR: z.string().default(DEV_DEFAULT_DATA_DIR),
  // LLM CLI binaries. Defaults are PATH-relative names that the
  // server expects to find as a logged-in subscription tool. Tests
  // override these to point at fake shell scripts.
  CLAUDE_BIN: z.string().default("claude"),
  CODEX_BIN: z.string().default("codex"),
  // 各引擎默认使用的模型 ID(如 opus、sonnet、gpt-6.1-sol)，管理后台「AI 引擎」页可覆盖；
  // 都不设置时用 CLI 自己的默认模型。值会作为命令行参数传给 CLI，只允许字母数字开头。
  CLAUDE_MODEL: optional(z.string().trim().regex(MODEL_ID_PATTERN, "CLAUDE_MODEL 只能包含字母、数字和 . _ - : / [ ]，且以字母或数字开头")),
  CODEX_MODEL: optional(z.string().trim().regex(MODEL_ID_PATTERN, "CODEX_MODEL 只能包含字母、数字和 . _ - : / [ ]，且以字母或数字开头")),
  // 火山 TTS 的 X-Api-Resource-Id；留空用默认 volc.service_type.10029(旧版控制台)，新版控制台按开通的服务填写。
  VOLC_TTS_RESOURCE_ID: optional(z.string()),
  // 部署语言(zh / en)：飞书卡片与群推送、定时任务、周报、角色 Skill、会议纪要等共享内容，
  // 以及没带 X-Lang 的请求(飞书机器人、脚本)都按它输出。个人界面与问答跟随各自的界面语言。
  APP_LANGUAGE: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.enum(["zh", "en"]).default("zh")),
  // 助手的显示名，用于界面、提示词、飞书卡片；留空回退默认值。
  ASSISTANT_NAME: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().default("AI")),
  // 会议唤醒词，逗号分隔；转写文本里出现任意一个就直接触发助手回答。留空回退默认值。
  WAKE_WORDS: z.string().default("小助手"),
  // Shared secret for app→app calls with feishu-sso (bot pushes out, bot chat in).
  // Dev default lets the stack run locally; production with SSO MUST override
  // (guarded below) to a strong value that MATCHES feishu-sso's INTERNAL_API_TOKEN.
  INTERNAL_API_TOKEN: z.string().default(DEV_INTERNAL_TOKEN),
  // When true, notification-card buttons open via a Feishu applink (in-app
  // browser) instead of the system browser. Off by default (plain https is the
  // most reliable; applink is opt-in for tenants that prefer in-Feishu opens).
  FEISHU_CARD_USE_APPLINK: z.string().default("false").transform((v) => v.toLowerCase() === "true"),
  // When true, you ARE notified about your OWN actions (liking/commenting your
  // own doc). Off by default (you don't need to hear about your own activity);
  // mainly a solo-dev/testing convenience so a single account can verify the
  // pipeline end-to-end.
  NOTIFY_INCLUDE_SELF: z.string().default("false").transform((v) => v.toLowerCase() === "true"),
  // 角色 Skill 更新后的飞书群通知:目标群 chat_id 列表(oc_*),逗号分隔,用「应用
  // 机器人」(群里 @ 问答那个)发卡片,前提是机器人已在群里。留空 = 关闭。通常与
  // 周报目标群一致(FEISHU_WEEKLY_DIGEST_CHAT_IDS)。
  FEISHU_SKILL_NOTIFY_CHAT_IDS: z.string().default(""),
  // 周五周报(scripts/weekly-role-digest.ts)推送的目标群 chat_id 列表,逗号分隔
  // (oc_*)。空 = 不发。
  FEISHU_WEEKLY_DIGEST_CHAT_IDS: z.string().default(""),
  // 会议纪要生成完成后的飞书群通知:目标群 chat_id 列表(oc_*,逗号分隔)。
  // 留空 = 关闭;通常与周报目标群一致。
  FEISHU_MEETING_NOTIFY_CHAT_IDS: z.string().default(""),
  // 工作日早 9 点(北京)知识库文档体检结果的飞书群通知:目标群 chat_id 列表。
  // 留空 = 关闭;通常与周报目标群一致。
  FEISHU_DOC_AUDIT_NOTIFY_CHAT_IDS: z.string().default(""),
  // 版本播报(部署后检测到 CHANGELOG 新版本)的飞书群通知:目标群 chat_id 列表。
  // 留空 = 关闭;通常与周报目标群一致。
  FEISHU_CHANGELOG_NOTIFY_CHAT_IDS: z.string().default(""),
  // 知识库周报(图片)定时群通知:目标群 chat_id 列表(oc_*,逗号分隔)。
  // 留空 = 关闭;通常与周报目标群一致。
  FEISHU_KB_WEEKLY_REPORT_CHAT_IDS: z.string().default(""),
  // 群 chat_id → 群名映射,仅用于「通知测试」界面把 oc_* 显示成可读群名。
  // 格式:oc_id=群名,逗号分隔;未配置的 id 回退显示原 chat_id。
  FEISHU_CHAT_NAMES: z.string().default(""),
});

export const env = schema.parse(process.env);

// feishu-sso API base for server-to-server Feishu gateway calls. Derived from
// WHOAMI_URL (…/api/whoami → …/api) so a deployment configures one URL.
// Undefined in local single-user mode (Feishu features then report
// `feishu_not_configured`).
export const AUTH_API_BASE = env.WHOAMI_URL?.replace(/\/whoami$/, "");

if (env.NODE_ENV === "production") {
  if (env.DATA_DIR === DEV_DEFAULT_DATA_DIR) {
    throw new Error(
      "DATA_DIR must be explicitly set in production (current value is the development default). " +
      "Use e.g. /var/lib/team-knowledge so uploads survive container/image rebuilds.",
    );
  }
  if (env.WHOAMI_URL && (!env.INTERNAL_API_TOKEN || env.INTERNAL_API_TOKEN === DEV_INTERNAL_TOKEN)) {
    throw new Error(
      "INTERNAL_API_TOKEN must be set in production (it is empty or the development default). " +
      "Set it to a strong random value that MATCHES feishu-sso's INTERNAL_API_TOKEN.",
    );
  }
}

// HOST 是否只监听本机回环地址。
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || /^127(\.\d{1,3}){3}$/.test(h);
}

// 启用登录后 /api/internal/* 只靠 INTERNAL_API_TOKEN 鉴权，而占位值写在公开仓库里。
// 生产环境上面已经拒绝启动；非生产环境只要 api 监听了本机以外的地址，同样拒绝启动(别的机器能直连)；
// 只监听本机时提醒一下，方便本地联调 feishu-sso。
const weakInternalToken = !!env.WHOAMI_URL && (!env.INTERNAL_API_TOKEN || env.INTERNAL_API_TOKEN === DEV_INTERNAL_TOKEN);
if (env.NODE_ENV !== "production" && weakInternalToken) {
  if (!isLoopbackHost(env.HOST)) {
    throw new Error(
      `INTERNAL_API_TOKEN is empty or the development default while login is enabled (WHOAMI_URL) and HOST=${env.HOST} ` +
      "is reachable from other machines. Set it to a strong random value (openssl rand -hex 24) that MATCHES feishu-sso's INTERNAL_API_TOKEN.",
    );
  }
  console.warn("[env] 已启用登录(WHOAMI_URL)，但 INTERNAL_API_TOKEN 是空值或开发占位值：/api/internal/* 内部接口形同虚设，请在上线前改成强随机值。");
}
