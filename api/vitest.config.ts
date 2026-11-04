import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./test-helpers/setup-env.ts"],
    // Runs once before the suite and returns a teardown that wipes the
    // ./data-test file artifacts (uploads / meeting-recordings / meeting-tts)
    // once at the very end, so file-side state can't accumulate across runs.
    globalSetup: ["./test-helpers/global-teardown.ts"],
    fileParallelism: false,
    // GitHub Actions 的 2 核机器上 api 与 web 测试同时跑，偶发单个用例超过默认 5 秒
    // (曾在 bookmarks.test.ts 的普通增删用例上出现)。CI 上放宽，本地保持默认，慢用例仍能在本地暴露。
    testTimeout: process.env.CI ? 20_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
  },
});
