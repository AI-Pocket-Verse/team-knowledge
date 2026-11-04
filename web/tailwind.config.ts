import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

// Light & minimal — Notion-white surface, Feishu-blue brand,
// monochrome blue ramp for "you are here" highlights.
//
// Brand history:
//   - First: near-black #111827 primary (default-Tailwind admin look).
//   - Then: indigo #4338ca/#6366f1 + macaron-mint hover (two-hue clash —
//     cool indigo brand fighting the mint accent on the left rail).
//   - Now (Feishu blue):
//       primary    = #3370ff  (logo / CTAs, Feishu brand blue)
//       primary-hover via Tailwind:hover variants → blue-600 #2563eb
//       accent     = blue-400 #60a5fa  (links / focus / brand-secondary)
//       accent.soft = blue-100 #dbeafe (active surfaces, focus rings)
//     The left rail's 3-tier highlight (hover / active-role / active-module)
//     uses the blue 50/100/200 ramp directly — see WorkspaceLeftRail.tsx.
//     Per-role identity chips still come from roleColors.ts (gradient pairs).
export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    // Shared <UserMenu> ships its own Tailwind classes; include the package
    // so they're generated here too (same as apps/media-compress).
    "../../../packages/auth-client-web/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 飞书云文档配色:纯白主面 + 浅灰侧栏 + 飞书蓝。文本/边框取飞书原值。
        bg: "#ffffff",
        surface: "#f7f8fa",   // 侧栏 / 次级面(飞书浅灰)
        fg: "#1f2329",        // 主文本(飞书)
        muted: "#646a73",     // 次级文本(飞书)
        line: "#dee0e3",      // 分隔线 / 边框(飞书)
        primary: {
          DEFAULT: "#3370ff",
          fg: "#ffffff",
        },
        accent: {
          DEFAULT: "#3370ff",  // 链接 / 焦点同主蓝(飞书不另设浅蓝品牌副色)
          soft: "#eff4ff",     // 选中态浅蓝底(飞书 active wash)
        },
      },
      fontFamily: {
        // 与飞书云文档一致的字体栈:系统/拉丁字体在前(英文、数字走 -apple-system /
        // Helvetica),中文走 PingFang SC,末尾接 emoji 字体(表格里的 ✅❌⭐ 走彩色 emoji)。
        // 飞书原栈最前是 LarkHackSafariFont/LarkEmojiFont/LarkChineseQuote(其内部 webfont,
        // 我们没有 → 直接落到 -apple-system,Mac 上视觉等价),故省略不列。
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Helvetica Neue",
          "Tahoma",
          "PingFang SC",
          "Microsoft Yahei",
          "Arial",
          "Hiragino Sans GB",
          "sans-serif",
          "Apple Color Emoji",
          "Segoe UI Emoji",
          "Segoe UI Symbol",
          "Noto Color Emoji",
        ],
        // 落地页「Hi助手」品牌标题用的展示字体:本机装有 Space Grotesk 时使用,
        // 否则回退到系统栈(不从外部加载字体);其余 UI 仍走 sans。
        brand: [
          '"Space Grotesk"',
          "-apple-system",
          "BlinkMacSystemFont",
          "PingFang SC",
          "sans-serif",
        ],
      },
      backdropBlur: {
        xs: "2px",
      },
      boxShadow: {
        // 飞书阴影:更柔、更扩散的浮层投影(深色基于 #1f2329)。
        glass: "0 1px 2px rgba(31, 35, 41, 0.06)",
        glassLg: "0 6px 24px rgba(31, 35, 41, 0.12), 0 2px 6px rgba(31, 35, 41, 0.06)",
        pop: "0 12px 40px rgba(31, 35, 41, 0.16), 0 4px 12px rgba(31, 35, 41, 0.08)",
      },
      keyframes: {
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideInRight: {
          "0%": { transform: "translateX(100%)" },
          "100%": { transform: "translateX(0)" },
        },
        popIn: {
          "0%": { opacity: "0", transform: "translateY(8px) scale(0.98)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        "fade-up": "fadeUp 0.35s ease-out",
        "slide-in-right": "slideInRight 0.28s cubic-bezier(0.4, 0, 0.2, 1)",
        "pop-in": "popIn 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
