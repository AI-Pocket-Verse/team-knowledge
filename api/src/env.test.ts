import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackHost, parseTrustProxy } from "./env.js";

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 在独立进程里按给定环境变量加载 env.ts(它在 import 时校验并可能抛错)，返回是否启动成功与输出。
function loadEnv(vars: Record<string, string>): { ok: boolean; output: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", "-e", "await import('./src/env.ts')"], {
    cwd: API_DIR,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: "file:./unused.db", ...vars },
    encoding: "utf8",
  });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
}

describe("INTERNAL_API_TOKEN 占位值", () => {
  const SSO = { WHOAMI_URL: "http://127.0.0.1:4020/api/whoami" };
  it("启用登录且监听本机以外的地址时，即使不是生产环境也拒绝启动", () => {
    const r = loadEnv({ ...SSO, HOST: "0.0.0.0", INTERNAL_API_TOKEN: "dev-internal-token-change-in-prod" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("INTERNAL_API_TOKEN");
    expect(loadEnv({ ...SSO, HOST: "0.0.0.0", INTERNAL_API_TOKEN: "" }).ok).toBe(false);
  });
  it("只监听本机时允许启动(本地联调)，并给出提醒；改成强口令或本地模式都正常启动", () => {
    const local = loadEnv({ ...SSO, HOST: "127.0.0.1" });
    expect(local.ok).toBe(true);
    expect(local.output).toContain("INTERNAL_API_TOKEN");
    expect(loadEnv({ ...SSO, HOST: "0.0.0.0", INTERNAL_API_TOKEN: "a".repeat(48) }).ok).toBe(true);
    expect(loadEnv({ HOST: "0.0.0.0" }).ok).toBe(true);
  });
});

describe("isLoopbackHost", () => {
  it("只把回环地址当作本机", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "198.51.100.7", "kb.example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("parseTrustProxy", () => {
  it("留空按 loopback，true/false 转布尔，列表原样交给 Fastify", () => {
    expect(parseTrustProxy("")).toBe("loopback");
    expect(parseTrustProxy("TRUE")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("198.51.100.0/24, 127.0.0.1")).toBe("198.51.100.0/24, 127.0.0.1");
  });

  it("纯数字跳数不再支持（Fastify 5.12 起一律不信任），返回 null 让启动报错", () => {
    expect(parseTrustProxy("1")).toBeNull();
  });
});
