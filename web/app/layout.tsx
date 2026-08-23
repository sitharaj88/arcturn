import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SkipLink } from "@/components/site/SkipLink";
import { fontVariables } from "@/lib/fonts";
import { SITE_URL } from "@/lib/utils";
import "./globals.css";

const DESCRIPTION =
  "Arcturn is an open-source TypeScript coding agent and the harness underneath it. " +
  "Every tool call clears a permission engine before it runs, every edit is snapshotted " +
  "before it lands, and every session is a file on disk you can replay, bisect and blame.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Arcturn — Every turn counts.",
    template: "%s — Arcturn",
  },
  description: DESCRIPTION,
  applicationName: "Arcturn",
  authors: [{ name: "Sitharaj Seenivasan", url: "https://sitharaj.in" }],
  creator: "Sitharaj Seenivasan",
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Arcturn — Every turn counts.",
    description: DESCRIPTION,
    url: SITE_URL,
    locale: "en",
    // No `images` here on purpose: a page that declares its own `openGraph`
    // replaces this object wholesale, and thirteen of them do. The share image
    // is the `app/opengraph-image.png` file convention instead — that one is
    // inherited by every segment and survives the override. It is a committed
    // PNG rather than the `opengraph-image.tsx` route it replaces, because the
    // route emitted an extension-less asset that static hosts label
    // application/octet-stream and every social crawler then refuses.
  },
  twitter: {
    card: "summary_large_image",
    title: "Arcturn — Every turn counts.",
    description: DESCRIPTION,
  },
  manifest: "/site.webmanifest",
  // Relative: Next resolves it per route against `metadataBase`, so every page
  // gets its own canonical (with the `trailingSlash` the export actually
  // serves). Per-page `alternates` still win over this.
  alternates: { canonical: "./" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0c0a07" },
    { media: "(prefers-color-scheme: light)", color: "#faf8f4" },
  ],
};

/**
 * Runs before first paint, so a returning reader never sees a frame of the
 * wrong theme. Absence of the attribute is meaningful: it hands the decision
 * back to `prefers-color-scheme` (DESIGN.md §2.7).
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem("arcturn-theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: THEME_SCRIPT is a build-time constant in this file — the only way to run the no-flash theme script before first paint; no user input reaches it. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <SkipLink />
        <SiteHeader />
        <main id="content">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
