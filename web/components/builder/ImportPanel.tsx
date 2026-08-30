"use client";

import { Upload } from "lucide-react";
import { type ChangeEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FIELD_LABEL, FIELD_TEXTAREA, NOTE_ERROR, NOTE_WARN } from "./chrome";
import type { ImportResult } from "./state";

export interface BuilderExample {
  id: string;
  label: string;
  markdown: string;
}

export interface ImportPanelProps {
  examples: BuilderExample[];
  /** Parse and adopt `markdown`; `defaultName` is the engine's filename-stem fallback. */
  onImport: (markdown: string, defaultName?: string) => ImportResult;
}

// HubFilter's chip recipe — an example picker is the same gesture as a filter.
const CHIP =
  "inline-flex min-h-11 items-center rounded-full border border-default bg-surface-card px-3.5 " +
  "text-caption font-medium text-muted transition-[background-color,border-color,color] dur-fast " +
  "ease-out hover:border-strong hover:text-text sm:min-h-9";

/**
 * The way an existing file gets into the editor: paste it, pick it, or load a
 * real kit workflow shipped with the repository. A failed parse reports the
 * engine's own line-numbered error and leaves the current editing state alone.
 */
export function ImportPanel({ examples, onImport }: ImportPanelProps) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const runImport = (markdown: string, defaultName?: string) => {
    setResult(onImport(markdown, defaultName));
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Same file re-picked must fire change again.
    event.target.value = "";
    if (!file) return;
    const contents = await file.text();
    runImport(contents, file.name.replace(/\.[^.]*$/, ""));
  };

  return (
    <Card className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-h3 text-text">Import</h2>
        <p className="mt-1 text-body-sm text-muted">
          Paste a workflow file or pick one from disk. Importing replaces what is in the editor; a
          file the parser rejects changes nothing.
        </p>
      </div>

      {examples.length > 0 ? (
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className={`${FIELD_LABEL} mb-2`}>Load a real kit workflow</legend>
          {examples.map((example) => (
            <button
              key={example.id}
              type="button"
              onClick={() => runImport(example.markdown)}
              className={CHIP}
            >
              {example.label}
            </button>
          ))}
        </fieldset>
      ) : null}

      <label className="flex min-w-0 flex-col gap-1.5">
        <span className={FIELD_LABEL}>Paste workflow markdown</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          placeholder={"---\nname: my-workflow\n---\n1. @role prompt with {{input}}"}
          className={FIELD_TEXTAREA}
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => runImport(text)}
          disabled={text.trim().length === 0}
        >
          Import pasted markdown
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,text/markdown,text/plain"
          onChange={onFile}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        />
        <Button
          variant="quiet"
          size="sm"
          onClick={() => fileRef.current?.click()}
          iconLeft={<Upload aria-hidden="true" className="size-4" />}
        >
          Import a file…
        </Button>
      </div>

      <div role="status" aria-live="polite" className="empty:hidden">
        {result === null ? null : result.ok ? (
          <div className="flex flex-col gap-1">
            <p className="text-caption text-good">Imported.</p>
            {result.warnings.map((warning) => (
              <p key={warning} className={NOTE_WARN}>
                {warning}
              </p>
            ))}
          </div>
        ) : (
          <p className={NOTE_ERROR}>{result.error}</p>
        )}
      </div>
    </Card>
  );
}
