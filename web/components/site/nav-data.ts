/**
 * The site's information architecture (DESIGN.md §5.1, §5.2), shared by the
 * desktop nav, the mobile drawer and the footer so they can never drift.
 */
export interface NavLink {
  href: string;
  label: string;
  description?: string;
  external?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavLink[];
}

export const REPO = "https://github.com/sitharaj88/arcturn";

/** The Features dropdown: one panel, two labelled columns. */
export const FEATURE_GROUPS: NavGroup[] = [
  {
    label: "Capabilities",
    items: [
      {
        href: "/features/control",
        label: "Control",
        description: "Permission rules at a single choke point.",
      },
      {
        href: "/features/accountability",
        label: "Accountability",
        description: "Replay, bisect and blame a session.",
      },
      {
        href: "/features/extensibility",
        label: "Extensibility",
        description: "MCP, skills, hooks and sub-agents.",
      },
      {
        href: "/features/models",
        label: "Models & providers",
        description: "One interface across every provider.",
      },
      {
        href: "/features",
        label: "All features",
        description: "The complete list, grouped four ways.",
      },
    ],
  },
  {
    label: "Project",
    items: [
      {
        href: "/terminal",
        label: "The terminal",
        description: "What a session looks like in practice.",
      },
      {
        href: "/open-source",
        label: "Open source",
        description: "Apache-2.0, and how to check it yourself.",
      },
    ],
  },
];

/** Top-level nav items to the right of the Features dropdown. */
export const PRIMARY_NAV: NavLink[] = [
  { href: "/docs", label: "Docs" },
  { href: "/hub", label: "Hub" },
  { href: "/sdk", label: "SDK" },
  { href: "/security", label: "Security" },
  { href: "/blog", label: "Blog" },
];

export const FOOTER_COLUMNS: NavGroup[] = [
  {
    label: "Product",
    items: [
      { href: "/features/control", label: "Control" },
      { href: "/features/accountability", label: "Accountability" },
      { href: "/features/extensibility", label: "Extensibility" },
      { href: "/features/models", label: "Models & providers" },
      { href: "/terminal", label: "The terminal" },
      { href: "/features", label: "All features" },
    ],
  },
  {
    label: "Developers",
    items: [
      { href: "/docs", label: "Documentation" },
      { href: "/docs/getting-started", label: "Getting started" },
      { href: "/sdk", label: "SDK" },
      { href: "/hub", label: "Hub" },
      { href: "/docs/architecture", label: "Architecture" },
      { href: "/security", label: "Security" },
      { href: REPO, label: "GitHub", external: true },
      { href: `${REPO}/issues`, label: "Issues", external: true },
    ],
  },
  {
    label: "Project",
    items: [
      { href: "/open-source", label: "Open source" },
      { href: "/blog", label: "Blog" },
      { href: "/blog/why-arcturn", label: "Why I built Arcturn" },
      { href: `${REPO}/blob/main/LICENSE`, label: "Apache-2.0 licence", external: true },
    ],
  },
];

/**
 * True when `pathname` is inside `href`'s top-level route — the nav
 * highlights the section, not just the exact page.
 */
export function isActiveRoute(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
