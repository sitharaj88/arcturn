# The `arcturn serve` browser client

A single self-contained HTML page that drives a live `arcturn serve` session from a
phone or another machine. It is the sibling of `arcturn attach`: same wire protocol,
same events, same permission round trip — a different screen.

```
arcturn serve --web
  arcturn serving on ws://127.0.0.1:7717
  attach with: arcturn attach ws://127.0.0.1:7717 --token 9f3c…
  open in a browser: http://127.0.0.1:8788
```

Open that URL, paste the token when the page asks, and you are attached.

## Getting it onto a phone

The page dials the host it was loaded from, so whatever address reaches the page
also reaches the socket:

```bash
# same machine
arcturn serve --web

# from the LAN — the phone opens http://<your-lan-ip>:8788
arcturn serve --web --host 0.0.0.0

# over SSH, which is the option to prefer on any network you do not own
ssh -L 8788:127.0.0.1:8788 -L 7717:127.0.0.1:7717 you@box
arcturn serve --web --port 7717 --web-port 8788   # on the box
```

`arcturn serve` speaks plain `ws://`, never `wss://`. On anything but loopback or a
trusted LAN, tunnel it (SSH, Tailscale, WireGuard) rather than exposing the
port.

## The token

`arcturn serve` generates a token unless you pass `--token`. The page accepts it
three ways:

- **A fragment**: `http://host:8788/#token=<token>`. A fragment is never sent to
  any server and never appears in a request log. The page reads it, stores it in
  `sessionStorage` for that tab only, and immediately rewrites the URL so it is
  not left in the address bar or in a screenshot.
- **A query parameter**: `?token=<token>`, also stripped on arrival. Convenient,
  but it *does* reach the HTTP server's request line, so prefer the fragment.
- **The prompt**: open the page with no token and the server closes the socket
  with `4401`; the page then asks for one in a password field. This is the path
  to use when you are typing it in by hand.

The page never displays, logs or re-renders the token, and the HTTP server never
serves it. If the server rejects it, the page says so and stops retrying — a bad
token retried forever is a lockout, not resilience.

## What it can do

- List sessions, open one, create one.
- Stream a run live: assistant markdown, your own turns, tool calls with their
  subject, coloured diffs for `edit`, output tails for `bash`, sub-agent
  activity, todos as a live checklist, and the working line with elapsed time
  and token count.
- Send a prompt, steer a run already in flight, and stop it.
- **Answer permission prompts** — the `permissionRequest` → `permissionDecision`
  round trip, with Deny / Allow once / Allow always (the last persists the same
  project-scoped rule the TUI would).
- Reconnect on its own: exponential backoff with jitter, an immediate retry when
  the tab becomes visible again (a phone unlocking), and a liveness probe that
  replaces a socket that has silently died. Every reconnect re-opens the session,
  which is what re-subscribes it to the event stream.

## What it cannot do (versus the TUI)

| | TUI / `arcturn attach` | Browser client |
| --- | --- | --- |
| Transcript backfill on attach | no | no — the wire has no history method, so both start from the moment they attach |
| Slash commands (`/rewind`, `/compact`, …) | yes | no — they are local runtime calls, not wire methods |
| Change permission mode | yes | no — the wire has no `setPermissionMode` |
| Plan-mode approval dialog | yes | shown as an ordinary permission ask (`exitPlanMode`); approving is "once" only, as in `arcturn attach` |
| Switch model | yes | not exposed (the wire's `setModel` exists but needs a model catalog the page does not have) |
| Images in tool results | inline where the terminal supports it | shown as `[image/png]` placeholders |
| File @-mentions, completions | yes | no |

## Security

- **The page is not a credential.** It is served unauthenticated because it is
  inert until someone supplies a token, and the WebSocket handshake is what
  actually authenticates. Anyone who can reach the page port gets HTML; anyone
  who can reach the socket port *and* holds the token gets tool execution as the
  user running `arcturn serve` (see `serve.ts`'s threat model).
- **All server text is inserted as text.** The client builds description objects
  and mounts them with `createElement` + `textContent`; there is no `innerHTML`,
  no `insertAdjacentHTML`, no `document.write` and no `eval` anywhere on the
  page. Model output is treated as hostile and cannot become markup. Markdown
  links render as their label plus a plain-text URL — never an anchor — so a
  `javascript:` target can never be clicked.
- **A strict CSP.** `default-src 'none'`, nonce-pinned inline style and scripts,
  no `unsafe-inline`, `frame-ancestors 'none'`, and `connect-src` narrowed to
  WebSocket URLs on the host the page was loaded from. `form-action 'none'`
  stops the token form from ever falling back to a real submission if scripting
  fails, which would put the token in a URL.
- **Origin allowlisting.** Browsers stamp an `Origin` on the WebSocket upgrade
  and `ArcturnServer` refuses origins it was not told about, which is what keeps any
  other web page you have open from driving the server. `--web` allows loopback
  names, the bound address and (for a wildcard bind) this machine's own LAN
  addresses. A tunnel or reverse-proxy hostname cannot be guessed — pass it with
  `--web-origin`.
- **You cannot approve what you cannot see.** If a permission subject is taller
  than the sheet, the Allow buttons stay disabled until it has been scrolled to
  the end. Deny is always available.

## Accessibility and mobile

Semantic landmarks (`header`/`main`/`form`), `role="log"` on the transcript,
`role="dialog"` + `aria-modal` on every sheet, labelled controls, a skip link, a
visible `:focus-visible` ring, and `prefers-reduced-motion` honoured (the
spinner stops animating). Touch targets are at least 44px, safe-area insets are
respected on notched phones, and the layout tracks `visualViewport` so the
composer stays above the on-screen keyboard.

Dark by default — the TUI's palette, verbatim — with a light variant under
`prefers-color-scheme: light`.

## How it is built

```
src/web/
  page.ts            renderWebClientPage() — the whole document as one string
  styles.ts          the stylesheet, inlined
  script/model.ts    MODEL_SCRIPT: the AgentEvent reducer + DOM-less renderer
  script/app.ts      APP_SCRIPT: transport, DOM mounter, app wiring
  server.ts          the one-page HTTP listener and the origin allowlist
```

There is no build step and no bundler: the two client halves are exported as
JavaScript source strings and inlined into the page, so the client ships in
`dist/` as ordinary compiled output. The tests load those same strings with
`new Function` and drive them headlessly — against a fake socket for backoff and
auth, against a fake DOM for the page's own wiring, and against a real
`ArcturnServer` on `127.0.0.1:0` with a scripted LLM for the permission round trip.
The artifact that is tested is the artifact that is served.
