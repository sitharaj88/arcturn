import { codeToHtml } from "shiki";
import { cn } from "@/lib/cn";
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
        "group relative overflow-hidden rounded-md border border-default bg-surface-inset",
        className,
      )}
    >
      <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-2">
        {language && language !== "text" ? (
          <span className="rounded-full border border-default bg-surface-card px-2 py-0.5 text-caption uppercase tracking-wide text-faint">
            {language}
          </span>
        ) : null}
        <span className="pointer-events-auto opacity-100 transition-opacity dur-fast ease-out md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
          <CopyButton value={stripShellPrompt(source)} label="Copy code" />
        </span>
      </div>

      {filename ? (
        <figcaption className="border-b border-default px-4 py-2 font-mono text-caption text-faint">
          {filename}
        </figcaption>
      ) : null}

      <div
        className={cn(
          "overflow-x-auto px-4 py-4 text-code-block [&_pre]:min-w-max [&_pre]:bg-transparent",
          showLineNumbers && "code-line-numbers",
        )}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: `html` is Shiki's own escaped output for local trusted source, produced at build time; no user input reaches it.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </figure>
  );
}
