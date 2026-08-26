import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

/**
 * `fetch` asks permission for an *origin* and then follows redirects. Both
 * halves of that sentence are fine on their own; together they mean the origin
 * that was approved and the origin that was contacted need not be the same
 * one. Every assertion here is on what the stub servers actually observed, not
 * on what the call returned.
 */
describe("fetch tool — the origin approved is the origin contacted", () => {
  let redirector: Server;
  let elsewhere: Server;
  let redirectorUrl: string;
  let elsewhereUrl: string;
  let elsewhereHits: string[] = [];
  let redirectTarget = "";

  beforeAll(async () => {
    elsewhere = createServer((req, res) => {
      elsewhereHits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("INTERNAL SERVICE PAYLOAD");
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
    elsewhereUrl = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`;

    redirector = createServer((_req, res) => {
      res.writeHead(302, { location: redirectTarget });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    redirectorUrl = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => redirector.close(() => resolve()));
    await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
  });

  beforeEach(() => {
    elsewhereHits = [];
    redirectTarget = `${elsewhereUrl}/internal`;
  });

  it("asks again before following a redirect to a different origin", async () => {
    const tool = createFetchTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd: "/" });

    await tool.execute({ url: `${redirectorUrl}/go` }, ctx);

    // Whatever the tool decided to do, the user must have been asked about
    // every origin it actually talked to.
    expect(permissionRequests.map((request) => request.subject)).toContain(elsewhereUrl);
  });

  it("does not contact the redirect target when that origin is denied", async () => {
    const tool = createFetchTool();
    const { ctx } = createFakeContext({
      cwd: "/",
      // Approve the origin the model named; refuse everything else.
      onPermissionRequest: (request) =>
        request.subject === redirectorUrl
          ? { requestId: "test", behavior: "allow" }
          : { requestId: "test", behavior: "deny", message: "origin not allowed" },
    });

    const result = await tool.execute({ url: `${redirectorUrl}/go` }, ctx);

    expect(result.isError).toBe(true);
    // The ground truth: the other server never saw a request at all.
    expect(elsewhereHits).toEqual([]);
    expect((result.content[0] as { text: string }).text).not.toContain("INTERNAL SERVICE PAYLOAD");
  });

  it("reports the URL it ended up at, not only the one it was given", async () => {
    const tool = createFetchTool();
    const { ctx } = createFakeContext({ cwd: "/" });

    const result = await tool.execute({ url: `${redirectorUrl}/go` }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({ url: `${elsewhereUrl}/internal` });
    expect(elsewhereHits).toEqual(["/internal"]);
  });

  it("follows a same-origin redirect without asking twice", async () => {
    redirectTarget = `${elsewhereUrl}/second`;
    const tool = createFetchTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd: "/" });

    // Start at `elsewhere`, which redirects within itself.
    const sameOrigin = createServer((req, res) => {
      if (req.url === "/first") {
        res.writeHead(302, { location: "/second" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("arrived");
    });
    await new Promise<void>((resolve) => sameOrigin.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(sameOrigin.address() as AddressInfo).port}`;
    try {
      const result = await tool.execute({ url: `${base}/first` }, ctx);
      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { text: string }).text).toContain("arrived");
      expect(permissionRequests).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => sameOrigin.close(() => resolve()));
    }
  });

  it("refuses a redirect to a non-http scheme", async () => {
    redirectTarget = "file:///etc/passwd";
    const tool = createFetchTool();
    const { ctx } = createFakeContext({ cwd: "/" });

    const result = await tool.execute({ url: `${redirectorUrl}/go` }, ctx);
    expect(result.isError).toBe(true);
  });

  it("stops a redirect loop instead of spinning", async () => {
    redirectTarget = `${redirectorUrl}/go`;
    const tool = createFetchTool();
    const { ctx } = createFakeContext({ cwd: "/" });

    const result = await tool.execute({ url: `${redirectorUrl}/go` }, ctx);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text.toLowerCase()).toContain("redirect");
  });
});

describe("fetch tool — maxBytes bounds what is downloaded", () => {
  it("stops reading the body instead of buffering the whole response first", async () => {
    // The parameter is documented as the maximum bytes of the response body to
    // read. The old implementation `await response.arrayBuffer()`-ed the whole
    // thing and then sliced, so asking for 1KB of a 5GB file downloaded 5GB.
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const totalChunks = 256; // 16 MB if the client reads it all
    let chunksWritten = 0;

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      const pump = () => {
        while (chunksWritten < totalChunks && !closed) {
          chunksWritten++;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        if (!closed) res.end();
      };
      pump();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const tool = createFetchTool();
      const { ctx } = createFakeContext({ cwd: "/" });
      const result = await tool.execute({ url: `${base}/stream`, maxBytes: 1024 }, ctx);

      expect(result.details).toMatchObject({ truncated: true });
      const text = (result.content[0] as { text: string }).text;
      expect(text.startsWith("a".repeat(1024))).toBe(true);

      // The effect: the server was not drained. A few chunks of slack for
      // socket buffers, but nowhere near all 16 MB.
      expect(chunksWritten).toBeLessThan(totalChunks / 2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
