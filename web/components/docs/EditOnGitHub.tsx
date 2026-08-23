import { Pencil } from "lucide-react";
import { cn } from "@/lib/cn";
import { docEditUrl } from "@/lib/docs";

/** Link straight at the markdown that produced the page. */
export interface EditOnGitHubProps {
  slug: string;
  className?: string;
}

export function EditOnGitHub({ slug, className }: EditOnGitHubProps) {
  return (
    <a
      href={docEditUrl(slug)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex min-h-11 items-center gap-2 text-body-sm text-muted transition-colors dur-fast ease-out hover:text-accent",
        className,
      )}
    >
      <Pencil className="size-4" aria-hidden="true" />
      Edit this page on GitHub
    </a>
  );
}
