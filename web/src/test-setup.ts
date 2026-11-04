import "@testing-library/jest-dom/vitest";

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
