#!/usr/bin/env node
/**
 * A minimal fake language server for tests.
 *
 * Speaks real LSP `Content-Length` framing over stdio (no dependencies, no
 * TypeScript — plain Node so it can be spawned with `process.execPath`
 * directly, exactly like a real server binary would be).
 *
 * Behaviour:
 *  - `initialize` -> responds with a minimal `InitializeResult`.
 *  - `initialized` -> no reply (it is a notification).
 *  - `textDocument/didOpen` / `textDocument/didChange` -> publishes one
 *    canned diagnostic for that document's `uri`, tagged with the document
 *    version it was told about (so a test can tell which edit it answers).
 *    If the document text contains the marker string `NO_DIAGNOSTICS`, it
 *    publishes an empty diagnostics array instead, so tests can exercise the
 *    "clean file" path too.
 *  - `shutdown` -> responds with a `null` result, unless `--ignore-shutdown`
 *    was passed on argv, in which case it is silently dropped so a test can
 *    exercise the client's kill-after-timeout fallback.
 *  - `exit` -> exits the process, unless `--ignore-exit` was passed on argv,
 *    in which case it is silently dropped so a test can exercise the
 *    client's exit-grace-then-kill fallback.
 *  - `initialize` -> also logs the interesting bits of `InitializeParams`
 *    (`workspaceFolders`, `clientInfo`, and the capability flags the client
 *    is expected to advertise) to stderr as one `[fake-server] initialize
 *    params=<json>` line, so a test can assert on them via `client.stderr`.
 *    If `--configure-items=<n>` is passed, it first issues a
 *    `workspace/configuration` request for `n` items *before* replying to
 *    `initialize`, so `initialize` only completes once the client answers
 *    it correctly (an array of length `n`); the outcome is logged as
 *    `[fake-server] configuration result length=<n>` (or `mismatch:<n>` if
 *    the client answered with the wrong length).
 *
 * Every message received is also echoed as a `[fake-server] ...` line on
 * stderr, which the real client captures instead of inheriting — useful when
 * a test wants to assert something was sent.
 */

const ignoreShutdown = process.argv.includes("--ignore-shutdown");
const ignoreExit = process.argv.includes("--ignore-exit");
const configureItemsArg = process.argv.find((arg) => arg.startsWith("--configure-items="));
const configureItems = configureItemsArg ? Number(configureItemsArg.split("=")[1]) : undefined;

let nextServerRequestId = -1; // negative ids so they never collide with the client's own ids.
let pendingInitializeId; // set while an initialize reply is held back for workspace/configuration.

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) break;
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }
    handle(message);
  }
});

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  process.stdout.write(Buffer.concat([header, body]));
}

function handle(message) {
  const extra =
    message.method === "$/cancelRequest" ? ` params=${JSON.stringify(message.params)}` : "";
  process.stderr.write(
    `[fake-server] received ${message.method ?? `response:${message.id}`}${extra}\n`,
  );

  if (message.method === "initialize") {
    const params = message.params ?? {};
    process.stderr.write(
      `[fake-server] initialize params=${JSON.stringify({
        workspaceFolders: params.workspaceFolders,
        clientInfo: params.clientInfo,
        workspaceFoldersCapability: params.capabilities?.workspace?.workspaceFolders,
        workspaceSymbolCapability: params.capabilities?.workspace?.symbol,
        hierarchicalDocumentSymbolSupport:
          params.capabilities?.textDocument?.documentSymbol?.hierarchicalDocumentSymbolSupport,
        positionEncodings: params.capabilities?.general?.positionEncodings,
      })}\n`,
    );

    if (configureItems !== undefined) {
      pendingInitializeId = message.id;
      const requestId = nextServerRequestId--;
      send({
        jsonrpc: "2.0",
        id: requestId,
        method: "workspace/configuration",
        params: { items: Array.from({ length: configureItems }, () => ({ section: "arcturn" })) },
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: {},
        serverInfo: { name: "fake-lsp-server", version: "0.0.0" },
      },
    });
    return;
  }

  // The client's answer to the `workspace/configuration` request this
  // server issued above (a response, so it has an `id` but no `method`).
  if (message.method === undefined && pendingInitializeId !== undefined && "result" in message) {
    const ok = Array.isArray(message.result) && message.result.length === configureItems;
    process.stderr.write(
      `[fake-server] configuration result ${ok ? `length=${configureItems}` : `mismatch:${JSON.stringify(message.result)}`}\n`,
    );
    send({
      jsonrpc: "2.0",
      id: pendingInitializeId,
      result: {
        capabilities: {},
        serverInfo: { name: "fake-lsp-server", version: "0.0.0" },
      },
    });
    pendingInitializeId = undefined;
    return;
  }

  if (message.method === "initialized") return;

  if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
    const doc = message.params?.textDocument;
    const uri = doc?.uri;
    const text =
      message.method === "textDocument/didOpen"
        ? doc?.text
        : message.params?.contentChanges?.[0]?.text;
    const version = doc?.version;
    if (!uri) return;

    const diagnostics =
      typeof text === "string" && text.includes("NO_DIAGNOSTICS")
        ? []
        : [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
              source: "fake-lsp",
              message: "fake diagnostic",
            },
          ];
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, version, diagnostics },
    });
    return;
  }

  if (message.method === "shutdown") {
    if (!ignoreShutdown) send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (message.method === "exit") {
    if (!ignoreExit) process.exit(0);
    return;
  }
}
