import { execFile } from "node:child_process";
import { basename } from "node:path";
import { L, appLang, type Lang } from "../../utils/lang.js";

// 管理后台「命令路径」只能指向真正的 claude / codex 命令行：知识库管理员不一定是服务器运维，
// 不能借这项设置让服务进程执行服务器上的任意程序。要求文件名就是 claude / codex，
// 并且 `--version` 的输出是对应 CLI 的格式(claude:"2.1.318 (Claude Code)";codex:"codex-cli 0.165.0")。
const VERSION_PATTERN: Record<"claude" | "codex", RegExp> = {
  claude: /^\d+\.\d+\.\d+.*\(Claude Code\)/,
  codex: /^codex-cli \d+\.\d+/,
};

export type VerifyBinResult = { ok: true; version: string } | { ok: false; error: string; message: string };

export async function verifyCliBinary(which: "claude" | "codex", path: string, lang: Lang = appLang()): Promise<VerifyBinResult> {
  if (basename(path) !== which) {
    return { ok: false, error: "invalid_cli_path", message: L(lang, `${which} 路径的文件名必须是 ${which}`, `The ${which} path must point to a file named ${which}`) };
  }
  const out = await new Promise<{ stdout: string; err: string | null }>((resolve) => {
    execFile(path, ["--version"], { timeout: 10_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } }, (err, stdout) => {
      resolve({ stdout: String(stdout ?? "").trim(), err: err ? err.message : null });
    });
  });
  if (out.err) return { ok: false, error: "cli_not_runnable", message: L(lang, `无法运行 ${path}：${out.err}`, `Cannot run ${path}: ${out.err}`) };
  if (!VERSION_PATTERN[which].test(out.stdout)) {
    return { ok: false, error: "not_a_cli", message: L(lang, `${path} 不是 ${which === "claude" ? "Claude Code" : "Codex"} 命令行（--version 输出：${out.stdout.slice(0, 80) || "空"}）`, `${path} is not the ${which === "claude" ? "Claude Code" : "Codex"} CLI (--version output: ${out.stdout.slice(0, 80) || "empty"})`) };
  }
  return { ok: true, version: out.stdout };
}
