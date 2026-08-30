"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import {
  isWorkflowDocError,
  parseWorkflowDoc,
  serializeWorkflowDoc,
  validateWorkflowDoc,
} from "@/lib/workflow-doc";
import { FIELD_LABEL, FIELD_TEXTAREA } from "./chrome";
import { FrontmatterPanel } from "./FrontmatterPanel";
import { type BuilderExample, ImportPanel } from "./ImportPanel";
import { MarkdownPane } from "./MarkdownPane";
import { StageEditor, type StageHandlers } from "./StageEditor";
import {
  fromDoc,
  type ImportResult,
  moveItem,
  newStage,
  newStep,
  starterState,
  toDoc,
  type UiStage,
} from "./state";

export interface BuilderAppProps {
  /** Real kit workflows, read from disk at export time by the server shell. */
  examples: BuilderExample[];
}

/**
 * The builder page's one client island (the HubFilter doctrine: the page is
 * static, interactivity mounts in a single component). All state lives here
 * as an editable mirror of `WorkflowDoc`; every keystroke re-serialises and
 * re-validates through `lib/workflow-doc`, so the markdown pane and the
 * inline notices can never disagree with what an import — or the CLI's own
 * parser — would say about the file.
 */
export function BuilderApp({ examples }: BuilderAppProps) {
  const [state, setState] = useState(starterState);

  const doc = useMemo(() => toDoc(state), [state]);
  const markdown = useMemo(() => serializeWorkflowDoc(doc), [doc]);
  const issues = useMemo(() => validateWorkflowDoc(doc), [doc]);

  const importMarkdown = (raw: string, defaultName?: string): ImportResult => {
    const parsed = parseWorkflowDoc(raw, defaultName === undefined ? {} : { name: defaultName });
    // Strict parse, forgiving editor: a rejected file reports the engine's
    // line-numbered error and leaves the current editing state untouched.
    if (isWorkflowDocError(parsed)) return { ok: false, error: parsed.error };
    setState(fromDoc(parsed.doc));
    return { ok: true, warnings: parsed.warnings };
  };

  const patchStages = (mutate: (stages: UiStage[]) => UiStage[]) => {
    setState((prev) => ({ ...prev, stages: mutate(prev.stages) }));
  };

  const handlers: StageHandlers = {
    patchStage: (stageKey, patch) =>
      patchStages((stages) =>
        stages.map((stage) => (stage.key === stageKey ? { ...stage, ...patch } : stage)),
      ),
    patchStep: (stageKey, stepKey, patch) =>
      patchStages((stages) =>
        stages.map((stage) =>
          stage.key === stageKey
            ? {
                ...stage,
                steps: stage.steps.map((step) =>
                  step.key === stepKey ? { ...step, ...patch } : step,
                ),
              }
            : stage,
        ),
      ),
    addStage: () => patchStages((stages) => [...stages, newStage()]),
    removeStage: (stageKey) =>
      patchStages((stages) => stages.filter((stage) => stage.key !== stageKey)),
    moveStage: (stageKey, delta) =>
      patchStages((stages) =>
        moveItem(
          stages,
          stages.findIndex((stage) => stage.key === stageKey),
          delta,
        ),
      ),
    toggleParallel: (stageKey) =>
      patchStages((stages) =>
        stages.map((stage) => {
          if (stage.key !== stageKey) return stage;
          // Collapsing to single-step is only offered at one branch, so the
          // toggle never discards a step the user can still see.
          if (stage.parallel && stage.steps.length > 1) return stage;
          return { ...stage, parallel: !stage.parallel, label: stage.parallel ? "" : stage.label };
        }),
      ),
    addBranch: (stageKey) =>
      patchStages((stages) =>
        stages.map((stage) =>
          stage.key === stageKey ? { ...stage, steps: [...stage.steps, newStep()] } : stage,
        ),
      ),
    removeBranch: (stageKey, stepKey) =>
      patchStages((stages) =>
        stages.map((stage) =>
          stage.key === stageKey && stage.steps.length > 1
            ? { ...stage, steps: stage.steps.filter((step) => step.key !== stepKey) }
            : stage,
        ),
      ),
    moveBranch: (stageKey, stepKey, delta) =>
      patchStages((stages) =>
        stages.map((stage) =>
          stage.key === stageKey
            ? {
                ...stage,
                steps: moveItem(
                  stage.steps,
                  stage.steps.findIndex((step) => step.key === stepKey),
                  delta,
                ),
              }
            : stage,
        ),
      ),
  };

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,3fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        <FrontmatterPanel
          frontmatter={state.frontmatter}
          onChange={(key, value) =>
            setState((prev) => ({ ...prev, frontmatter: { ...prev.frontmatter, [key]: value } }))
          }
        />

        <Card variant="quiet">
          <details>
            <summary className="cursor-pointer text-body-sm font-medium text-text">
              Preamble{" "}
              <span className="font-normal text-muted">
                — prose before the first stage, kept verbatim
              </span>
            </summary>
            <label className="mt-3 flex min-w-0 flex-col gap-1.5">
              <span className={FIELD_LABEL}>
                The parser ignores it; readers and imports keep it. Lines must not start like a
                stage (<code className="font-mono">1.</code>) or a branch (
                <code className="font-mono">-</code>).
              </span>
              <textarea
                value={state.preamble}
                onChange={(event) =>
                  setState((prev) => ({ ...prev, preamble: event.target.value }))
                }
                rows={4}
                placeholder="Why the stages are shaped this way, and how to run the workflow."
                className={FIELD_TEXTAREA}
              />
            </label>
          </details>
        </Card>

        <StageEditor stages={state.stages} handlers={handlers} />
      </div>

      <div className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
        <MarkdownPane markdown={markdown} name={state.frontmatter.name} issues={issues} />
        <ImportPanel examples={examples} onImport={importMarkdown} />
      </div>
    </div>
  );
}
