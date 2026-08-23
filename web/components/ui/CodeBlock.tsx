import { codeToHtml } from "shiki";
import { cn } from "@/lib/cn";
// The chip, the copy button and the room they reserve are ONE ruleset, shared
// with the docs markdown pipeline. Importing it here — rather than leaving it
// to `app/docs/layout.tsx` — is what lets a marketing page use the same
// `.code-figure` chrome instead of a second, drifting copy of it.
import "@/app/docs/docs.css";
import { CopyButton } from "./CopyButton";

/**
 * Build-time syntax highlighting. Shiki runs during the static export and
 * emits both palettes as CSS variables on each token span, so the light and
 * dark themes are a pure CSS switch with zero client JS (DESIGN.md §2.2.4).
 */
export interface CodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
  showLineNumbers?: boolean;
  className?: string;
}

/** Shell prompts are chrome, not payload: `$` never reaches the clipboard. */
export function stripShellPrompt(code: string): string {
  const lines = code.split("\n");
  if (!lines.some((line) => line.trimStart().startsWith("$ "))) return code;
  return lines.map((line) => line.replace(/^(\s*)\$ /, "$1")).join("\n");
}

export async function CodeBlock({
  code,
  language = "text",
  filename,
  showLineNumbers = false,
  className,
}: CodeBlockProps) {
  const source = code.replace(/\n+$/, "");
  const html = await codeToHtml(source, {
    lang: language,
    themes: { light: "github-light", dark: "github-dark-default" },
    defaultColor: false,
  });

  return (
    <figure
      className={cn(
        // `code-figure` carries the positioning context, the chip, the button
        // and the hover gate (`app/docs/docs.css`). Everything left here is
        // this block's own ground — docs put the same ground on the `<pre>`.
        "code-figure overflow-hidden rounded-md border border-default bg-surface-inset",
        className,
      )}
    >
      {language && language !== "text" ? (
        <span className="code-lang" aria-hidden="true">
          {language}
        </span>
      ) : null}

      {filename ? (
        <figcaption className="border-b border-default px-4 py-2 font-mono text-caption text-faint">
          {filename}
        </figcaption>
      ) : null}

      <div
        className={cn(
          // `pl-4`, not `px-4`: the right side is the shared
          // `--code-chrome-inset`, and pitting Tailwind's logical
          // `padding-inline` against the sheet's physical `padding-right`
          // makes the reservation a cascade question nobody should have to
          // answer. Only one rule sets the right edge.
          "code-scroll overflow-x-auto py-4 pl-4 text-code-block [&_pre]:min-w-max [&_pre]:bg-transparent",
          showLineNumbers && "code-line-numbers",
        )}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: `html` is Shiki's own escaped output for local trusted source, produced at build time; no user input reaches it.
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <span className="code-copy">
        <CopyButton value={stripShellPrompt(source)} label="Copy code" />
      </span>
    </figure>
  );
}
