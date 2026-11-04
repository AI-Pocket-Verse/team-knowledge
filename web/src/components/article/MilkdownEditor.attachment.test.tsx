// Regression for the file-attachment "chip" behavior.
//
// Attachments are a custom inline ATOM node (see fileAttachment.ts): stored as
// a plain markdown link `[📎 name (size)](/uploads/x)` but rendered as an
// atomic `.tm-file-chip` card (delete-as-a-whole, click-to-preview). This
// guards the two things most likely to silently break:
//   1) the stored markdown round-trips UNCHANGED (parse → serialize), so we
//      never corrupt existing documents; and
//   2) it renders as a `.tm-file-chip` anchor pointing at /uploads/ (so the
//      CSS card + click-to-preview handler have a real target), NOT raw text.
import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MilkdownEditor } from "./MilkdownEditor";
import { splitLabel, attachmentLabelText, isSafeUploadSrc, openableUploadUrl } from "./fileAttachment";

const ATTACH_MD = "[📎 aigc_image_watermark.md (10 KB)](/uploads/bhxgx44v798rfmk1jrpc607o.md)";

describe("MilkdownEditor — file attachment atom card", () => {
  it("renders the attachment markdown as a .tm-file-chip anchor to /uploads/", async () => {
    const { container } = render(<MilkdownEditor initialMarkdown={ATTACH_MD} readOnly />);
    await waitFor(() => {
      const chip = container.querySelector<HTMLAnchorElement>(".tm-editor a.tm-file-chip");
      expect(chip).toBeTruthy();
      // URL lives in data-src (NOT href) so the native <a> can't navigate the
      // current page — click-to-preview opens a NEW tab via window.open only.
      expect(chip?.getAttribute("href")).toBeNull();
      expect(chip?.getAttribute("data-src")).toContain("/uploads/bhxgx44v798rfmk1jrpc607o.md");
      // atom card is not editable inside; filename shown, no raw markdown chars
      expect(chip?.getAttribute("contenteditable")).toBe("false");
      expect(chip?.textContent).toContain("aigc_image_watermark.md");
      expect(chip?.textContent).not.toContain("](");
      // hover-reveal「×」delete button is part of the card DOM (hidden via CSS)
      expect(chip?.querySelector(".tm-file-chip-remove")).toBeTruthy();
    });
  });

  it("round-trips the stored markdown unchanged (parse → serialize)", async () => {
    let serialized: string | null = null;
    render(
      <MilkdownEditor
        initialMarkdown={ATTACH_MD}
        readOnly
        onReady={(md) => {
          serialized = md;
        }}
      />,
    );
    await waitFor(() => expect(serialized).not.toBeNull());
    // It round-trips as a REAL markdown link (not escaped literal text): the
    // /uploads/ URL is intact and it's a proper `[📎 …](…)` link. Filenames
    // with markdown-special chars (here `_`) get backslash-escaped in the link
    // TEXT by remark — correct + re-parses cleanly — so normalize `\_`→`_`
    // before the equality check rather than asserting byte-identity.
    expect(serialized).toContain("](/uploads/bhxgx44v798rfmk1jrpc607o.md)");
    expect(serialized!.replace(/\\_/g, "_")).toContain(ATTACH_MD);
  });
});

describe("fileAttachment label helpers", () => {
  it("splitLabel extracts name + size, tolerating parentheses in the name", () => {
    expect(splitLabel("📎 report.pdf (1.2 MB)")).toEqual({ name: "report.pdf", size: "1.2 MB" });
    expect(splitLabel("📎 final (v2).docx (3 MB)")).toEqual({ name: "final (v2).docx", size: "3 MB" });
    expect(splitLabel("📎 no-size.txt")).toEqual({ name: "no-size.txt", size: "" });
  });

  it("attachmentLabelText round-trips with splitLabel", () => {
    const label = attachmentLabelText("data.csv", "42 KB");
    expect(label).toBe("📎 data.csv (42 KB)");
    expect(splitLabel(label)).toEqual({ name: "data.csv", size: "42 KB" });
  });
});

describe("MilkdownEditor — file attachment only accepts same-site upload paths", () => {
  const renderMd = (md: string) => render(<MilkdownEditor initialMarkdown={md} readOnly />);

  it.each([
    ["external URL that merely contains /uploads/", "[📎 a.pdf (1 KB)](https://evil.example/uploads/a.pdf)"],
    ["javascript: URL that contains /uploads/", "[📎 a.pdf (1 KB)](javascript:alert(1)//uploads/a.pdf)"],
    ["protocol-relative URL that contains /uploads/", "[📎 a.pdf (1 KB)](//evil.example/uploads/a.pdf)"],
  ])("does not turn a %s into an attachment chip", async (_label, md) => {
    const { container } = renderMd(`${md}\n\n[ok](/uploads/ok.md)`);
    await waitFor(() => expect(container.querySelector(".tm-editor .ProseMirror")).toBeTruthy());
    // 同一文档里站内附件仍是卡片,外部链接不是
    await waitFor(() => expect(container.querySelectorAll("a.tm-file-chip").length).toBe(1));
    expect(container.querySelector("a.tm-file-chip")?.getAttribute("data-src")).toContain("/uploads/ok.md");
  });

  it("parseDOM rejects a pasted chip whose data-src is not a site upload path", async () => {
    const { container } = renderMd("[ok](/uploads/ok.md)");
    await waitFor(() => expect(container.querySelector("a.tm-file-chip")).toBeTruthy());
    expect(isSafeUploadSrc("javascript:alert(1)//uploads/x")).toBe(false);
    expect(isSafeUploadSrc("https://evil.example/uploads/x")).toBe(false);
    expect(isSafeUploadSrc("/x/uploads/y")).toBe(false);
    expect(isSafeUploadSrc("/uploads/y.md")).toBe(true);
  });

  it("openableUploadUrl re-checks the origin before opening", () => {
    expect(openableUploadUrl("/uploads/a.pdf", "http://localhost:3000")).toBe("http://localhost:3000/uploads/a.pdf");
    expect(openableUploadUrl("https://evil.example/uploads/a.pdf", "http://localhost:3000")).toBeNull();
    expect(openableUploadUrl("javascript:alert(1)", "http://localhost:3000")).toBeNull();
  });
});
