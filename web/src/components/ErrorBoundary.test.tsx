import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

// A render that throws on demand. Toggling `throwNow` to false lets us
// assert the boundary recovers after 重试.
function Boom({ throwNow }: { throwNow: boolean }): JSX.Element {
  if (throwNow) throw new Error("boom");
  return <div>正常内容</div>;
}

describe("ErrorBoundary", () => {
  // React logs the caught error to console.error during the throw; the
  // boundary itself also logs. Silence both so the test output stays clean
  // (we assert on rendered UI, not on the console).
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the friendly fallback when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom throwNow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("页面出错了")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新页面" })).toBeInTheDocument();
  });

  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Boom throwNow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("正常内容")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("recovers after 重试 once the child stops throwing", () => {
    // Wrapper lets the test stop the throw before the boundary retries,
    // mirroring a transient render crash that's gone on the next attempt.
    function Harness(): JSX.Element {
      const [crash, setCrash] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setCrash(false)}>修复</button>
          <ErrorBoundary>
            <Boom throwNow={crash} />
          </ErrorBoundary>
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByText("页面出错了")).toBeInTheDocument();

    // Stop the source of the throw, then hit 重试 to re-render the subtree.
    fireEvent.click(screen.getByRole("button", { name: "修复" }));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByText("正常内容")).toBeInTheDocument();
    expect(screen.queryByText("页面出错了")).not.toBeInTheDocument();
  });
});
