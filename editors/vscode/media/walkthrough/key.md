## Give the engine a model to talk to

Arcturn reads provider keys from your environment. Any one of these is enough
to start:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GOOGLE_API_KEY=...
```

Put it in your shell profile so new terminals inherit it — the extension starts
the engine with your login shell's environment, so a key exported only in a
running terminal will not reach it.

Nothing is stored by this extension. The key stays in your environment, and the
engine is the only thing that reads it.

**Select Model** shows what the engine can actually reach, so it doubles as a
check that your key arrived.
