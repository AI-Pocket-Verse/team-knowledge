import { timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

// 服务间(feishu-sso → 本服务)共享口令校验，/api/internal/* 全部走这里。
// 口令为空时拒绝所有请求：否则空请求头会与空口令相等而通过。恒定时间比较，避免时序泄露。
export function internalTokenOk(got: unknown): boolean {
  const expected = env.INTERNAL_API_TOKEN;
  if (!expected || typeof got !== "string") return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
