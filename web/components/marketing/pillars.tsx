import type { LucideIcon } from "lucide-react";
import { History, Network, Puzzle, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Code } from "./Code";

/**
 * The four differentiators (DESIGN.md §1.3, §3.1). Shared by the home page and
 * `/features` so the two can never drift apart.
 */
export interface Pillar {
  icon: LucideIcon;
  title: string;
  body: ReactNode;
  href: string;
}

export const PILLARS: Pillar[] = [
  {
    icon: ShieldCheck,
    title: "Control before the fact",
    body: (
      <>
        A rule-based permission engine at a single choke point in the tool dispatcher. Allow, deny,
        ask — scoped session over project over user, with <Code>plan</Code>,{" "}
        <Code>acceptEdits</Code> and <Code>yolo</Code> modes when you want a different posture.
      </>
    ),
    href: "/features/control",
  },
  {
    icon: History,
    title: "Accountability after it",
    body: (
      <>
        The session is an append-only tree on disk, so <Code>replay</Code>, <Code>bisect</Code> and{" "}
        <Code>blame</Code> are ordinary operations — and <Code>/rewind</Code> restores files by
        forking the conversation instead of deleting it.
      </>
    ),
    href: "/features/accountability",
  },
  {
    icon: Puzzle,
    title: "Extensible without a build step",
    body: (
      <>
        MCP servers, markdown skills, shell hooks with veto power, sub-agents, file-defined
        workflows — and TypeScript custom tools when you need real code.
      </>
    ),
    href: "/features/extensibility",
  },
  {
    icon: Network,
    title: "Every provider, one interface",
    body: (
      <>
        Anthropic, OpenAI and any OpenAI-compatible endpoint, Google Gemini, Bedrock, Vertex, Azure
        — with streaming, tool calls, thinking, prompt caching and cost tracking.
      </>
    ),
    href: "/features/models",
  },
];
