# `@arcturn/tui`

A from-scratch terminal UI library with differential rendering, built for the
[Arcturn](https://arcturn.dev) CLI but standalone and independently usable. It depends
only on `marked` and `get-east-asian-width`, and every terminal interaction goes through
a `Terminal` interface, so the whole library can be driven headlessly (see
`TestTerminal`) — useful for snapshot-testing a TUI without a real tty.

## What's in it

`src/index.ts` groups exports by area:

- **ANSI + styling** — `fg`, `bg`, `bold`, `dim`, `italic`, `underline`, `hyperlink`,
  `combine`, `makeStyle`, `stripAnsi`, `detectColorLevel`, cursor/erase control
  sequences.
- **Components** (`./components/index.js`) — the widget set (editor, text, layout,
  etc.) built on the renderer below.
- **Images** — `renderImage`, `encodeKittyImage`, `encodeItermImage`,
  `detectImageSupport` for terminals that support inline image protocols.
- **Key decoding** — `KeyDecoder`, `createKey`, `matchesKey`, `keyToString`.
- **Terminal** — `Terminal` (the interface), `ProcessTerminal` (a real tty), and
  `TestTerminal` (an in-memory terminal for tests).
- **Theming** — `createTheme`, `getTheme`/`setTheme`, `darkTheme`, `lightTheme`, `style`.
- **Renderer** — `TUI`, the root component tree and differential-rendering engine, plus
  `Component`, `KeyHandler`, and overlay-positioning types.
- **Width, wrapping, truncation** — East-Asian-width-aware string measurement.

## Install

Arcturn is not yet published to npm. Until it is, use it from a clone of the monorepo as
a pnpm workspace package:

```bash
git clone https://github.com/sitharaj88/arcturn.git && cd arcturn
pnpm install && pnpm -r build
```

Then depend on it from another workspace package: `"@arcturn/tui": "workspace:*"`.

## Usage

```ts
import { Editor, ProcessTerminal, Text, TUI } from "@arcturn/tui";

const tui = new TUI(new ProcessTerminal());
const editor = new Editor({ onSubmit: (text) => console.log(text) });
tui.add(new Text("Ask me anything", { style: "accent" }));
tui.add(editor);
tui.focus(editor);
tui.start();
```

## Docs

`@arcturn/tui` powers the `arcturn` CLI's terminal interface; there is no dedicated SDK
page for it yet. See [Embedding with the SDK](https://arcturn.dev/docs/sdk) for how the
CLI, this library, and the agent runtime relate, and the
[Arcturn documentation](https://arcturn.dev/docs) index for what's covered so far.

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
