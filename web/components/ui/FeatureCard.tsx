import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Card } from "./Card";

/** A pillar: icon, title, body, and the link out to its feature page. */
export interface FeatureCardProps {
  icon: LucideIcon;
  title: string;
  body: ReactNode;
  href: string;
  size?: "md" | "lg";
  cta?: string;
  className?: string;
}

export function FeatureCard({
  icon: Icon,
  title,
  body,
  href,
  size = "md",
  cta = "Explore",
  className,
}: FeatureCardProps) {
  return (
    <Card href={href} className={cn("group flex flex-col", size === "lg" && "sm:p-8", className)}>
      <span
        aria-hidden="true"
        className="inline-flex size-10 items-center justify-center rounded-md border border-accent-edge bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] text-accent"
      >
        <Icon className="size-5" />
      </span>
      <h3 className={cn("mt-4 text-text", size === "lg" ? "text-h3" : "text-h4")}>{title}</h3>
      <p className="mt-2 text-body-sm text-muted">{body}</p>
      <span className="mt-5 inline-flex items-center gap-1.5 text-body-sm font-medium text-accent">
        {cta}
        <ArrowRight
          aria-hidden="true"
          className="size-4 transition-transform dur-fast ease-out group-hover:translate-x-0.5"
        />
      </span>
    </Card>
  );
}
