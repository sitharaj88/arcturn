## Connect the tools you already use

MCP servers give the agent real capabilities — a design file, a database, an
issue tracker. Configure them in `.mcp.json`:

```jsonc
{
  "servers": {
    "figma": { "type": "http", "url": "https://...", "auth": "oauth" }
  }
}
```

For a hosted server that needs OAuth, run **Authorize MCP Server** from the
palette. The editor opens your browser and catches the redirect itself, which
is what makes this work when the engine is somewhere your browser is not —
Remote-SSH, a devcontainer, a Codespace.

Tokens are held by the engine, in `~/.arcturn/auth`, at `0600`. The extension
never sees one.

MCP tools arrive with the same permission prompts as everything else. A server
saying a tool is read-only is a claim, not a fact, and Arcturn treats it that way.
