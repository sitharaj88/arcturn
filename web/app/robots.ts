import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/utils";

/** Required by `output: "export"` — this route has no per-request data. */
export const dynamic = "force-static";

/** Statically exportable robots.txt (DESIGN.md §5.5). */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
