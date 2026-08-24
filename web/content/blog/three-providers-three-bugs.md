---
title: "Three providers, three bugs, under two cents"
description: "Before publishing 0.1.0 I drove each first-party provider adapter against its real endpoint for the first time. All three runs found a shipping-blocking bug that four thousand passing tests could not see."
date: 2026-08-24
author: "Sitharaj Seenivasan"
---

## The cheapest test I had never run

Arcturn's provider adapters were written, reviewed, and unit-tested long before any of
them was pointed at the thing it adapts. That is normal, and it looked fine: north of
four thousand tests across 212 files, green on every run.

Before publishing 0.1.0 I did the obvious remaining thing and drove each first-party
adapter against its real endpoint — Anthropic on Claude Haiku 4.5, Google on Gemini 3.5
Flash Lite, OpenAI on GPT-5 nano through both its Chat Completions and Responses surfaces.
One live run each: streaming text, a tool call whose result is fed back and answered from
on a second turn, and cost accounting checked against the published rates.

Total spend: under two cents.

Three runs, three bugs. Each one would have shipped. Two were in features the
documentation described as working.

## Anthropic: the shape a program uses was the shape that hung

The Anthropic run worked when I typed it. Run from a script with output redirected to a
file, it produced nothing at all — no events, no error, no exit, for as long as I left it
alone.

The difference was not stdout. It was stdin. `--print` read stdin to EOF whenever
`isTTY` was false, and "not a terminal" describes two situations that want opposite
handling. A pipe carrying a prompt closes when its writer is done — `cat q.txt | arcturn
-p` — and reading to EOF is exactly right. A pipe a parent process opened and kept never
closes. That is every CI runner, every Makefile recipe, every `subprocess.run`, and every
agent that spawns this binary. Reading to EOF there waits forever, before a single event
is emitted, with nothing on stderr to say why.

So the one invocation shape a *program* uses to drive an agent was the shape that hung,
silently. Interactive use — the way I had used it for months — was the case that worked.

The fix is in `packages/cli/src/cli-main.ts`, in `readPipedStdin`, and the rule is that
the prompt argument decides which situation this is. With no prompt argument, stdin *is*
the prompt and blocking to EOF is the only correct behaviour. With a prompt argument,
stdin is optional leading context: wait 250ms for a first byte, and if none arrives, run
what was actually asked for. A real producer wins that race; an inherited pipe never does.
The residue is a slow producer beside a prompt argument, whose context gets dropped rather
than the run hanging — the safe direction, and written down as such.

Fixing the read alone moved the bug instead of removing it. The abandoned `next()` still
held stdin's handle, so the run finished its work, emitted `runEnd`, and then never
exited. Same hang, other end of the run, and it reads as fixed if you only check the
output. The iterator is now closed and the handle unref'd when the deadline wins, and
there is a test called *releases the abandoned pipe so the process can still exit*,
because that is the failure that would otherwise have been declared a success.

## Google: the deferred nicety was a total feature failure

Turn one of the Gemini run was clean. The model emitted a `functionCall`, arcturn
assembled it, the tool executed, the result went back.

Turn two came back `400 INVALID_ARGUMENT`:

```text
Function call is missing a thought_signature in functionCall parts.
This is required for tools to work correctly.
```

Gemini 3 signs the *call*, not only the thinking that led to it, and requires the
signature back on the next request. The adapter round-tripped `thoughtSignature` for
thinking parts and dropped it for `functionCall` parts on both legs: the parser only read
it under `kind === "thinking"`, and the outgoing part was built without it. Every
multi-turn tool use on Google failed on its second request, which is to say the agent loop
had never once completed on that provider.

The part I keep coming back to is where this was already filed. `PLAN.md` listed it under
"Contracts v2 · reasoning continuity" — an optional signature on `ToolCallContent`,
wanted for fidelity, to get to later. A known item, correctly described, ranked as a
nicety. It was the difference between tool calling working and tool calling not working at
all, and nothing short of a live second turn could tell those two readings apart.

`ToolCallContent.signature` now exists in `packages/types/src/messages.ts`, parallel to
`ThinkingContent.signature`, which is there because Anthropic rejects unsigned thinking
the same way. It is carried, never interpreted: the provider's token, replayed verbatim.
Two tests, both verified failing first, pin each leg.

The same session turned up a smaller one. `google/gemini-2.5-flash-lite` is in the
catalog and Google now answers 404 for it — no longer available to new users. `/model
refresh` is the designed answer for a stale catalog; the entry is still stale.

## OpenAI: 929 lines nobody could select

The third bug is my favourite, because there was nothing wrong with the code.

`openai-responses` is a registered provider. `builtins.ts` registers it, the default
API-key map points it at `OPENAI_API_KEY`, the docs list it in the provider table beside
`openai`, the CLI README names both surfaces, and 41 unit tests cover the adapter. At 929
lines it is the largest provider file in the repository.

I went to run it live, and:

```text
$ arcturn -p "..." -m openai-responses/gpt-5-nano
Unknown model "openai-responses/gpt-5-nano".
```

That message is followed by the whole model catalog, which is the exact list the entries
were missing from, and then by a hint suggesting `registerModel()`.

It shipped with zero catalog entries, and `--model` resolves against the catalog. The
adapter was unreachable to every CLI user. The only way in was an embedder calling
`registerModel` themselves. Driven directly with a hand-registered spec, it streams text,
emits a tool call, takes the result back and answers from it — the adapter was fine the
whole time. This was a reachability defect, which is exactly why every unit test passed.

The catalog now derives the Responses entries from the Chat Completions list — 13 models,
same names, same limits, same prices, one copy of the literals. The regression test is the
general form of the bug: *makes every registered provider reachable from the catalog*. A
provider nobody can select is a provider that does not exist.

## What "verified" is a word for

None of these three was reachable by a unit test, because none of them was a mistake about
what the code does. The stdin read did exactly what it said. The Gemini adapter
round-tripped exactly the signatures it was written to round-trip. The Responses
adapter worked perfectly and was simply not in a list. Every mock agreed with every
implementation, which is the one thing mocks reliably do.

So: verified is a word for things that have actually run. That distinction is why the
[provider table](/docs/providers) has a *Verified live* column rather than a longer list
of ticks, why the docs separate implemented from demonstrated, and why no status on this
site can be upgraded before the disclosure that backs it changes first.

Six provider paths carry a tick today. Bedrock, Vertex and Azure carry a warning: they
have never reached their endpoints, because each needs a cloud account rather than an
API key. Azure and Vertex at least reuse stream translation the verified runs exercise;
`bedrock` shares none of it and is the largest genuinely untested surface in the project.
The OAuth endpoint URLs are unverified against live provider documentation too.

Given the hit rate above — three for three, at under two cents — I would not bet on
those three being clean. The honest list is the product. When they run, I will say what
they found.
