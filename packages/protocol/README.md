# `@arcturn/protocol`

NDJSON wire-protocol framing and validation for [Arcturn](https://arcturn.dev) server
mode. This is the typed contract shared by `@arcturn/server` (the host) and any remote
client — a web UI, a mobile app, or another process driving an `arcturn serve` instance.

## What's in it

`src/index.ts` exports:

- `PROTOCOL_VERSION` — re-exported from `@arcturn/types`.
- `createProtocolClient`, `ProtocolClient`, `ProtocolClientOptions` — a client over any
  `WebSocketLike` transport, plus its error types (`ProtocolClientError`,
  `ProtocolClosedError`, `ProtocolRequestError`, `ProtocolTimeoutError`,
  `ProtocolVersionMismatchError`) and `ClientErrorCode`.
- `FrameDecoder`, `encodeFrame`, `isProtocolError`, `DEFAULT_MAX_LINE_LENGTH` — NDJSON
  framing for stream transports (one JSON value per line, LF-delimited).
- `errorResponse`, `okResponse`, `eventMessage`, `sessionsMessage`, `ErrorCode` — server
  response builders.
- `nextRequestId`, `RequestIdGenerator` — request id generation.
- `validateClientRequest`, `validateServerMessage`, `validatePermissionDecision`,
  `validatePermissionRule`, `validateSessionHeader` — runtime validation for every frame
  crossing the wire.

## Install

Arcturn is not yet published to npm. Until it is, use it from a clone of the monorepo as
a pnpm workspace package:

```bash
git clone https://github.com/sitharaj88/arcturn.git && cd arcturn
pnpm install && pnpm -r build
```

Then depend on it from another workspace package: `"@arcturn/protocol": "workspace:*"`.

## Usage

Decoding NDJSON frames as they arrive on a stream transport:

```ts
import { FrameDecoder, isProtocolError } from "@arcturn/protocol";

const decoder = new FrameDecoder();
for (const frame of decoder.feed(chunk)) {
  if (isProtocolError(frame)) {
    console.error(frame.code, frame.message);
    continue;
  }
  // frame is a parsed JSON value — validate it against the expected message shape
}
```

Encoding an outgoing frame: `encodeFrame({ id: "1", method: "listSessions", params: {} })`.
`@arcturn/server`'s `ArcturnServer` speaks a one-frame-per-WebSocket-text-message variant
of this contract; see its docs for the full server-side wiring.

## Docs

- [Server mode](https://arcturn.dev/docs/server-mode) — wire protocol, authentication, threat model.
- [Embedding with the SDK](https://arcturn.dev/docs/sdk) — how this fits with the rest of the runtime.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

---

## 👤 Author

**Sitharaj Seenivasan**

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](LICENSE). © 2026 Sitharaj Seenivasan.
