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
        // `code-figure` is the shared chrome contract (app/docs/docs.css):
        // every code surface on the site — docs, blog, this component — emits
        // the same header bar, so the chip, the title and the copy button have
        // one size and one position everywhere.
        "code-figure overflow-hidden rounded-md border border-default bg-surface-inset",
        className,
      )}
    >
      <div className="code-head">
        <span className="code-title">{filename ?? (language !== "text" ? language : "")}</span>
        {filename && language && language !== "text" ? (
          <span className="code-lang" aria-hidden="true">
            {language}
          </span>
        ) : null}
        <span className="code-copy">
          <CopyButton value={stripShellPrompt(source)} label="Copy code" />
        </span>
      </div>

      <div
        className={cn(
          "code-scroll overflow-x-auto p-4 text-code-block [&_pre]:min-w-max [&_pre]:bg-transparent",
          showLineNumbers && "code-line-numbers",
        )}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: `html` is Shiki's own escaped output for local trusted source, produced at build time; no user input reaches it.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </figure>
  );
}
