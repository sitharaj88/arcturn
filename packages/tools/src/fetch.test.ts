import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFetchTool, stripHtml } from "./fetch.js";
import { createFakeContext, denyAllPermissions } from "./test-utils.js";

describe("stripHtml", () => {
  it("strips tags, scripts, and styles and decodes entities", () => {
    const html = `<html><head><style>body{color:red}</style></head><body>
      <script>alert(1)</script>
      <h1>Title</h1>
      <p>Hello &amp; welcome</p>
    </body></html>`;
    const text = stripHtml(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello & welcome");
    expect(text).not.toContain("<h1>");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("color:red");
  });
});

describe("fetch tool", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body><p>Hello <b>World</b></p></body></html>");
      } else if (req.url === "/text") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("plain text body");
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(1000));
      } else if (req.url === "/notfound") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      } else {
        res.writeHead(200);
        res.end("ok");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetches plain text", async () => {
    const tool = createFetchTool();
    const { ctx } = createFakeContext({ cwd: "/" });

    const result = await tool.execute({ url: `${baseUrl}/text` }, ctx);
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("plain text body");
  });

  it("strips HTML tags from text/html responses", async () => {
    const tool = createFetchTool();
    const { ctx } = createFakeContext({ cwd: "/" });

    const result = await tool.execute({ url: `${baseUrl}/html` }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text).not.toContain("<p>");
  });

  it("truncates the response to maxBytes", async () => {
    const tool = createFetchTool();
    const { ctx } = createFakeContext({ cwd: "/" });

    const result = await tool.execute({ url: `${baseUrl}/big`, maxBytes: 100 }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("[Truncated");
    expect(result.details).toMatchObject({ truncated: true });
  });

  it("marks non-2xx responses as errors", async () => {
    const tool = createFetchTool();
    const { ctx } = createFakeContext({ cwd: "/" });

    const result = await tool.execute({ url: `${baseUrl}/notfound` }, ctx);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ status: 404 });
  });

  it("requests permission with the URL origin as subject", async () => {
    const tool = createFetchTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd: "/" });

    await tool.execute({ url: `${baseUrl}/text` }, ctx);

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].subject).toBe(baseUrl);
  });

  it("does not fetch when permission is denied", async () => {
    const tool = createFetchTool();
    const { ctx } = createFakeContext({
      cwd: "/",
      onPermissionRequest: denyAllPermissions("blocked"),
    });

    const result = await tool.execute({ url: `${baseUrl}/text` }, ctx);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("blocked");
  });

  it("rejects unsupported URL schemes", async () => {
    const tool = createFetchTool();
    const { ctx } = createFakeContext({ cwd: "/" });

    const result = await tool.execute({ url: "ftp://example.com/file" }, ctx);
    expect(result.isError).toBe(true);
  });
});
