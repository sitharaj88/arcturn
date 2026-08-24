"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CopyButton } from "@/components/ui/CopyButton";

/**
 * Adds a copy button to every code block inside rendered markdown.
 *
 * The article HTML is produced at build time by the unified pipeline, so the
 * buttons cannot be part of it. Instead this mounts one empty slot per
 * `figure.code-figure` and portals the shared `<CopyButton>` into it: the
 * markup stays server-rendered, the client cost is one small component, and
 * without JavaScript the page simply has no buttons.
 *
 * The clipboard payload is the `data-code` attribute the pipeline wrote —
 * the original source, not a reconstruction of the highlighted DOM.
 */
export interface CodeCopyLayerProps {
  /** Id of the element whose descendants get buttons. */
  containerId: string;
}

interface Slot {
  node: HTMLElement;
  code: string;
}

/** Shell prompts are chrome, not payload: `$` never reaches the clipboard. */
function stripShellPrompt(code: string): string {
  const lines = code.split("\n");
  if (!lines.some((line) => line.trimStart().startsWith("$ "))) return code;
  return lines.map((line) => line.replace(/^(\s*)\$ /, "$1")).join("\n");
}

export function CodeCopyLayer({ containerId }: CodeCopyLayerProps) {
  const [slots, setSlots] = useState<Slot[]>([]);

  useEffect(() => {
    const container = document.getElementById(containerId);
    if (!container) return;

    const created: Slot[] = [];
    const figures = container.querySelectorAll<HTMLElement>("figure.code-figure");

    figures.forEach((figure) => {
      const code = figure.dataset.code ?? figure.querySelector("pre")?.textContent ?? "";
      if (!code) return;
      const node = document.createElement("span");
      node.className = "code-copy";
      // Into the header bar, beside the language pill — the header is part of
      // the build-time markup, so the slot always has a home; the figure
      // fallback only exists so a figure something else emitted still gets a
      // button rather than nothing.
      (figure.querySelector(":scope > .code-head") ?? figure).appendChild(node);
      created.push({ node, code });
    });

    setSlots(created);
    return () => {
      for (const slot of created) slot.node.remove();
    };
  }, [containerId]);

  return (
    <>
      {slots.map((slot, index) =>
        createPortal(
          <CopyButton value={stripShellPrompt(slot.code)} label="Copy code" />,
          slot.node,
          `code-copy-${index}`,
        ),
      )}
    </>
  );
}
