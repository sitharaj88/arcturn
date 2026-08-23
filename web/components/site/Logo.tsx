import Link from "next/link";
import { StarMark } from "@/components/ui/StarMark";
import { cn } from "@/lib/cn";

/** The wordmark. Weight 700 is reserved for this and `<strong>`. */
export interface LogoProps {
  size?: number;
  showWordmark?: boolean;
  href?: string;
  className?: string;
}

export function Logo({ size = 26, showWordmark = true, href = "/", className }: LogoProps) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-2.5 text-text transition-colors dur-fast ease-out hover:text-accent",
        className,
      )}
    >
      <StarMark size={size} />
      {showWordmark ? (
        <span className="text-[1.0625rem] font-bold tracking-[-0.02em]">arcturn</span>
      ) : (
        <span className="sr-only">Arcturn</span>
      )}
    </Link>
  );
}
