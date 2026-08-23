import type { StatusRow } from "@/components/ui/StatusTable";

/**
 * The provider ledger — one copy, read by `/features/models` and by the home
 * page's Receipts section.
 *
 * Rows from `content/docs/providers.md`; statuses from the disclosure in
 * `content/blog/why-arcturn.md`. No status here may be upgraded without that
 * disclosure changing first.
 *
 * It lives in `lib/` rather than on either page because two hand-typed copies
 * of a ledger are two ledgers, and the one that drifts is always the one
 * nobody is looking at. A Next.js page module is also the wrong home for it:
 * importing a page from another page drags that page's `metadata` along with
 * the data.
 */
export const PROVIDER_ROWS: StatusRow[] = [
  {
    name: "openai-compatible",
    detail:
      "Any OpenAI-shaped endpoint, credentials per endpoint. Has completed real multi-turn tool-calling sessions.",
    status: { status: "proven" },
  },
  {
    name: "anthropic",
    detail:
      "Claude, direct — ANTHROPIC_API_KEY, or an OAuth subscription sign-in. Verified live on Claude Haiku 4.5.",
    status: { status: "proven" },
  },
  {
    name: "openai",
    detail: "GPT via Chat Completions — OPENAI_API_KEY. Verified live on GPT-5 nano.",
    status: { status: "proven" },
  },
  {
    name: "openai-responses",
    detail: "GPT via the Responses API — OPENAI_API_KEY. Verified live on GPT-5 nano.",
    status: { status: "proven" },
  },
  {
    name: "google",
    detail:
      "Gemini, direct — GOOGLE_API_KEY (GEMINI_API_KEY also works). Verified live on Gemini 3.5 Flash Lite.",
    status: { status: "proven" },
  },
  {
    name: "anthropic-compatible",
    detail:
      "Any Anthropic-Messages endpoint, credentials per endpoint. Verified live against a canonical Messages API; no third-party implementation exercised yet.",
    status: { status: "proven" },
  },
  {
    name: "bedrock",
    detail: "Claude, Nova, Llama, Mistral and Titan on AWS — the standard AWS provider chain.",
    status: { status: "unreached" },
  },
  {
    name: "vertex",
    detail: "Gemini and Claude on Google Cloud — application-default credentials.",
    status: { status: "unreached" },
  },
  {
    name: "azure",
    detail: "GPT on Azure OpenAI, addressed by deployment — AZURE_OPENAI_API_KEY or Entra ID.",
    status: { status: "unreached" },
  },
];

/**
 * Counted, never typed. Every sentence on the site that quotes these numbers
 * derives them here, so the prose cannot survive a row changing status
 * (DESIGN.md §0).
 */
export const PROVEN_PROVIDERS = PROVIDER_ROWS.filter(
  (row) => row.status.status === "proven",
).length;

export const UNREACHED_PROVIDERS = PROVIDER_ROWS.filter(
  (row) => row.status.status === "unreached",
).length;
