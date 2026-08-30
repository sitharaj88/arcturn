"use client";

import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useId } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { modelTagError, placeholderError, roleError } from "@/lib/workflow-doc";
import { FIELD_INPUT, FIELD_LABEL, FIELD_TEXTAREA, ICON_BUTTON, NOTE_ERROR } from "./chrome";
import type { UiStage, UiStep } from "./state";

/** Everything a stage card can ask the island to do, keyed — never indexed. */
export interface StageHandlers {
  patchStage: (stageKey: string, patch: Partial<Pick<UiStage, "label" | "parallel">>) => void;
  patchStep: (
    stageKey: string,
    stepKey: string,
    patch: Partial<Pick<UiStep, "modelTag" | "role" | "prompt">>,
  ) => void;
  addStage: () => void;
  removeStage: (stageKey: string) => void;
  moveStage: (stageKey: string, delta: -1 | 1) => void;
  toggleParallel: (stageKey: string) => void;
  addBranch: (stageKey: string) => void;
  removeBranch: (stageKey: string, stepKey: string) => void;
  moveBranch: (stageKey: string, stepKey: string, delta: -1 | 1) => void;
}

export interface StageEditorProps {
  stages: UiStage[];
  handlers: StageHandlers;
}

/**
 * The pipeline, as ordered stage cards. Reordering is move-up/move-down
 * buttons rather than drag — the keyboard-operable answer, and stage numbers
 * renumber themselves because position *is* the number.
 */
export function StageEditor({ stages, handlers }: StageEditorProps) {
  return (
    <section aria-label="Pipeline stages" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-h3 text-text">Pipeline</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={handlers.addStage}
          iconLeft={<Plus aria-hidden="true" className="size-4" />}
        >
          Add stage
        </Button>
      </div>
      <p className="max-w-(--measure-body) text-caption text-muted">
        Placeholders: <code className="font-mono text-text">{"{{input}}"}</code> is the text the
        workflow was invoked with, <code className="font-mono text-text">{"{{prev}}"}</code> the
        previous stage&apos;s output, <code className="font-mono text-text">{"{{journal}}"}</code>{" "}
        the run journal so far — the last two have no value in stage 1.
      </p>

      {stages.length === 0 ? (
        <Card variant="quiet">
          <p className="text-body-sm text-muted">
            No stages yet — a workflow needs a numbered list of them. Add the first one above.
          </p>
        </Card>
      ) : (
        <ol className="flex list-none flex-col gap-4">
          {stages.map((stage, index) => (
            <li key={stage.key} className="min-w-0">
              <StageCard stage={stage} index={index} count={stages.length} handlers={handlers} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

interface StageCardProps {
  stage: UiStage;
  index: number;
  count: number;
  handlers: StageHandlers;
}

function StageCard({ stage, index, count, handlers }: StageCardProps) {
  const number = index + 1;
  const toggleBlocked = stage.parallel && stage.steps.length > 1;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-eyebrow uppercase text-faint">Stage {number}</span>
        {stage.parallel ? <Badge variant="accent">parallel</Badge> : null}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => handlers.moveStage(stage.key, -1)}
            disabled={index === 0}
            aria-label={`Move stage ${number} up`}
            className={ICON_BUTTON}
          >
            <ChevronUp aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => handlers.moveStage(stage.key, 1)}
            disabled={index === count - 1}
            aria-label={`Move stage ${number} down`}
            className={ICON_BUTTON}
          >
            <ChevronDown aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => handlers.removeStage(stage.key)}
            aria-label={`Remove stage ${number}`}
            className={ICON_BUTTON}
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>

      {stage.parallel ? (
        <ParallelBody stage={stage} number={number} handlers={handlers} />
      ) : (
        <StepFields
          step={stage.steps[0] ?? { key: `${stage.key}-empty`, modelTag: "", role: "", prompt: "" }}
          stageKey={stage.key}
          stageNumber={number}
          onPatch={handlers.patchStep}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-default pt-3">
        <Button
          variant="quiet"
          size="sm"
          onClick={() => handlers.toggleParallel(stage.key)}
          disabled={toggleBlocked}
          title={
            toggleBlocked
              ? "Remove branches until one remains to make this a single step"
              : undefined
          }
        >
          {stage.parallel ? "Make single-step" : "Make parallel"}
        </Button>
        {stage.parallel ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => handlers.addBranch(stage.key)}
            iconLeft={<Plus aria-hidden="true" className="size-4" />}
          >
            Add branch
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

interface ParallelBodyProps {
  stage: UiStage;
  number: number;
  handlers: StageHandlers;
}

function ParallelBody({ stage, number, handlers }: ParallelBodyProps) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className={FIELD_LABEL}>Stage label (optional — serialised with a trailing “:”)</span>
        <input
          type="text"
          value={stage.label}
          onChange={(event) => handlers.patchStage(stage.key, { label: event.target.value })}
          placeholder="Oracle lanes:"
          className={FIELD_INPUT}
        />
      </label>
      <ul className="flex list-none flex-col gap-3">
        {stage.steps.map((step, branchIndex) => (
          <li
            key={step.key}
            className="min-w-0 rounded-md border border-default bg-surface-inset p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-caption text-faint">
                branch {number}.{branchIndex + 1}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handlers.moveBranch(stage.key, step.key, -1)}
                  disabled={branchIndex === 0}
                  aria-label={`Move branch ${number}.${branchIndex + 1} up`}
                  className={ICON_BUTTON}
                >
                  <ChevronUp aria-hidden="true" className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handlers.moveBranch(stage.key, step.key, 1)}
                  disabled={branchIndex === stage.steps.length - 1}
                  aria-label={`Move branch ${number}.${branchIndex + 1} down`}
                  className={ICON_BUTTON}
                >
                  <ChevronDown aria-hidden="true" className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handlers.removeBranch(stage.key, step.key)}
                  disabled={stage.steps.length === 1}
                  aria-label={`Remove branch ${number}.${branchIndex + 1}`}
                  className={ICON_BUTTON}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </button>
              </div>
            </div>
            <div className="mt-3">
              <StepFields
                step={step}
                stageKey={stage.key}
                stageNumber={number}
                onPatch={handlers.patchStep}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface StepFieldsProps {
  step: UiStep;
  stageKey: string;
  stageNumber: number;
  onPatch: StageHandlers["patchStep"];
}

/** One step's `[tag] @role prompt` triple, validated with the engine's rules. */
function StepFields({ step, stageKey, stageNumber, onPatch }: StepFieldsProps) {
  const idBase = useId();
  const tagBad = modelTagError(step.modelTag);
  const roleBad = roleError(step.role);
  const promptBad =
    step.prompt.trim().length === 0
      ? "step has an empty prompt"
      : placeholderError(step.prompt, stageNumber);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={FIELD_LABEL}>Model tag (optional)</span>
          <input
            type="text"
            value={step.modelTag}
            onChange={(event) => onPatch(stageKey, step.key, { modelTag: event.target.value })}
            placeholder="tier:judgment"
            aria-describedby={tagBad === undefined ? undefined : `${idBase}-tag`}
            aria-invalid={tagBad !== undefined}
            className={FIELD_INPUT}
          />
          {tagBad === undefined ? null : (
            <span id={`${idBase}-tag`} className={NOTE_ERROR}>
              {tagBad}
            </span>
          )}
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={FIELD_LABEL}>Role (optional)</span>
          <input
            type="text"
            value={step.role}
            onChange={(event) => onPatch(stageKey, step.key, { role: event.target.value })}
            placeholder="developer"
            aria-describedby={roleBad === undefined ? undefined : `${idBase}-role`}
            aria-invalid={roleBad !== undefined}
            className={FIELD_INPUT}
          />
          {roleBad === undefined ? null : (
            <span id={`${idBase}-role`} className={NOTE_ERROR}>
              {roleBad}
            </span>
          )}
        </label>
      </div>
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className={FIELD_LABEL}>Prompt</span>
        <textarea
          value={step.prompt}
          onChange={(event) => onPatch(stageKey, step.key, { prompt: event.target.value })}
          rows={3}
          placeholder="One physical line in the file — line breaks become spaces."
          aria-describedby={promptBad === undefined ? undefined : `${idBase}-prompt`}
          aria-invalid={promptBad !== undefined}
          className={FIELD_TEXTAREA}
        />
        {promptBad === undefined ? null : (
          <span id={`${idBase}-prompt`} className={NOTE_ERROR}>
            {promptBad}
          </span>
        )}
      </label>
    </div>
  );
}
