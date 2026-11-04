import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDashboardStream } from "./useDashboardStream";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe("useDashboardStream", () => {
  it("invokes onActivity and onTick parsed from the stream", async () => {
    const body = sseStream([
      'event: hello\ndata: {"at":"now"}\n\n',
      'event: activity\ndata: {"items":[{"id":"e1","userId":"u1","userName":"U","type":"doc_create","title":"T","at":"now"}]}\n\n',
      'event: tick\ndata: {"at":"now"}\n\n',
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    const onActivity = vi.fn();
    const onTick = vi.fn();
    const { unmount } = renderHook(() => useDashboardStream({ onActivity, onTick }));

    await waitFor(() => expect(onActivity).toHaveBeenCalled());
    expect(onActivity).toHaveBeenCalledWith([expect.objectContaining({ id: "e1", title: "T", userName: "U" })]);
    await waitFor(() => expect(onTick).toHaveBeenCalled());
    unmount();
  });

  it("does not reconnect after unmount (abort)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(sseStream(['event: tick\ndata: {}\n\n']), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = renderHook(() => useDashboardStream({ onActivity: vi.fn(), onTick: vi.fn() }));
    unmount();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
