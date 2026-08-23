import { ArcHalo } from "@/components/ui/ArcHalo";
import { Button } from "@/components/ui/Button";
import { CommandChip } from "@/components/ui/CommandChip";
import { Container } from "@/components/ui/Container";
import { cn } from "@/lib/cn";
import { INSTALL_COMMAND } from "@/lib/utils";

/**
 * The closing call to action (DESIGN.md §3.1). Defaults to the home page's
 * final-CTA copy so every page can end the same way.
 */
export interface CTASectionProps {
  variant?: "default" | "compact";
  title?: string;
  lede?: string;
  showCommand?: boolean;
  /** Rarely overridden — the default is the site's one install truth. */
  command?: string;
  className?: string;
}

export function CTASection({
  variant = "default",
  title = "Every turn counts.",
  lede = "Start a session, watch every tool call ask first, then go back and read exactly what happened.",
  showCommand,
  command = INSTALL_COMMAND,
  className,
}: CTASectionProps) {
  const compact = variant === "compact";
  const withCommand = showCommand ?? !compact;

  return (
    <section
      className={cn("relative overflow-hidden", compact ? "py-16" : "py-24 md:py-28", className)}
    >
      {compact ? null : (
        <ArcHalo
          size={620}
          opacity={0.3}
          className="left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        />
      )}
      <Container size="prose" className="relative flex flex-col items-center text-center">
        <h2 className={cn("text-balance text-text", compact ? "text-h3" : "text-h2")}>{title}</h2>
        <p className="mt-4 max-w-[56ch] text-lede text-muted">{lede}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button href="/docs/getting-started" size={compact ? "md" : "lg"}>
            Get started
          </Button>
          <Button href="/docs" variant="ghost" size={compact ? "md" : "lg"}>
            Read the docs
          </Button>
        </div>
        {withCommand ? (
          <div className="mt-8 w-full max-w-md">
            <CommandChip command={command} />
          </div>
        ) : null}
      </Container>
    </section>
  );
}
