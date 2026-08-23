import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The site is fully static: every route is a build-time render of local
  // markdown, so it deploys to any static host exactly like the old one did.
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
