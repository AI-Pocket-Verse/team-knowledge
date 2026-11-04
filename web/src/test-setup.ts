import "@testing-library/jest-dom/vitest";
import { setCurrentLang } from "./i18n/lang";

// 单测按中文界面断言(与加语言切换之前一致)：jsdom 的系统语言是 en-US，这里固定成中文。
Object.defineProperty(window.navigator, "languages", { value: ["zh-CN"], configurable: true });
Object.defineProperty(window.navigator, "language", { value: "zh-CN", configurable: true });
setCurrentLang("zh");

// jsdom has no ResizeObserver; recharts' ResponsiveContainer constructs one on
// mount. Shim it so chart components can render in tests (the SVG itself won't
// size in jsdom — tests assert on titles / legend / empty-state rendered
// outside the chart, not on chart geometry).
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
