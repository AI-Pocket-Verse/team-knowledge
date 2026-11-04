import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// 包一层真实的 spawn:默认照常起子进程,用于检查传参与 kill;failNext 时模拟文件句柄耗尽(EMFILE)
// ——Node 此时返回 stdio 为空的子进程对象,随后异步触发 error。
const ctl = vi.hoisted(() => ({ failNext: false, children: [] as ChildProcess[], calls: [] as unknown[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (...args: unknown[]) => {
      ctl.calls.push(args);
      if (ctl.failNext) {
        ctl.failNext = false;
        const fake = new EventEmitter() as unknown as ChildProcess;
        Object.assign(fake, { stdout: null, stdin: null, stderr: null, kill: () => true });
        setImmediate(() => (fake as unknown as EventEmitter).emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" })));
        return fake;
      }
      const child = (real.spawn as (...a: unknown[]) => ChildProcess)(...args);
      vi.spyOn(child, "kill");
      ctl.children.push(child);
      return child;
    },
  };
});

import { renderSvgToPngInChild, RenderTimeoutError } from "./resvg.js";
import { buildChatShareSvg } from "../chat-share-image/svg.js";

const svgOf = (n: number) => buildChatShareSvg([{ role: "user", content: "啊".repeat(n) }]);

describe("renderSvgToPngInChild 子进程管理", () => {
  beforeEach(() => { ctl.failNext = false; ctl.children.length = 0; ctl.calls.length = 0; });

  it("spawn 失败(EMFILE):返回错误、不抛出到外层,onExit 只调用一次", async () => {
    ctl.failNext = true;
    const onExit = vi.fn();
    await expect(renderSvgToPngInChild(svgOf(5), { scales: [1], timeoutMs: 60_000, onExit })).rejects.toThrow(/EMFILE/);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("子进程只继承 PATH,不带 API 的其他环境变量", async () => {
    await renderSvgToPngInChild(svgOf(5), { scales: [1], timeoutMs: 60_000 });
    const opts = ctl.calls[0]![2] as { env: Record<string, string> };
    expect(Object.keys(opts.env)).toEqual(["PATH"]);
  }, 60_000);

  it("超时时用 SIGKILL 结束子进程", async () => {
    await expect(renderSvgToPngInChild(svgOf(3000), { scales: [2], timeoutMs: 300 })).rejects.toBeInstanceOf(RenderTimeoutError);
    expect(ctl.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  }, 60_000);
});
