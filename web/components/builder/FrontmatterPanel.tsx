"use client";

import { useId } from "react";
import { Card } from "@/components/ui/Card";
import {
  type FrontmatterKey,
  frontmatterValueError,
  nameNormalizationWarning,
  normalizeWorkflowName,
} from "@/lib/workflow-doc";
import { FIELD_INPUT, FIELD_LABEL, NOTE_ERROR, NOTE_WARN } from "./chrome";
import type { UiFrontmatter } from "./state";

export interface FrontmatterPanelProps {
  frontmatter: UiFrontmatter;
  onChange: (key: FrontmatterKey, value: string) => void;
}

interface NumericFieldSpec {
  key: FrontmatterKey;
  label: string;
  hint: string;
  placeholder: string;
}

/** The four numeric keys, with the engine's rule compressed into the hint. */
const NUMERIC_FIELDS: NumericFieldSpec[] = [
  {
    key: "stepTimeoutMs",
    label: "Step timeout (ms)",
    hint: "Whole number above 0.",
    placeholder: "1800000",
  },
  {
    key: "maxStepRetries",
    label: "Max step retries",
    hint: "Whole number, 0 disables retry.",
    placeholder: "2",
  },
  {
    key: "budgetUsd",
    label: "Budget (USD)",
    hint: "Decimals allowed, 0 disables.",
    placeholder: "15",
  },
  {
    key: "budgetTokens",
    label: "Budget (tokens)",
    hint: "Whole number, 0 disables.",
    placeholder: "250000",
  },
];

/**
 * The seven frontmatter keys the engine recognises, validated inline with the
 * engine's own rules — including the warning the engine never gives: a name
 * it would silently normalise is flagged here instead of mangled.
 */
export function FrontmatterPanel({ frontmatter, onChange }: FrontmatterPanelProps) {
  const idBase = useId();
  const noteId = (key: string) => `${idBase}-${key}-note`;

  const name = frontmatter.name;
  const nameError =
    normalizeWorkflowName(name.trim()).length === 0
      ? 'workflow has no usable name; set "name:" in the frontmatter'
      : undefined;
  const nameWarning = nameError === undefined ? nameNormalizationWarning(name) : undefined;

  const numericError = (key: FrontmatterKey): string | undefined =>
    frontmatter[key].trim().length === 0 ? undefined : frontmatterValueError(key, frontmatter[key]);

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="text-h3 text-text">Frontmatter</h2>
        <p className="mt-1 text-body-sm text-muted">
          The keys between the <code className="font-mono">---</code> fences. Only the name is
          required; everything left empty stays out of the file.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={FIELD_LABEL}>Name (required)</span>
          <input
            type="text"
            value={name}
            onChange={(event) => onChange("name", event.target.value)}
            placeholder="my-workflow"
            aria-describedby={noteId("name")}
            aria-invalid={nameError !== undefined}
            className={FIELD_INPUT}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={FIELD_LABEL}>Continue on error</span>
          <select
            value={frontmatter.continueOnError}
            onChange={(event) => onChange("continueOnError", event.target.value)}
            className={FIELD_INPUT}
          >
            <option value="">unset (defaults to false)</option>
            <option value="true">true — later stages still run</option>
            <option value="false">false — a failed stage stops the run</option>
          </select>
        </label>
      </div>
      <div id={noteId("name")} className="-mt-2 empty:hidden">
        {nameError !== undefined ? <p className={NOTE_ERROR}>{nameError}</p> : null}
        {nameWarning !== undefined ? <p className={NOTE_WARN}>{nameWarning}</p> : null}
      </div>

      <label className="flex min-w-0 flex-col gap-1.5">
        <span className={FIELD_LABEL}>Description</span>
        <input
          type="text"
          value={frontmatter.description}
          onChange={(event) => onChange("description", event.target.value)}
          placeholder="What this pipeline does, in one line — colons are fine."
          className={FIELD_INPUT}
        />
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        {NUMERIC_FIELDS.map((field) => {
          const error = numericError(field.key);
          return (
            <label key={field.key} className="flex min-w-0 flex-col gap-1.5">
              <span className={FIELD_LABEL}>{field.label}</span>
              <input
                type="text"
                inputMode="decimal"
                value={frontmatter[field.key]}
                onChange={(event) => onChange(field.key, event.target.value)}
                placeholder={field.placeholder}
                aria-describedby={noteId(field.key)}
                aria-invalid={error !== undefined}
                className={FIELD_INPUT}
              />
              <span
                id={noteId(field.key)}
                className={error === undefined ? "text-caption text-faint" : NOTE_ERROR}
              >
                {error ?? field.hint}
              </span>
            </label>
          );
        })}
      </div>
    </Card>
  );
}
