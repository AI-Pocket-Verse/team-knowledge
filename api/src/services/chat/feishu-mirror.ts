// 网页端发起的聊天轮次完成后,把「问题 + 完整回答」作为一张卡片推到该用户的
// 飞书 1:1 会话 —— 与「飞书轮次实时镜像到网页」(chat-events) 互为反向,保证两边
// 看到的对话记录始终一致(飞书侧只是少了流式过程,完成后一次性出卡片)。
//
// 随问题上传的图片也一并镜像:先把本地图片字节经 feishu-sso 上传到飞书换 image_key,
// 卡片插 img 元素。单张上传失败只跳过那张(降级为纯文字),绝不影响卡片本身。
//
// 失败只记日志,绝不影响聊天轮次本身;非飞书身份(ssoId 非 ou_)静默跳过。
// 回答走 lark_md(与飞书端流式答案卡片同一渲染,markdown 正常预览),键限定
// config/header/elements 以通过 feishu-sso 端 validCard 校验。
import type { FastifyBaseLogger } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "../../db.js";
import { feishuGateway } from "../../utils/feishuGateway.js";
import { delinkLarkMd } from "../../utils/notify/card.js";
import { UPLOAD_DIR } from "../uploads/image-store.js";
import { L, appLang, type Lang } from "../../utils/lang.js";

const QUESTION_CAP = 500;
const ANSWER_CAP = 3500;

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

export function buildWebTurnCard(question: string, answer: string, imageKeys: string[] = []): unknown {
  const elements: unknown[] = [
    { tag: "div", text: { tag: "lark_md", content: L(appLang(), `**你在网页端问：**${delinkLarkMd(clip(question, QUESTION_CAP))}`, `**You asked on the web:** ${delinkLarkMd(clip(question, QUESTION_CAP))}`) } },
  ];
  for (const key of imageKeys) {
    elements.push({ tag: "img", img_key: key, alt: { tag: "plain_text", content: L(appLang(), "图片", "Image") } });
  }
  elements.push({ tag: "hr" });
  elements.push({ tag: "div", text: { tag: "lark_md", content: clip(answer, ANSWER_CAP) } });
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: L(appLang(), "网页端对话", "Web chat") }, template: "blue" },
    elements,
  };
}

export async function mirrorWebTurnToFeishu(args: {
  userId: string;
  question: string;
  answer: string;
  /** 问题携带的图片(/uploads/<file> 视图,已校验归属)。 */
  images?: string[];
  log: FastifyBaseLogger;
}): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: args.userId },
      select: { ssoId: true, isActive: true },
    });
    if (!user?.isActive || !user.ssoId || !user.ssoId.startsWith("ou_")) return;

    // 本地图片 → 飞书 image_key(经 feishu-sso,tenant token)。逐张 best-effort。
    const imageKeys: string[] = [];
    for (const url of args.images ?? []) {
      const filename = url.replace(/^\/uploads\//, "");
      try {
        const bytes = await readFile(join(UPLOAD_DIR, filename));
        const { imageKey } = await feishuGateway.uploadImage(bytes);
        imageKeys.push(imageKey);
      } catch (e) {
        args.log.warn({ err: (e as Error).message, url }, "mirror image upload to feishu failed (skipped)");
      }
    }

    await feishuGateway.notify(user.ssoId, buildWebTurnCard(args.question, args.answer, imageKeys));
  } catch (e) {
    args.log.warn({ err: (e as Error).message, userId: args.userId }, "mirror web turn to feishu failed");
  }
}
