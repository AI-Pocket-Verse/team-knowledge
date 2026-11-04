import { describe, it, expect } from "vitest";
import { parseGithubRepo } from "./githubUrl";

describe("parseGithubRepo", () => {
  it("https 链接", () => {
    expect(parseGithubRepo("https://github.com/example-org/example-repo")).toEqual({ owner: "example-org", repo: "example-repo" });
  });
  it("带 .git / 末尾斜杠", () => {
    expect(parseGithubRepo("https://github.com/o/r.git")).toEqual({ owner: "o", repo: "r" });
    expect(parseGithubRepo("https://github.com/o/r/")).toEqual({ owner: "o", repo: "r" });
  });
  it("带子路径 /tree/main", () => {
    expect(parseGithubRepo("https://github.com/o/r/tree/main/src")).toEqual({ owner: "o", repo: "r" });
  });
  it("SSH scp 形式", () => {
    expect(parseGithubRepo("git@github.com:example-org/example-repo.git")).toEqual({ owner: "example-org", repo: "example-repo" });
  });
  it("裸 owner/repo", () => {
    expect(parseGithubRepo("example-org/example-repo")).toEqual({ owner: "example-org", repo: "example-repo" });
  });
  it("两侧空白容忍", () => {
    expect(parseGithubRepo("  https://github.com/o/r  ")).toEqual({ owner: "o", repo: "r" });
  });
  it("非法输入 → null", () => {
    expect(parseGithubRepo("")).toBeNull();
    expect(parseGithubRepo("not a url")).toBeNull();
    expect(parseGithubRepo("https://gitlab.com/o/r")).toBeNull();
  });
});
