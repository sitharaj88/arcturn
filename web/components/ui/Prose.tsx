import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The one typographic scope (DESIGN.md §2.2.3). Docs, blog posts and
 * long-form marketing all render inside it — pass either rendered markdown
 * as `html`, or JSX children.
 */
export interface ProseProps {
  html?: string;
  className?: string;
  children?: ReactNode;
}

export function Prose({ html, className, children }: ProseProps) {
  if (html !== undefined) {
    return (
      // biome-ignore lint/security/noDangerouslySetInnerHtml: `html` is local trusted markdown from this repo's .md files, sanitised and rendered to HTML by unified/rehype at build time; no user input reaches it.
      <div className={cn("prose-arc", className)} dangerouslySetInnerHTML={{ __html: html }} />
    );
  }
  return <div className={cn("prose-arc", className)}>{children}</div>;
}
