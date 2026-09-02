import { hubIndex } from "@/lib/hub";

/**
 * `/hub/index.json` — the registry as one JSON document, exported at build
 * time like every other route on this site (RFC 0002: the file is the API).
 *
 * `arcturn search` reads this, and `arcturn add <name>` resolves a bare name
 * through it. Static on purpose: `force-static` makes `next build` write the
 * response to `out/hub/index.json`, so the index is exactly as fresh as the
 * pages beside it and a deploy of the site is a deploy of the index. Nothing
 * here is computed per request because nothing here runs per request.
 */
export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(hubIndex());
}
