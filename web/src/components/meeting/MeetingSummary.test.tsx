import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { MeetingSessionRow } from "@team-knowledge/shared";
import { VisibilityControl } from "./MeetingSummary";

vi.mock("@/lib/api", () => ({
  api: { meeting: { update: vi.fn() } },
  ApiError: class ApiError extends Error { constructor(m: string, public status: number) { super(m); } },
  API_BASE: "/api",
}));
vi.mock("@/components/Toaster", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const session = (visibility: "public" | "private") =>
  ({ id: "m1", visibility } as unknown as MeetingSessionRow);

describe("VisibilityControl", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("non-editor sees a static scope label and no toggle buttons", () => {
    render(<VisibilityControl session={session("private")} canEdit={false} onChanged={() => {}} />);
    expect(screen.getByText(/私密/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("editor flips to private via PATCH and triggers a refresh", async () => {
    const { api } = await import("@/lib/api");
    (api.meeting.update as ReturnType<typeof vi.fn>).mockResolvedValue({ session: {} });
    const onChanged = vi.fn();
    render(<VisibilityControl session={session("public")} canEdit onChanged={onChanged} />);
    fireEvent.click(screen.getByText("🔒 私密"));
    await waitFor(() => expect(api.meeting.update).toHaveBeenCalledWith("m1", { visibility: "private" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
