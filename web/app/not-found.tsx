import Link from "next/link";
import { ArcHalo } from "@/components/ui/ArcHalo";
import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import { StarMark } from "@/components/ui/StarMark";

/**
 * The 404 (DESIGN.md §3.13). With `output: "export"` this emits `404.html`,
 * which static hosts serve directly — there is no catch-all route.
 */
export default function NotFound() {
  const featurePages = [
    { href: "/features/control", label: "Control" },
    { href: "/features/accountability", label: "Accountability" },
    { href: "/features/extensibility", label: "Extensibility" },
    { href: "/features/models", label: "Models & providers" },
  ];

  return (
    <Container
      size="prose"
      className="relative flex min-h-[60vh] flex-col items-center justify-center py-20 text-center"
    >
      <ArcHalo
        size={420}
        opacity={0.25}
        className="left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      />
      <div className="relative flex flex-col items-center">
        <StarMark size={64} />
        <h1 className="mt-6 text-display-2 text-balance text-text">Off course.</h1>
        <p className="mt-4 max-w-[48ch] text-lede text-muted">
          That page isn&rsquo;t here. The star is still where it was.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button href="/">Home</Button>
          <Button href="/docs" variant="ghost">
            Documentation
          </Button>
          <Button href="/blog" variant="ghost">
            Blog
          </Button>
        </div>
        <ul className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-body-sm">
          {featurePages.map((page) => (
            <li key={page.href}>
              <Link href={page.href} className="text-muted hover:text-accent">
                {page.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Container>
  );
}
