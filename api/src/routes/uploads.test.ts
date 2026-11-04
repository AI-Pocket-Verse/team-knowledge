import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { disconnectDb } from "../db.js";
import { resetDb, seedAdmin, mockAuth, authCookie } from "../../test-helpers/db.js";

const { fetchImpl } = mockAuth();
const AUTH = { auth: { whoamiUrl: "http://test.invalid/whoami", fetchImpl } } as const;

describe("GET /uploads/:filename", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("returns 401 when unauthenticated", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "GET", url: "/uploads/some-id.png" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 404 for path traversal attempts even when authenticated", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "GET",
      url: "/uploads/..%2F..%2Fetc%2Fpasswd",
      headers: { cookie },
    });
    // Must not be 200; path traversal must be rejected
    expect(res.statusCode).not.toBe(200);
    await app.close();
  });

  it("returns 404 for filenames with disallowed patterns", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const res = await app.inject({
      method: "GET",
      url: "/uploads/../../etc/passwd",
      headers: { cookie },
    });
    expect(res.statusCode).not.toBe(200);
    await app.close();
  });
});

// Tiny 1x1 PNG (real PNG bytes)
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

describe("POST /api/uploads/image", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("uploads a PNG and returns a /uploads/<id>.png URL", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const boundary = "----TestBoundary";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="test.png"\r\n`),
      Buffer.from(`Content-Type: image/png\r\n\r\n`),
      PNG_BYTES,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads/image",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.url).toMatch(/^\/uploads\/[a-z0-9]+\.png$/);
    expect(json.bytes).toBe(PNG_BYTES.length);
    await app.close();
  });

  it("415 for unsupported mime types", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const boundary = "----B";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="x.txt"\r\n`),
      Buffer.from(`Content-Type: text/plain\r\n\r\n`),
      Buffer.from("hello"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST", url: "/api/uploads/image",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it("415 when mime header lies (text bytes claiming to be PNG)", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const boundary = "----B";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="fake.png"\r\n`),
      Buffer.from(`Content-Type: image/png\r\n\r\n`),
      Buffer.from("not actually a png"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST", url: "/api/uploads/image",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it("401 when unauthenticated", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "POST", url: "/api/uploads/image" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

// Helper for the generic file endpoint — same multipart wire format as
// the image tests above but with a configurable filename + mime.
function buildFileUpload(filename: string, mime: string, content: Buffer): { boundary: string; body: Buffer } {
  const boundary = "----TM-file-test";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
    Buffer.from(`Content-Type: ${mime}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { boundary, body };
}

describe("POST /api/uploads/file", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  it("uploads a PDF and returns url/originalName/bytes/mimeType", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const content = Buffer.from("%PDF-1.4\n%fake pdf body", "utf8");
    const { boundary, body } = buildFileUpload("年度报告.pdf", "application/pdf", content);
    const res = await app.inject({
      method: "POST", url: "/api/uploads/file",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.url).toMatch(/^\/uploads\/[a-z0-9]+\.pdf$/);
    expect(json.originalName).toBe("年度报告.pdf");
    expect(json.mimeType).toBe("application/pdf");
    expect(json.bytes).toBe(content.length);
    await app.close();
  });

  it("415 for blocked executable extensions", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    const { boundary, body } = buildFileUpload("evil.exe", "application/octet-stream", Buffer.from("MZ"));
    const res = await app.inject({
      method: "POST", url: "/api/uploads/file",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it("401 when unauthenticated", async () => {
    const app = await buildServer(AUTH);
    const res = await app.inject({ method: "POST", url: "/api/uploads/file" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("上传文件的 Content-Type 由服务端决定", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await disconnectDb(); });

  async function upload(app: Awaited<ReturnType<typeof buildServer>>, cookie: string, name: string, content: Buffer) {
    const { boundary, body } = buildFileUpload(name, "application/octet-stream", content);
    return app.inject({
      method: "POST", url: "/api/uploads/file",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
  }

  it("能被浏览器当网页或脚本执行的扩展名拒收", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");
    for (const name of ["a.shtml", "a.xht", "a.svgz", "a.ecma", "a.es", "a.cjs", "a.mhtml", "a.xsl", "a.hta", "a.wasm"]) {
      const res = await upload(app, cookie, name, Buffer.concat([PNG_BYTES, Buffer.from("<script>1</script>")]));
      expect(res.statusCode, name).toBe(415);
    }
    await app.close();
  });

  it("内联预览用按字节检测出的类型，其他文件一律 octet-stream 下载", async () => {
    await seedAdmin();
    const app = await buildServer(AUTH);
    const cookie = authCookie("admin");

    const pdf = (await upload(app, cookie, "report.pdf", Buffer.from("%PDF-1.4\n%fake pdf body"))).json();
    const pdfRes = await app.inject({ method: "GET", url: pdf.url, headers: { cookie } });
    expect(pdfRes.statusCode).toBe(200);
    expect(pdfRes.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(pdfRes.headers["content-disposition"]).toBeUndefined();

    // 扩展名对应的类型(.ps → application/postscript)不能被直接拿来当 Content-Type。
    const bin = (await upload(app, cookie, "data.ps", Buffer.from("%!PS fake"))).json();
    const binRes = await app.inject({ method: "GET", url: bin.url, headers: { cookie } });
    expect(binRes.statusCode).toBe(200);
    expect(binRes.headers["content-type"]).toMatch(/^application\/octet-stream/);
    expect(binRes.headers["content-disposition"]).toMatch(/^attachment/);

    // 图片魔数 + 名字伪装：内联时 Content-Type 仍是检测出的 image/png。
    const png = (await upload(app, cookie, "photo.jpeg", Buffer.concat([PNG_BYTES, Buffer.from("<script>1</script>")]))).json();
    const pngRes = await app.inject({ method: "GET", url: png.url, headers: { cookie } });
    expect(pngRes.headers["content-type"]).toMatch(/^image\/png/);
    expect(pngRes.headers["x-content-type-options"]).toBe("nosniff");
    await app.close();
  });
});
