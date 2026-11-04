import { describe, it, expect } from "vitest";
import { extractInternalReferences } from "./extractInternalReferences.js";

describe("extractInternalReferences", () => {
  it("returns empty set for content with no internal links", () => {
    const md = "# Hello\n\nJust some text and an [external](https://example.com) link.";
    expect([...extractInternalReferences(md)]).toEqual([]);
  });

  it("extracts the current `/d/<id>` form", () => {
    const md = "See [the doc](/d/aaa111).";
    expect([...extractInternalReferences(md)]).toEqual(["aaa111"]);
  });

  it("extracts the historic standalone `/a/<id>` form", () => {
    const md = "See [the doc](/a/bbb222).";
    expect([...extractInternalReferences(md)]).toEqual(["bbb222"]);
  });

  it("extracts the legacy `/r/<role>/m/<folder>/a/<id>` form", () => {
    const md = "See [the requirements](/r/role1/m/mod1/a/aaa111).";
    expect([...extractInternalReferences(md)]).toEqual(["aaa111"]);
  });

  it("extracts all three formats together and dedupes", () => {
    const md = `
First [a](/d/x).
Second [b](/a/y).
Third [c](/r/r3/m/m3/a/x).
Fourth [d](/d/z).
`;
    const ids = [...extractInternalReferences(md)].sort();
    expect(ids).toEqual(["x", "y", "z"]);
  });

  it("extracts multiple references and dedupes", () => {
    const md = `
First [a](/r/r1/m/m1/a/x).
Second [b](/r/r2/m/m2/a/y).
Third [c](/r/r3/m/m3/a/x).
`;
    const ids = [...extractInternalReferences(md)].sort();
    expect(ids).toEqual(["x", "y"]);
  });

  it("ignores non-article URLs", () => {
    const md = "[role page](/r/r1) and [folder](/r/r1/m/m1) shouldn't match.";
    expect([...extractInternalReferences(md)]).toEqual([]);
  });

  it("does not false-match an `/a/` or `/d/` glued to a longer path segment", () => {
    // `/xa/abc` and `/xd/def` must NOT match — the `a`/`d` is mid-segment.
    const md = "[a](/foo/xa/abc) and [b](/bar/xd/def) and [c](/za/ghi)";
    expect([...extractInternalReferences(md)]).toEqual([]);
  });

  it("filters out a self-reference id when given", () => {
    const md = "Self [a](/d/SELF) and other [b](/d/OTHER).";
    expect([...extractInternalReferences(md, "SELF")]).toEqual(["OTHER"]);
  });

  it("works with cuid-style ids (alphanumeric)", () => {
    const md = "[x](/d/clm5x9k2x000008jp7y9q3z4f)";
    expect([...extractInternalReferences(md)]).toEqual(["clm5x9k2x000008jp7y9q3z4f"]);
  });
});
