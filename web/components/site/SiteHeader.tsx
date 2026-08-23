import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { GitHubLink } from "./GitHubLink";
import { Logo } from "./Logo";
import { MobileNav } from "./MobileNav";
import { NavMenu } from "./NavMenu";
import { ScrollState } from "./ScrollState";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The sticky site chrome (DESIGN.md §3): 4rem tall, translucent over a blur,
 * fully opaque once the page has scrolled past 8px.
 */
export function SiteHeader({ className }: { className?: string }) {
  return (
    <header
      data-site-header
      className={cn("sticky top-0 z-[70] border-b border-default backdrop-blur-md", className)}
    >
      <ScrollState />
      <div className="container-wide flex h-16 items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-6">
          <Logo />
          <nav aria-label="Main" className="hidden lg:block">
            <NavMenu />
          </nav>
        </div>

        <div className="flex items-center gap-1">
          <ThemeToggle />
          <GitHubLink className="hidden sm:inline-flex" />
          <Button href="/docs/getting-started" size="sm" className="hidden lg:inline-flex">
            Get started
          </Button>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
