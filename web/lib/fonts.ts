/**
 * Self-hosted webfonts (DESIGN.md §2.2.1).
 *
 * `next/font/google` downloads and inlines the faces at build time, so the
 * browser never makes a request to fonts.googleapis.com. Both families are
 * exposed as CSS variables consumed by `--font-sans` / `--font-mono`.
 */
import { Inter, JetBrains_Mono } from "next/font/google";

export const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
  weight: ["400", "500", "600", "700"],
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains",
  weight: ["400", "500", "600"],
});

/** Class string applied to `<html>` to publish both font variables. */
export const fontVariables = `${inter.variable} ${jetbrainsMono.variable}`;
