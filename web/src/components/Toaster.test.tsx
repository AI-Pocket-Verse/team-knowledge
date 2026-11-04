import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

// The toast store is module-global, so reset modules before each test to
// get a fresh, empty store — otherwise leftover bubbles from a prior test
// would consume cap slots and skew the assertions.
async function freshToaster() {
  vi.resetModules();
  return import("./Toaster");
}

// push must cap the visible stack (drop oldest) and dedupe an
// identical consecutive message so a flapping error can't pile up
// dozens of identical bubbles.
describe("Toaster", () => {
  beforeEach(() => { vi.resetModules(); });

  it("dedupes identical consecutive error messages", async () => {
    const { Toaster, toast } = await freshToaster();
    render(<Toaster />);
    act(() => {
      toast.error("网络异常");
      toast.error("网络异常");
      toast.error("网络异常");
    });
    expect(screen.getAllByText("网络异常")).toHaveLength(1);
  });

  it("caps the visible stack at the max and drops the oldest", async () => {
    const { Toaster, toast } = await freshToaster();
    render(<Toaster />);
    act(() => {
      // 6 distinct info messages; cap is 4, so the first 2 drop off.
      for (let i = 1; i <= 6; i++) toast.info(`m${i}`);
    });
    expect(screen.queryByText("m1")).toBeNull();
    expect(screen.queryByText("m2")).toBeNull();
    expect(screen.getByText("m3")).toBeInTheDocument();
    expect(screen.getByText("m6")).toBeInTheDocument();
  });

  it("does not dedupe a non-consecutive repeat", async () => {
    const { Toaster, toast } = await freshToaster();
    render(<Toaster />);
    act(() => {
      toast.success("已保存");
      toast.info("其它");
      toast.success("已保存");
    });
    expect(screen.getAllByText("已保存")).toHaveLength(2);
  });
});
