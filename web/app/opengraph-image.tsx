import { ImageResponse } from "next/og";
import { ARC_PATH, STAR_PATH } from "@/components/ui/StarMark";

/**
 * The default social-share image (DESIGN.md §5.5). `output: "export"` can't
 * serve a dynamic OG route, but a file-convention `opengraph-image` with no
 * request-time params is rendered once at build time into a static asset —
 * that's supported and is what this is.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Arcturn — every turn counts.";

/** Required by `output: "export"` — this route has no per-request data. */
export const dynamic = "force-static";

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0c0a07",
        backgroundImage:
          "radial-gradient(circle at 50% 38%, rgba(242,175,72,0.22) 0%, rgba(12,10,7,0) 60%)",
        fontFamily: "sans-serif",
      }}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        width="140"
        height="140"
        viewBox="-50 -50 100 100"
        fill="none"
      >
        <path d={ARC_PATH} stroke="#f2af48" strokeWidth="7" strokeLinecap="round" />
        <path d={STAR_PATH} transform="translate(22.63 -22.63) scale(0.42)" fill="#fad185" />
      </svg>
      <div
        style={{
          marginTop: 36,
          fontSize: 76,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          color: "#f0ece5",
          display: "flex",
        }}
      >
        arcturn
      </div>
      <div
        style={{
          marginTop: 18,
          fontSize: 30,
          color: "#a8a29a",
          display: "flex",
        }}
      >
        Every turn counts.
      </div>
    </div>,
    { ...size },
  );
}
