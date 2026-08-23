/** Permission engine contracts — a Arcturn differentiator over pi. */

export type PermissionAction = "allow" | "deny" | "ask";

export type PermissionScope = "session" | "project" | "user";

export interface PermissionRule {
  /** Tool name the rule applies to, or "*" for all tools. */
  tool: string;
  /**
   * Optional specifier matched against the tool's permission subject
   * (e.g. a command prefix for bash: "git *", a path glob for write: "src/**").
   */
  specifier?: string;
  action: PermissionAction;
  scope: PermissionScope;
}

export interface PermissionRequest {
  id: string;
  toolName: string;
  toolCallId: string;
  /** Subject being matched, e.g. the bash command or target path. */
  subject: string;
  /** Human-readable description of the action, shown in prompts. */
  description: string;
  /**
   * Who raised this request, when it was not the session's own agent — for a
   * `/workflow` role, `"@qa-functional · step 3"`.
   *
   * Attribution only. It never reaches the permission engine and never
   * influences a decision: `matchRules`, the mode checks and the resolution
   * order all ignore it. Its whole job is that a host can say WHO is asking,
   * because a pipeline that farms one prompt-raising session out to seven
   * roles in sequence is otherwise indistinguishable from one agent asking
   * seven times.
   *
   * Absent for an undelegated call, and hosts must render nothing at all in
   * that case — the main agent's prompt looks exactly as it did before this
   * field existed.
   */
  origin?: string;
  /** Suggested rule the user can persist when approving. */
  suggestedRule?: Omit<PermissionRule, "scope">;
}

export interface PermissionDecision {
  requestId: string;
  behavior: "allow" | "deny";
  /** When set, persist this rule so future matches skip the prompt. */
  persistRule?: PermissionRule;
  /** Optional message from the user explaining a denial (fed back to the model). */
  message?: string;
}

/**
 * Asks for permission from inside a tool, which has no request id to quote —
 * the engine assigns one. Exposed on {@link ToolExecutionContext}.
 */
export type PermissionRequester = (
  request: Omit<PermissionRequest, "id">,
) => Promise<PermissionDecision>;

/**
 * Resolves a permission request by prompting the user, implemented by hosts
 * (TUI, server, SDK embedder).
 *
 * Unlike {@link PermissionRequester} this receives the request `id`, so a host
 * that resolves decisions asynchronously — over a socket, say — can correlate
 * each decision with the request it answers rather than guessing by order.
 */
export type PermissionPrompt = (request: PermissionRequest) => Promise<PermissionDecision>;

export type PermissionMode = "default" | "acceptEdits" | "yolo" | "plan";
