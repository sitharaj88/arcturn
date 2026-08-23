import type { ReactNode } from "react";
import "./docs.css";

/**
 * Scopes the documentation stylesheet to `/docs/**`. There is no shared
 * chrome here on purpose: the index page is a full-width landing, and the
 * three-column shell belongs to the article route.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return children;
}
