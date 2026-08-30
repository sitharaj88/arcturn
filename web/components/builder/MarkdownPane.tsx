"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import type { DocIssue } from "@/lib/workflow-doc";
import { normalizeWorkflowName } from "@/lib/workflow-doc";

export interface MarkdownPaneProps {
  markdown: string;
  /** Raw name from the frontmatter panel — normalised here for the filename. */
  name: string;
  issues: DocIssue[];
}

/**
 * The live serialisation of the document, always visible — the builder's
 * output *is* this text, and hiding it behind an export button would let the
 * form and the file drift apart in the user's head. Copy and download act on
 * exactly what is shown.
 */
export function MarkdownPane({ markdown, name, issues }: MarkdownPaneProps) {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const fileName = `${normalizeWorkflowName(name.trim()) || "workflow"}.md`;

  const download = () => {
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-h3 text-text">Markdown</h2>
        <div className="ml-auto flex items-center gap-2">
          <CopyButton value={markdown} label="Copy workflow markdown" />
          <Button
            variant="ghost"
            size="sm"
            onClick={download}
            iconLeft={<Download aria-hidden="true" className="size-4" />}
          >
            Download {fileName}
          </Button>
        </div>
      </div>

      <pre className="max-h-[26rem] min-w-0 overflow-auto rounded-md border border-default bg-surface-inset p-4 font-mono text-code-block text-text">
        <code>{markdown}</code>
      </pre>

      {/* Announced, not just shown: the verdict changing under an edit is
          invisible to a screen reader without a live region. */}
      <p aria-live="polite" className="text-caption text-faint">
        {errors.length === 0
          ? "Valid — the CLI's parser accepts this file."
          : `${errors.length} ${errors.length === 1 ? "problem" : "problems"} the CLI would reject.`}
        {warnings.length > 0
          ? ` ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}.`
          : ""}
      </p>

      {issues.length > 0 ? (
        <ul className="flex list-none flex-col gap-1.5 border-t border-default pt-3">
          {issues.map((issue) => (
            <li
              key={`${issue.location}:${issue.message}`}
              className={`text-caption ${issue.severity === "error" ? "text-bad" : "text-warn"}`}
            >
              <span className="font-medium">{issue.location}</span> — {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
