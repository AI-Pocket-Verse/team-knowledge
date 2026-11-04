import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  // 默认部署在站点根路径。要挂在子路径下（如 /kb/），改这里并同步 nginx；
  // BrowserRouter basename、API 前缀与上传地址都从 BASE_URL 推导。
  base: "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Code-splitting: pull the two heaviest dependency clusters out
        // of the lazy ArticleEdit/Detail chunk into their own vendor chunks.
        // The editor stack (Milkdown / ProseMirror / highlight.js) is only
        // needed on the article editor/detail routes; isolating it keeps the
        // initial entry chunk small and lets the browser cache the editor
        // bundle across article navigations.
        manualChunks(id) {
          if (
            id.includes("node_modules/@milkdown/") ||
            id.includes("node_modules/prosemirror-") ||
            id.includes("node_modules/highlight.js/")
          ) {
            return "editor";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5030,
    proxy: {
      "/api": {
        target: "http://localhost:4030",
        changeOrigin: true,
        // `ws: true` makes the proxy forward WebSocket upgrade
        // requests too — required for the meeting audio stream at
        // /api/meeting/:id/stream. Without this, the upgrade
        // handshake stops at Vite and never reaches Fastify.
        ws: true,
      },
      // `/uploads/<filename>` is the image URL returned by the API's
      // POST /api/uploads/image endpoint. Without this proxy entry the
      // <img> request would hit Vite and 404, so pasted /
      // dropped / picked images would silently fail to render in the
      // editor — even though the upload itself succeeded.
      "/uploads": {
        target: "http://localhost:4030",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
  },
});
