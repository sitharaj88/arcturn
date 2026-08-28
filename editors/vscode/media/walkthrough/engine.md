## The extension is a client, not the agent

Arcturn's engine is a separate program: the `arcturn` CLI. This extension starts
it, talks to it over a local socket, and renders what it says. Everything that
matters — the permission engine, worktree isolation, cost accounting, MCP — lives
there, which is why the terminal and the panel behave identically.

So there is one prerequisite, and this is it:

```bash
npm install -g arcturn
```

Node 20 or newer. **Install CLI** runs that for you in a terminal.

The panel needs **0.4.0 or newer** — it speaks verbs no earlier engine answers.
If you already have `arcturn`, `arcturn --version` will tell you where you stand,
and the same command upgrades it.
