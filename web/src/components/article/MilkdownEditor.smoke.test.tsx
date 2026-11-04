// Non-mock smoke: render the real MilkdownEditor (no vi.mock) so a
// breaking change in any milkdown package, plugin API, or local CSS
// import is caught at unit-test time. Other test files mock this
// component file-locally, so they remain unaffected.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MilkdownEditor } from "./MilkdownEditor";

// jsdom 没有 IntersectionObserver，Crepe 创建时会用到；补一个空实现让编辑器真正创建出来，
// 否则测试只检查外壳 div，编辑器根本没起来也会通过。
class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

describe("MilkdownEditor (non-mock smoke)", () => {
  beforeAll(() => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("mounts a read-only editor and actually creates the ProseMirror view", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const { container } = render(
      <MilkdownEditor initialMarkdown="hello **world**" readOnly />,
    );
    expect(container.querySelector(".tm-editor")).toBeTruthy();
    await waitFor(() => expect(container.querySelector(".ProseMirror")).toBeTruthy(), { timeout: 4000 });
  });

  it("mounts a writable editor and creates the ProseMirror view", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const { container } = render(
      <MilkdownEditor initialMarkdown="" onChange={() => {}} />,
    );
    await waitFor(() => expect(container.querySelector(".ProseMirror")).toBeTruthy(), { timeout: 4000 });
  });
});
