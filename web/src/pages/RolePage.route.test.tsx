import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";

vi.mock("@/lib/api", async (o) => {
  const actual = await o<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      workspace: { listRoles: vi.fn(), tree: vi.fn() },
    },
  };
});
vi.mock("@/components/role-skill/RoleSkillPanel", () => ({ RoleSkillDialogButton: () => null }));
import { api } from "@/lib/api";
import { RolePage } from "./RolePage";

let go: (to: string) => void = () => {};
function Nav() {
  const nav = useNavigate();
  go = (to) => nav(to);
  return null;
}

beforeEach(() => { vi.clearAllMocks(); });

describe("RolePage 切换路由参数", () => {
  it("先出错再切到合法角色,显示该角色而不是停在错误页", async () => {
    (api.workspace.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue({
      roles: [{ id: "good", name: "好角色", description: "角色描述", ownership: "owned" }],
    });
    (api.workspace.tree as ReturnType<typeof vi.fn>).mockResolvedValue({ folders: [], directArticles: [] });
    render(
      <MemoryRouter initialEntries={["/r/missing"]}>
        <Nav />
        <Routes><Route path="/r/:roleId" element={<RolePage />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("该角色不存在或无权访问。")).toBeTruthy();
    act(() => go("/r/good"));
    expect(await screen.findByText("角色描述")).toBeTruthy();
    expect(screen.queryByText("该角色不存在或无权访问。")).toBeNull();
  });
});
