import { describe, it, expect } from "vitest";
import { parseMentions, mentionsToPlain } from "./mentions.js";
import { excerptOf } from "./service.js";

describe("parseMentions", () => {
  it("extracts unique userIds from [@name](/u/id) markers", () => {
    expect(parseMentions("hi [@张三](/u/u1) and [@李四](/u/u2)")).toEqual(["u1", "u2"]);
  });
  it("dedupes repeated mentions of the same user", () => {
    expect(parseMentions("[@a](/u/u1) [@a again](/u/u1)")).toEqual(["u1"]);
  });
  it("ignores doc links and plain @text", () => {
    expect(parseMentions("see [doc](/d/a1) and @notlinked")).toEqual([]);
  });
  it("handles display names with escaped []() and keeps text after the marker", () => {
    expect(parseMentions("[@Li \\[Ops\\] \\(x\\)](/u/u1) then [@b](/u/u2)")).toEqual(["u1", "u2"]);
  });
  it("returns [] for an empty body", () => {
    expect(parseMentions("")).toEqual([]);
  });
});

describe("mention display names with escaped chars in excerpts", () => {
  it("mentionsToPlain / excerptOf restore the whole marker to @name", () => {
    const body = "hi [@Li \\[Ops\\] \\(x\\)](/u/u1) ok";
    expect(mentionsToPlain(body)).toBe("hi @Li [Ops] (x) ok");
    expect(excerptOf(body)).toBe("hi @Li [Ops] (x) ok");
  });
});
