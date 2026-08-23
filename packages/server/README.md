# `@arcturn/server`

WebSocket server exposing [Arcturn](https://arcturn.dev) agent sessions. The same
`Agent` that runs in the CLI or embedded via `@arcturn/core` can run behind this server
and be driven remotely — a web UI, a mobile app, a teammate's editor — over the typed
protocol defined by `@arcturn/protocol`. The CLI wires this together as `arcturn serve`.

## What's in it

`src/index.ts` exports:

- `SessionHost`, `SessionHostOptions`, `SessionHostError`, `SessionHostErrorCode`,
  `AgentFactoryOptions` — manages live agent sessions independent of transport.
- `ArcturnServer`, `ArcturnServerOptions`, `ArcturnServerStartOptions` — a WebSocket
  server that exposes a `SessionHost` over JSON text frames validated against
  `@arcturn/protocol`'s wire contracts.
- `isAuthenticateFrame`, `tokensMatch`, `AuthenticateFrame` — shared-token
  authentication for the first frame of a connection.

## Install

Arcturn is not yet published to npm. Until it is, use it from a clone of the monorepo as
a pnpm workspace package:

```bash
git clone https://github.com/sitharaj88/arcturn.git && cd arcturn
pnpm install && pnpm -r build
```

Then depend on it from another workspace package: `"@arcturn/server": "workspace:*"`.

## Usage

```ts
import { ArcturnServer } from "@arcturn/server";
import type { SessionHost } from "@arcturn/server";

declare const sessionHost: SessionHost; // built from your own AgentFactoryOptions

const server = new ArcturnServer({
  sessionHost,
  token: "a-shared-secret", // omit only for an explicitly unauthenticated loopback server
});

const port = await server.start({ host: "127.0.0.1", port: 0 });
console.log(`listening on ws://127.0.0.1:${port}`);
```

Read this before binding anything other than loopback: a connection that completes
authentication (or, when no token is configured, *any* connection) gets full tool
execution as the process running the server. Binding a non-loopback interface with no
token is a hard refusal at construction time.

## Docs

- [Server mode](https://arcturn.dev/docs/server-mode) — flags, the wire protocol,
  authentication, and the full threat model behind `arcturn serve`.
- [Embedding with the SDK](https://arcturn.dev/docs/sdk) — how this package fits with the
  rest of the runtime.

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
