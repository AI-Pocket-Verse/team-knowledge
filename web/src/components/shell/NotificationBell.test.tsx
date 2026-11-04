import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

const { unreadCount, list, markRead, getPrefs, setPrefs } = vi.hoisted(() => ({
  unreadCount: vi.fn(),
  list: vi.fn(),
  markRead: vi.fn(),
  getPrefs: vi.fn(),
  setPrefs: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: {
    notifications: {
      unreadCount: () => unreadCount(),
      list: () => list(),
      markRead: (...a: unknown[]) => markRead(...a),
      getPrefs: () => getPrefs(),
      setPrefs: (...a: unknown[]) => setPrefs(...a),
    },
  },
}));

import { NotificationBell } from "./NotificationBell";

function setup() {
  return render(
    <MemoryRouter>
      <NotificationBell />
    </MemoryRouter>,
  );
}

describe("NotificationBell", () => {
  beforeEach(() => {
    navigate.mockReset();
    unreadCount.mockReset();
    list.mockReset();
    markRead.mockReset();
    getPrefs.mockReset();
    setPrefs.mockReset();
  });

  it("shows the unread badge, opens the list, and on click navigates + marks read", async () => {
    unreadCount.mockResolvedValue({ count: 2 });
    list.mockResolvedValue({
      notifications: [
        {
          id: "n1", type: "article_comment", articleId: "a1", commentId: "c1",
          readAt: null, createdAt: new Date().toISOString(),
          actorName: "张三", articleTitle: "PRD", excerpt: "看看这里", actorAvatarUrl: null,
        },
      ],
      nextCursor: null,
    });
    markRead.mockResolvedValue({ ok: true, unread: 1 });

    setup();
    expect(await screen.findByText("2")).toBeInTheDocument(); // badge

    fireEvent.click(screen.getByLabelText("通知"));
    const item = await screen.findByText(/PRD/);
    fireEvent.click(item);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/d/a1#comment-c1"));
    expect(markRead).toHaveBeenCalledWith(["n1"]);
  });

  it("renders an empty state when there are no notifications", async () => {
    unreadCount.mockResolvedValue({ count: 0 });
    list.mockResolvedValue({ notifications: [], nextCursor: null });
    setup();
    fireEvent.click(screen.getByLabelText("通知"));
    expect(await screen.findByText("暂无通知")).toBeInTheDocument();
  });

  it("opens settings, loads prefs, and persists a toggle", async () => {
    unreadCount.mockResolvedValue({ count: 0 });
    list.mockResolvedValue({ notifications: [], nextCursor: null });
    getPrefs.mockResolvedValue({ muteLikes: false, muteFavorites: false, muteComments: false, feishuEnabled: true });
    setPrefs.mockResolvedValue({ muteLikes: true, muteFavorites: false, muteComments: false, feishuEnabled: true });

    setup();
    fireEvent.click(screen.getByLabelText("通知")); // open dropdown
    fireEvent.click(screen.getByLabelText("通知设置")); // open prefs panel

    const likeRow = await screen.findByText("点赞");
    const checkbox = likeRow.closest("label")!.querySelector("input")!;
    fireEvent.click(checkbox); // turn "点赞" off → mute

    await waitFor(() => expect(setPrefs).toHaveBeenCalledWith({ muteLikes: true }));
  });
});
