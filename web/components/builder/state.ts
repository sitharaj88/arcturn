"use client";

import {
  type DocFrontmatter,
  type DocStage,
  type DocStep,
  FRONTMATTER_KEYS,
  type FrontmatterKey,
  type WorkflowDoc,
} from "@/lib/workflow-doc";

/**
 * The island's editable shape of a `WorkflowDoc`.
 *
 * Two differences from the document model, both for the editor's sake: every
 * field is a plain string ("" meaning unset), so inputs stay controlled
 * without undefined-juggling; and every stage and step carries a `key`, so a
 * reorder moves the React subtree instead of re-labelling it — index keys
 * would hand stage 2's DOM (focus included) to whatever lands at index 1.
 */
export interface UiStep {
  key: string;
  modelTag: string;
  role: string;
  prompt: string;
}

export interface UiStage {
  key: string;
  /** When false the stage is its single step; extra steps only exist while parallel. */
  parallel: boolean;
  label: string;
  steps: UiStep[];
}

export type UiFrontmatter = Record<FrontmatterKey, string>;

export interface BuilderState {
  frontmatter: UiFrontmatter;
  preamble: string;
  stages: UiStage[];
}

/** What an import attempt came back with — shown beside the paste area. */
export type ImportResult = { ok: true; warnings: string[] } | { ok: false; error: string };

// Monotonic within a page load; keys never reach the DOM, so the server and
// client runs counting independently cannot disagree about anything visible.
let serial = 0;

function freshKey(): string {
  serial += 1;
  return `wf-${serial}`;
}

export function newStep(): UiStep {
  return { key: freshKey(), modelTag: "", role: "", prompt: "" };
}

export function newStage(): UiStage {
  return { key: freshKey(), parallel: false, label: "", steps: [newStep()] };
}

export function emptyFrontmatter(): UiFrontmatter {
  return {
    name: "",
    description: "",
    continueOnError: "",
    stepTimeoutMs: "",
    maxStepRetries: "",
    budgetUsd: "",
    budgetTokens: "",
  };
}

/** The blank-page starter: a legal two-stage pipeline to edit, not an empty form. */
export function starterState(): BuilderState {
  return {
    frontmatter: { ...emptyFrontmatter(), name: "my-workflow" },
    preamble: "",
    stages: [
      {
        key: freshKey(),
        parallel: false,
        label: "",
        steps: [
          {
            key: freshKey(),
            modelTag: "",
            role: "architect",
            prompt: "Plan the change described here, as a numbered brief: {{input}}",
          },
        ],
      },
      {
        key: freshKey(),
        parallel: false,
        label: "",
        steps: [
          {
            key: freshKey(),
            modelTag: "",
            role: "developer",
            prompt: "Implement the plan below and report what you ran. Plan: {{prev}}",
          },
        ],
      },
    ],
  };
}

/** Editor state → the pure document the serialiser and validator understand. */
export function toDoc(state: BuilderState): WorkflowDoc {
  const frontmatter: DocFrontmatter = {};
  for (const key of FRONTMATTER_KEYS) {
    const value = state.frontmatter[key].trim();
    if (value.length > 0) frontmatter[key] = value;
  }

  const toStep = (step: UiStep): DocStep => ({
    ...(step.modelTag.trim().length > 0 ? { modelTag: step.modelTag.trim() } : {}),
    ...(step.role.trim().length > 0 ? { role: step.role.trim().toLowerCase() } : {}),
    prompt: step.prompt,
  });

  const stages: DocStage[] = state.stages.map((stage) => {
    if (stage.parallel) {
      return {
        parallel: true,
        ...(stage.label.trim().length > 0 ? { label: stage.label.trim() } : {}),
        steps: stage.steps.map(toStep),
      };
    }
    const head = stage.steps[0] ?? newStep();
    return { parallel: false, steps: [toStep(head)] };
  });

  return { frontmatter, preamble: state.preamble, stages };
}

/** A parsed document → fresh editor state, with new keys throughout. */
export function fromDoc(doc: WorkflowDoc): BuilderState {
  const frontmatter = emptyFrontmatter();
  for (const key of FRONTMATTER_KEYS) {
    const value = doc.frontmatter[key];
    if (value !== undefined) frontmatter[key] = value;
  }
  return {
    frontmatter,
    preamble: doc.preamble,
    stages: doc.stages.map((stage) => ({
      key: freshKey(),
      parallel: stage.parallel,
      label: stage.label ?? "",
      steps: stage.steps.map((step) => ({
        key: freshKey(),
        modelTag: step.modelTag ?? "",
        role: step.role ?? "",
        prompt: step.prompt,
      })),
    })),
  };
}

/** Move `stages[index]` by `delta`, returning a new array (or the same one at an edge). */
export function moveItem<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const next = [...items];
  const lifted = next[index];
  const displaced = next[target];
  if (lifted === undefined || displaced === undefined) return items;
  next[target] = lifted;
  next[index] = displaced;
  return next;
}
