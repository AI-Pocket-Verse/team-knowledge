import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// 真实调用 README 里的命令入口：脚本 import 的是 .ts 源码，必须带 tsx 加载器。
function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/cleanup-uploads.mjs", ...args], {
    cwd: process.cwd(),
    env: { ...process.env },
    encoding: "utf8",
  });
}

describe("cleanup-uploads 脚本", () => {
  it("package.json 的命令带 tsx 加载器", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["cleanup-uploads"]).toContain("--import tsx");
    expect(pkg.scripts["cleanup-uploads:prod"]).toContain("--import tsx");
  });

  it("--dry-run 能跑通并退出 0", () => {
    const r = run("--dry-run");
    expect(r.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[dry-run\]/);
  });

  it("天数参数非法时给出明确提示并退出 2", () => {
    const r = run("--older-than-days=abc");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/older-than-days/);
  });
});
