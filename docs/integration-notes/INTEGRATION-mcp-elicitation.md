# Integrating MCP elicitation and sampling

An MCP server can ask the client two things back: `elicitation/create` ("ask the
user for this form") and `sampling/createMessage` ("run this on your model").
Until the 2026-10-10 "the engine uses the API it has" wave Arcturn's MCP client
advertised neither, so a server that wanted a confirmation or a completion had no
way to get one. Both are now handled, with very different defaults, because the
two have different blast radii: elicitation puts a question in front of the user,
who can decline; sampling spends the user's money.

Nothing here is a wiring recipe still to apply; the code is in the tree.

## Public surface

```ts
// @arcturn/mcp
McpManagerOptions.elicit?:               (req: McpElicitationRequest) => Promise<McpElicitationResult>;
McpManagerOptions.onElicitationRefused?: (info: { server: string; reason: string }) => void;
McpManagerOptions.sample?:               McpSamplingHandler;
McpManagerOptions.samplingMaxTokens?:    number;          // default DEFAULT_MCP_SAMPLING_MAX_TOKENS = 4096
McpServerCommonConfig.sampling?:         boolean;         // mcp.json, default off
validateElicitationSchema(schema), checkElicitationContent(fields, content);

// @arcturn/cli
packages/cli/src/mcp-host.ts               // the handlers the manager is given
packages/cli/src/interactive/elicitation-form.ts   // the TUI form
runtime.elicitationPrompt, runtime.directLlm
```

## Elicitation

**Advertised to every server**, as `elicitation: {form: {}}`. URL-mode
elicitation is not supported and is answered `InvalidParams`.

`validateElicitationSchema` is the gate the spec asks for and the only thing that
produces the field list. `requestedSchema` must be a flat object whose properties
are string (length bounds; formats `email`, `uri`, `date`, `date-time`),
number or integer (bounds), boolean, or a single- or multi-select string enum.
Nesting, arrays of objects and `$ref` are outside the subset: the request is
refused with `McpError(InvalidParams, "Elicitation refused: …")`, the host's
`onElicitationRefused` is told (a warn notice and an audit entry), and the user
never sees a form. The SDK's own parse runs first; this is the second gate and
reads the schema as `unknown`, so an SDK that becomes more lenient does not widen
what Arcturn accepts. After the user answers, `checkElicitationContent` checks the
answer against the same field list before it goes back.

**Who answers.** `runtime.elicitationPrompt` is set only where a person is at a
terminal: the interactive TUI. In `--print`, `arcturn serve` and ACP it is
absent, and the request is **declined** with a warn notice (`reason: "this
session cannot prompt"`). It is never accepted with empty content; an empty
accept looks like consent. ACP could forward the request to the editor and does
not yet. A prompt that throws answers `cancel` (fail closed).

**Audit.** Every request, answered or not, writes
`{kind: "elicitation", server, action, fields}`, with `action` one of `accept`,
`decline`, `cancel`, `refused` and `reason` where there is one. `fields` is the
**names** only. The answers are never recorded: an elicitation is where someone
types a token. `arcturn audit` prints it as `elic  <server>  <action>  (names)`.

## Sampling

**Off by default, per server, and only the user's file can turn it on.** The
`sampling` capability is advertised to a server only if its `mcp.json` entry has
`"sampling": true`; `withoutProjectSampling` strips the key from every server a
project's `.arcturn/mcp.json` defines, including one that shadows a user entry of
the same name, because sampling spends the user's key on a server's say-so. Only
`~/.arcturn/mcp.json` grants it
(`McpServerCommonConfig.sampling`, validated as a boolean). Any other server that
sends `sampling/createMessage` gets `-32601` (method not found), as if the
client had never heard of it. Because it is per server, a user opts a server in
knowing which one it is. There is no `--sampling` flag on `mcp add`.

`narrowSamplingRequest` reduces the server's request to what a host may act on
and refuses the rest: `tools` or `toolChoice` (the client does not declare
`sampling.tools`), any non-text block, an empty conversation, a role other than
`user` or `assistant`. `includeContext` is ignored; "none" is the only answer the
client gives.

**One isolated call.** `mcp-host.ts` runs the request on `runtime.directLlm`, the
bare client: no tools and no session history. The server's messages are
folded into one user message; its `systemPrompt` applies to that call only. A
server's `modelPreferences.hints` may pick a different model (`selectSamplingModel`),
but only one on the session model's own provider and endpoint, so a server can
steer between models the user already pays the same party for and cannot move the
call, or the key, to another host. No match runs the session model.

**Spend.**

- Output is capped at `DEFAULT_MCP_SAMPLING_MAX_TOKENS` (4096) unless the host
  passes `samplingMaxTokens`; a server's `maxTokens` can only lower it.
- The call is billed to `runtime.metrics`, so `/cost` and `--max-cost` see it.
- If the session has reached its cost limit the request is refused with an
  error to the server (`Sampling refused: this session has reached its … cost
  limit`).
- Each call prints an info notice:
  `MCP server "<n>" sampled <model>: … (billed to this session).`

**Audit.** Each call writes `{kind: "sampling", server, model, tokens, costUsd?}`:
counts and names, never the prompt or the reply. Server-supplied strings are
scrubbed of terminal escape sequences before they are recorded or shown.

## Left undone

- **ACP declines elicitation** instead of forwarding it to the editor.
- **No `--sampling` flag** on `arcturn mcp add`; edit `mcp.json`.

## Not verified live

Both flows are covered by tests against an in-process MCP server built on the
official SDK, including the refusal paths. Not run: a real third-party server
sending either request, and the TUI form on a real terminal (key handling,
narrow widths, paste).
