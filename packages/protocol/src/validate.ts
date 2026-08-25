/**
 * Hand-rolled, exhaustive runtime validation for the two wire-protocol
 * unions defined in `@arcturn/types`: {@link ClientRequest} and
 * {@link ServerMessage}. No schema library is used (protocol is dependency-
 * free besides `@arcturn/types`); every branch of both unions is checked
 * explicitly so an unhandled variant is a compile error (see the
 * `exhaustiveCheck` calls below).
 */

import type {
  AgentEvent,
  ClientRequest,
  CommandDescriptor,
  CommandList,
  ContextKind,
  ContextResolution,
  ModelCatalog,
  ModelCatalogEntry,
  ModelCost,
  ModelCredentialStatus,
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  PermissionScope,
  PermissionState,
  PromptAttachment,
  ServerMessage,
  SessionHeader,
  SessionHistory,
} from "@arcturn/types";

/** Result of validating a value against a wire-protocol type. */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Result of {@link validateClientRequest}. */
export type ClientRequestValidation =
  | { ok: true; request: ClientRequest }
  | { ok: false; error: string };

/** Result of {@link validateServerMessage}. */
export type ServerMessageValidation =
  | { ok: true; message: ServerMessage }
  | { ok: false; error: string };

const CLIENT_METHODS = [
  "listSessions",
  "createSession",
  "openSession",
  "prompt",
  "steer",
  "abort",
  "permissionDecision",
  "setModel",
  "listModels",
  "sessionHistory",
  "deleteSession",
  "resolveContext",
  "permissionState",
  "setPermissionMode",
  "listCommands",
] as const;

const SERVER_KINDS = ["response", "event", "sessions"] as const;

/**
 * Validate that `value` is a well-formed {@link ClientRequest}. Checks the
 * `method` discriminant against every member of the union and, per method,
 * validates the shape and types of `params`.
 */
export function validateClientRequest(value: unknown): ClientRequestValidation {
  if (!isRecord(value)) {
    return fail("Request must be a JSON object");
  }
  if (!isString(value.id)) {
    return fail('Request must have a string "id" field');
  }
  const id = value.id;
  if (!isString(value.method)) {
    return fail('Request must have a string "method" field');
  }
  const method = value.method;

  if (!(CLIENT_METHODS as readonly string[]).includes(method)) {
    return fail(`Unknown method: "${method}"`);
  }

  const params = value.params;

  switch (method as (typeof CLIENT_METHODS)[number]) {
    case "listSessions": {
      return ok<ClientRequest>({ id, method: "listSessions" });
    }
    case "createSession": {
      if (!isRecord(params)) return fail('createSession requires an object "params"');
      if (!isString(params.cwd)) return fail("createSession params.cwd must be a string");
      if (params.model !== undefined && !isString(params.model)) {
        return fail("createSession params.model must be a string when present");
      }
      const model = params.model;
      return ok<ClientRequest>({
        id,
        method: "createSession",
        params: model === undefined ? { cwd: params.cwd } : { cwd: params.cwd, model },
      });
    }
    case "openSession": {
      if (!isRecord(params)) return fail('openSession requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("openSession params.sessionId must be a string");
      }
      return ok<ClientRequest>({
        id,
        method: "openSession",
        params: { sessionId: params.sessionId },
      });
    }
    case "prompt": {
      if (!isRecord(params)) return fail('prompt requires an object "params"');
      if (!isString(params.sessionId)) return fail("prompt params.sessionId must be a string");
      if (!isString(params.text)) return fail("prompt params.text must be a string");
      // Absent and empty are kept distinct on the way through: `undefined`
      // means "this client said nothing about attachments" and `[]` means "it
      // meant none", and only the first is a shape an older client produces.
      let attachments: PromptAttachment[] | undefined;
      if (params.attachments !== undefined) {
        if (!Array.isArray(params.attachments)) {
          return fail("prompt params.attachments must be an array when present");
        }
        if (params.attachments.length > MAX_PROMPT_ATTACHMENTS) {
          return fail(
            `prompt params.attachments must hold at most ${String(MAX_PROMPT_ATTACHMENTS)} items`,
          );
        }
        attachments = [];
        for (let i = 0; i < params.attachments.length; i++) {
          const result = validatePromptAttachment(params.attachments[i]);
          if (!result.ok) return fail(`prompt params.attachments[${i}] invalid: ${result.error}`);
          attachments.push(result.value);
        }
      }
      return ok<ClientRequest>({
        id,
        method: "prompt",
        params: {
          sessionId: params.sessionId,
          text: params.text,
          ...(attachments === undefined ? {} : { attachments }),
        },
      });
    }
    case "steer": {
      if (!isRecord(params)) return fail('steer requires an object "params"');
      if (!isString(params.sessionId)) return fail("steer params.sessionId must be a string");
      if (!isString(params.text)) return fail("steer params.text must be a string");
      return ok<ClientRequest>({
        id,
        method: "steer",
        params: { sessionId: params.sessionId, text: params.text },
      });
    }
    case "abort": {
      if (!isRecord(params)) return fail('abort requires an object "params"');
      if (!isString(params.sessionId)) return fail("abort params.sessionId must be a string");
      return ok<ClientRequest>({ id, method: "abort", params: { sessionId: params.sessionId } });
    }
    case "permissionDecision": {
      if (!isRecord(params)) return fail('permissionDecision requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("permissionDecision params.sessionId must be a string");
      }
      const decisionResult = validatePermissionDecision(params.decision);
      if (!decisionResult.ok) {
        return fail(`permissionDecision params.decision invalid: ${decisionResult.error}`);
      }
      // The wall RFC 0005 §1.2 asks for, enforced on the wire rather than
      // documented next to it: the only scope a remote client may ask for is
      // the one that dies with the session. `project` and `user` are the
      // scopes `persistPermissionRule` writes to a config file a *person*
      // owns, and no frame on this socket gets to author one.
      //
      // Checked here rather than inside `validatePermissionDecision`, which is
      // a general validator for a type local hosts also build: the restriction
      // is a property of this VERB, not of the shape. And checked on both
      // ends, because the client validates its own outbound frames — a UI bug
      // fails immediately with a precise message instead of after a round trip.
      if (decisionResult.value.persistRule !== undefined) {
        const ruleScope = decisionResult.value.persistRule.scope;
        if (ruleScope !== "session") {
          return fail(rejectWiderScope("params.decision.persistRule.scope", ruleScope));
        }
      }
      let scope: PermissionScope | undefined;
      if (params.scope !== undefined) {
        if (
          !isString(params.scope) ||
          !(PERMISSION_SCOPES as readonly string[]).includes(params.scope)
        ) {
          return fail(
            'permissionDecision params.scope must be one of "session" | "project" | "user"',
          );
        }
        if (params.scope !== "session") {
          return fail(rejectWiderScope("params.scope", params.scope as PermissionScope));
        }
        scope = params.scope as PermissionScope;
      }
      return ok<ClientRequest>({
        id,
        method: "permissionDecision",
        params: {
          sessionId: params.sessionId,
          decision: decisionResult.value,
          ...(scope === undefined ? {} : { scope }),
        },
      });
    }
    case "setModel": {
      if (!isRecord(params)) return fail('setModel requires an object "params"');
      if (!isString(params.sessionId)) return fail("setModel params.sessionId must be a string");
      if (!isString(params.model)) return fail("setModel params.model must be a string");
      return ok<ClientRequest>({
        id,
        method: "setModel",
        params: { sessionId: params.sessionId, model: params.model },
      });
    }
    case "listModels": {
      // No params: the catalog is a property of the server, not of a session.
      return ok<ClientRequest>({ id, method: "listModels" });
    }
    case "sessionHistory": {
      if (!isRecord(params)) return fail('sessionHistory requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("sessionHistory params.sessionId must be a string");
      }
      return ok<ClientRequest>({
        id,
        method: "sessionHistory",
        params: { sessionId: params.sessionId },
      });
    }
    case "deleteSession": {
      if (!isRecord(params)) return fail('deleteSession requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("deleteSession params.sessionId must be a string");
      }
      return ok<ClientRequest>({
        id,
        method: "deleteSession",
        params: { sessionId: params.sessionId },
      });
    }
    case "resolveContext": {
      if (!isRecord(params)) return fail('resolveContext requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("resolveContext params.sessionId must be a string");
      }
      if (!isString(params.query)) return fail("resolveContext params.query must be a string");
      if (params.query.length > MAX_CONTEXT_QUERY_LENGTH) {
        return fail(
          `resolveContext params.query must be at most ${String(MAX_CONTEXT_QUERY_LENGTH)} characters`,
        );
      }
      return ok<ClientRequest>({
        id,
        method: "resolveContext",
        params: { sessionId: params.sessionId, query: params.query },
      });
    }
    case "permissionState": {
      if (!isRecord(params)) return fail('permissionState requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("permissionState params.sessionId must be a string");
      }
      return ok<ClientRequest>({
        id,
        method: "permissionState",
        params: { sessionId: params.sessionId },
      });
    }
    case "setPermissionMode": {
      if (!isRecord(params)) return fail('setPermissionMode requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("setPermissionMode params.sessionId must be a string");
      }
      if (
        !isString(params.mode) ||
        !(PERMISSION_MODES as readonly string[]).includes(params.mode)
      ) {
        return fail(
          'setPermissionMode params.mode must be one of "default" | "acceptEdits" | "plan" | "yolo"',
        );
      }
      return ok<ClientRequest>({
        id,
        method: "setPermissionMode",
        params: { sessionId: params.sessionId, mode: params.mode as PermissionMode },
      });
    }
    case "listCommands": {
      // No params: skills are discovered from the served workspace and the
      // user's home, both properties of the server, not of a conversation.
      return ok<ClientRequest>({ id, method: "listCommands" });
    }
    default:
      return exhaustiveCheck(method as never, `Unknown method: "${method}"`);
  }
}

/**
 * Validate that `value` is a well-formed {@link ServerMessage}. Checks the
 * `kind` discriminant against every member of the union. `AgentEvent`
 * payloads (the `event` kind's `event` field) are only shallow-validated —
 * an object with a string `type` field — per the protocol package's brief;
 * deep validation of every `AgentEvent` variant is the runtime's job, not
 * the wire layer's.
 */
export function validateServerMessage(value: unknown): ServerMessageValidation {
  if (!isRecord(value)) {
    return fail("Message must be a JSON object");
  }
  if (!isString(value.kind)) {
    return fail('Message must have a string "kind" field');
  }
  const kind = value.kind;

  if (!(SERVER_KINDS as readonly string[]).includes(kind)) {
    return fail(`Unknown kind: "${kind}"`);
  }

  switch (kind as (typeof SERVER_KINDS)[number]) {
    case "response": {
      if (!isString(value.id)) return fail('response message requires a string "id"');
      const hasResult = Object.hasOwn(value, "result");
      const hasError = Object.hasOwn(value, "error");
      if (hasResult && hasError) {
        return fail('response message must not have both "result" and "error"');
      }
      if (hasError) {
        if (!isRecord(value.error)) return fail('response "error" must be an object');
        if (!isString(value.error.code)) return fail("response error.code must be a string");
        if (!isString(value.error.message)) {
          return fail("response error.message must be a string");
        }
        return okMessage({
          kind: "response",
          id: value.id,
          error: { code: value.error.code, message: value.error.message },
        });
      }
      if (!hasResult) {
        return fail('response message must have either "result" or "error"');
      }
      return okMessage({ kind: "response", id: value.id, result: value.result });
    }
    case "event": {
      if (!isString(value.sessionId)) return fail('event message requires a string "sessionId"');
      if (!isRecord(value.event) || !isString(value.event.type)) {
        return fail('event message requires "event" to be an object with a string "type"');
      }
      return okMessage({
        kind: "event",
        sessionId: value.sessionId,
        // Shallow-validated only (object with a string `type`); see doc comment above.
        event: value.event as AgentEvent,
      });
    }
    case "sessions": {
      if (!Array.isArray(value.sessions)) {
        return fail('sessions message requires an array "sessions"');
      }
      const sessions: SessionHeader[] = [];
      for (let i = 0; i < value.sessions.length; i++) {
        const headerResult = validateSessionHeader(value.sessions[i]);
        if (!headerResult.ok) {
          return fail(`sessions[${i}] invalid: ${headerResult.error}`);
        }
        sessions.push(headerResult.value);
      }
      return okMessage({ kind: "sessions", sessions });
    }
    default:
      return exhaustiveCheck(kind as never, `Unknown kind: "${kind}"`);
  }
}

// ---------------------------------------------------------------------------
// Nested-shape validators (not part of the public two-function contract, but
// exported since they're independently useful and fully general).
// ---------------------------------------------------------------------------

/**
 * Ceiling on how many attachments one prompt may carry.
 *
 * A second bound alongside the server's byte budget
 * (`PROMPT_ATTACHMENT_MAX_BYTES`), because the two costs differ: bytes are what
 * the wire and the model pay, item count is what the *engine* pays in stat and
 * read syscalls before a single byte is counted. 64 is far past any composer's
 * chip row and far short of a `prompt` frame that makes this server walk a
 * directory tree on a client's say-so.
 */
export const MAX_PROMPT_ATTACHMENTS = 64;

/**
 * Ceiling on a `resolveContext` query.
 *
 * A mention is a path, and 4096 is the practical path ceiling on every
 * platform this runs on (`PATH_MAX` on Linux/macOS, well past Windows' own).
 * Bounded because the verb is reachable by anyone holding the serve token and
 * an unbounded string is one this server would resolve and normalize before it
 * had any reason to.
 */
export const MAX_CONTEXT_QUERY_LENGTH = 4096;

/**
 * Image media types an `image` attachment may declare inline.
 *
 * Mirrors `@arcturn/cli`'s `IMAGE_MIME_TYPES` — the set `expandMentions`
 * already turns into vision blocks. An allowlist rather than a `image/*` shape
 * check, because the value is forwarded to a provider: a type this engine
 * cannot actually send is better refused at the wire than discovered as a 400
 * from someone else's API.
 */
const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const CONTEXT_KINDS = ["file", "image", "directory", "missing", "other"] as const;

/**
 * Validate one {@link PromptAttachment}.
 *
 * The three branches are checked by *shape*, not by trusting `kind` alone, and
 * a `file` carrying inline `data` is refused rather than quietly reduced to its
 * path: RFC 0005 §3 puts every file read inside the engine, and accepting bytes
 * for something that claims to be a workspace file would be the one hole in
 * that. Inline data is an `image`-only affordance — a paste has no path, and so
 * has no confinement to bypass.
 */
export function validatePromptAttachment(value: unknown): ValidationResult<PromptAttachment> {
  if (!isRecord(value)) return fail("PromptAttachment must be an object");
  const kind = value.kind;
  if (kind !== "file" && kind !== "image") {
    return fail('PromptAttachment.kind must be one of "file" | "image"');
  }
  const hasPath = value.path !== undefined;
  const hasData = value.data !== undefined;
  if (hasPath === hasData) {
    return fail('PromptAttachment must carry exactly one of "path" or "data"');
  }
  if (hasPath) {
    if (!isString(value.path)) return fail("PromptAttachment.path must be a string");
    if (value.path === "") return fail("PromptAttachment.path must not be empty");
    if (value.path.length > MAX_CONTEXT_QUERY_LENGTH) {
      return fail(
        `PromptAttachment.path must be at most ${String(MAX_CONTEXT_QUERY_LENGTH)} characters`,
      );
    }
    const attachment: PromptAttachment =
      kind === "file" ? { kind: "file", path: value.path } : { kind: "image", path: value.path };
    return { ok: true, value: attachment };
  }
  if (kind !== "image") {
    return fail(
      'PromptAttachment inline "data" is accepted for kind "image" only — a file that exists ' +
        "on disk is read by the engine, from its path, so the read happens where the " +
        "permission engine can see it",
    );
  }
  if (!isString(value.data)) return fail("PromptAttachment.data must be a base64 string");
  if (value.data === "") return fail("PromptAttachment.data must not be empty");
  if (!isString(value.mimeType)) {
    return fail("PromptAttachment.mimeType must be a string when data is present");
  }
  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(value.mimeType)) {
    return fail(`PromptAttachment.mimeType must be one of ${IMAGE_MIME_TYPES.join(", ")}`);
  }
  return { ok: true, value: { kind: "image", data: value.data, mimeType: value.mimeType } };
}

/**
 * Validate a `resolveContext` result.
 *
 * Run at both ends, like {@link validateModelCatalog} and
 * {@link validateSessionHistory}, and with fields copied out one at a time so a
 * server that puts something extra in the envelope cannot have it ride along
 * into a client that renders it.
 *
 * Two cross-field rules are enforced rather than left to a client to reconcile,
 * because each has exactly one honest reading and a client guessing at the
 * other would tell a user something false:
 *
 * - A path outside the workspace can never report `exists: true`. The engine
 *   does not look at one, so a `true` there would be a fact it never
 *   established.
 * - Nothing that does not exist has a size.
 */
export function validateContextResolution(value: unknown): ValidationResult<ContextResolution> {
  if (!isRecord(value)) return fail("ContextResolution must be an object");
  if (!isString(value.query)) return fail("ContextResolution.query must be a string");
  if (!isString(value.path)) return fail("ContextResolution.path must be a string");
  if (!isString(value.relativePath)) return fail("ContextResolution.relativePath must be a string");
  if (typeof value.inWorkspace !== "boolean") {
    return fail("ContextResolution.inWorkspace must be a boolean");
  }
  if (typeof value.exists !== "boolean") return fail("ContextResolution.exists must be a boolean");
  if (!isNumber(value.bytes) || value.bytes < 0) {
    return fail("ContextResolution.bytes must be a non-negative number");
  }
  if (!isString(value.kind) || !(CONTEXT_KINDS as readonly string[]).includes(value.kind)) {
    return fail(
      'ContextResolution.kind must be one of "file" | "image" | "directory" | "missing" | "other"',
    );
  }
  if (value.reason !== undefined && !isString(value.reason)) {
    return fail("ContextResolution.reason must be a string when present");
  }
  if (!value.inWorkspace && value.exists) {
    return fail("ContextResolution.exists must be false when inWorkspace is false");
  }
  if (!value.exists && value.bytes !== 0) {
    return fail("ContextResolution.bytes must be 0 when exists is false");
  }
  return {
    ok: true,
    value: {
      query: value.query,
      path: value.path,
      relativePath: value.relativePath,
      inWorkspace: value.inWorkspace,
      exists: value.exists,
      bytes: value.bytes,
      kind: value.kind as ContextKind,
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    },
  };
}

const PERMISSION_ACTIONS = ["allow", "deny", "ask"] as const;
const PERMISSION_SCOPES = ["session", "project", "user"] as const;
const PERMISSION_BEHAVIORS = ["allow", "deny"] as const;
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "yolo"] as const;

/**
 * The one refusal message for every way a frame can ask for a rule that
 * outlives its session.
 *
 * Written out rather than left as `"invalid scope"` because the person reading
 * it is a client author who believed this was allowed, and the useful part is
 * not "no" but *where the thing they want does live*.
 *
 * @param field - The offending field, for the message.
 * @param scope - The scope that was asked for.
 */
function rejectWiderScope(field: string, scope: PermissionScope): string {
  return (
    `permissionDecision ${field} must be "session": a decision made over the wire may not ` +
    `outlive the session, and "${scope}" would be written to a permission config file that a ` +
    "person owns. Grant it for this session, or have the user add the rule to their own config."
  );
}

/** Validate a {@link PermissionRule} value. */
export function validatePermissionRule(value: unknown): ValidationResult<PermissionRule> {
  if (!isRecord(value)) return fail("PermissionRule must be an object");
  if (!isString(value.tool)) return fail("PermissionRule.tool must be a string");
  if (value.specifier !== undefined && !isString(value.specifier)) {
    return fail("PermissionRule.specifier must be a string when present");
  }
  if (
    !isString(value.action) ||
    !(PERMISSION_ACTIONS as readonly string[]).includes(value.action)
  ) {
    return fail('PermissionRule.action must be one of "allow" | "deny" | "ask"');
  }
  if (!isString(value.scope) || !(PERMISSION_SCOPES as readonly string[]).includes(value.scope)) {
    return fail('PermissionRule.scope must be one of "session" | "project" | "user"');
  }
  const rule: PermissionRule = {
    tool: value.tool,
    action: value.action as PermissionRule["action"],
    scope: value.scope as PermissionRule["scope"],
    ...(value.specifier !== undefined ? { specifier: value.specifier } : {}),
  };
  return { ok: true, value: rule };
}

/** Validate a {@link PermissionDecision} value. */
export function validatePermissionDecision(value: unknown): ValidationResult<PermissionDecision> {
  if (!isRecord(value)) return fail("PermissionDecision must be an object");
  if (!isString(value.requestId)) return fail("PermissionDecision.requestId must be a string");
  if (
    !isString(value.behavior) ||
    !(PERMISSION_BEHAVIORS as readonly string[]).includes(value.behavior)
  ) {
    return fail('PermissionDecision.behavior must be one of "allow" | "deny"');
  }
  let persistRule: PermissionRule | undefined;
  if (value.persistRule !== undefined) {
    const ruleResult = validatePermissionRule(value.persistRule);
    if (!ruleResult.ok) return fail(`PermissionDecision.persistRule invalid: ${ruleResult.error}`);
    persistRule = ruleResult.value;
  }
  if (value.message !== undefined && !isString(value.message)) {
    return fail("PermissionDecision.message must be a string when present");
  }
  const decision: PermissionDecision = {
    requestId: value.requestId,
    behavior: value.behavior as PermissionDecision["behavior"],
    ...(persistRule !== undefined ? { persistRule } : {}),
    ...(value.message !== undefined ? { message: value.message } : {}),
  };
  return { ok: true, value: decision };
}

/** Validate a {@link SessionHeader} value. */
export function validateSessionHeader(value: unknown): ValidationResult<SessionHeader> {
  if (!isRecord(value)) return fail("SessionHeader must be an object");
  if (value.version !== 1) return fail("SessionHeader.version must be 1");
  if (!isString(value.sessionId)) return fail("SessionHeader.sessionId must be a string");
  if (!isString(value.cwd)) return fail("SessionHeader.cwd must be a string");
  if (!isNumber(value.createdAt)) return fail("SessionHeader.createdAt must be a number");
  if (value.title !== undefined && !isString(value.title)) {
    return fail("SessionHeader.title must be a string when present");
  }
  const header: SessionHeader = {
    version: 1,
    sessionId: value.sessionId,
    cwd: value.cwd,
    createdAt: value.createdAt,
    ...(value.title !== undefined ? { title: value.title } : {}),
  };
  return { ok: true, value: header };
}

const CREDENTIAL_STATUSES = ["present", "absent", "unknown"] as const;

/** Validate a {@link ModelCost} value: USD per million tokens. */
export function validateModelCost(value: unknown): ValidationResult<ModelCost> {
  if (!isRecord(value)) return fail("ModelCost must be an object");
  if (!isNumber(value.input)) return fail("ModelCost.input must be a number");
  if (!isNumber(value.output)) return fail("ModelCost.output must be a number");
  for (const key of ["cacheRead", "cacheWrite"] as const) {
    if (value[key] !== undefined && !isNumber(value[key])) {
      return fail(`ModelCost.${key} must be a number when present`);
    }
  }
  const cost: ModelCost = { input: value.input, output: value.output };
  if (value.cacheRead !== undefined) cost.cacheRead = value.cacheRead as number;
  if (value.cacheWrite !== undefined) cost.cacheWrite = value.cacheWrite as number;
  return { ok: true, value: cost };
}

/**
 * Validate one {@link ModelCatalogEntry}.
 *
 * Fields are copied out one by one rather than spread: anything the contract
 * does not define is dropped here, so a server that puts something extra on
 * the wire — a credential value being the case that matters — cannot have it
 * ride along into a client that renders the entry.
 *
 * An absent `cost` is preserved as absent. It means "nobody published a
 * price", which is not `{ input: 0, output: 0 }`; see
 * {@link ModelCatalogEntry.cost}.
 */
export function validateModelCatalogEntry(value: unknown): ValidationResult<ModelCatalogEntry> {
  if (!isRecord(value)) return fail("ModelCatalogEntry must be an object");
  if (!isString(value.id)) return fail("ModelCatalogEntry.id must be a string");
  if (!isString(value.provider)) return fail("ModelCatalogEntry.provider must be a string");
  if (!isString(value.displayName)) return fail("ModelCatalogEntry.displayName must be a string");
  if (!isNumber(value.contextWindow)) {
    return fail("ModelCatalogEntry.contextWindow must be a number");
  }
  if (value.maxOutputTokens !== undefined && !isNumber(value.maxOutputTokens)) {
    return fail("ModelCatalogEntry.maxOutputTokens must be a number when present");
  }
  if (value.apiKeyEnv !== undefined && !isString(value.apiKeyEnv)) {
    return fail("ModelCatalogEntry.apiKeyEnv must be a string when present");
  }
  if (
    !isString(value.credentials) ||
    !(CREDENTIAL_STATUSES as readonly string[]).includes(value.credentials)
  ) {
    return fail('ModelCatalogEntry.credentials must be one of "present" | "absent" | "unknown"');
  }
  let cost: ModelCost | undefined;
  if (value.cost !== undefined) {
    const costResult = validateModelCost(value.cost);
    if (!costResult.ok) return fail(`ModelCatalogEntry.cost invalid: ${costResult.error}`);
    cost = costResult.value;
  }
  const entry: ModelCatalogEntry = {
    id: value.id,
    provider: value.provider,
    displayName: value.displayName,
    contextWindow: value.contextWindow,
    credentials: value.credentials as ModelCredentialStatus,
    ...(value.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: value.maxOutputTokens as number }),
    ...(cost === undefined ? {} : { cost }),
    ...(value.apiKeyEnv === undefined ? {} : { apiKeyEnv: value.apiKeyEnv }),
  };
  return { ok: true, value: entry };
}

/**
 * Validate a `listModels` result.
 *
 * The server answers `{ models: [...] }`; a bare array is also accepted, the
 * same latitude {@link ProtocolClient.listSessions}'s payload parser gives a
 * leaner server variant.
 */
export function validateModelCatalog(value: unknown): ValidationResult<ModelCatalog> {
  const raw = Array.isArray(value) ? value : isRecord(value) ? value.models : undefined;
  if (!Array.isArray(raw)) {
    return fail('ModelCatalog must be an array of entries or an object with a "models" array');
  }
  const models: ModelCatalogEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entryResult = validateModelCatalogEntry(raw[i]);
    if (!entryResult.ok) return fail(`models[${i}] invalid: ${entryResult.error}`);
    models.push(entryResult.value);
  }
  return { ok: true, value: { models } };
}

/**
 * Validate a `sessionHistory` result.
 *
 * Run at **both** ends, exactly as {@link validateModelCatalog} is: the server
 * re-validates the payload it built before it leaves the host, and the client
 * re-validates what arrived before it hands it to a caller. Fields are copied
 * out one at a time rather than spread, so a server that puts something extra
 * in the envelope cannot have it ride along into a client.
 *
 * The `events` array is **shallow**-validated — each element must be an object
 * with a string `type` — which is the same latitude {@link validateServerMessage}
 * gives the `event` kind's payload, and for the same reason stated in this
 * module's doc: deep validation of every {@link AgentEvent} variant is the
 * runtime's job, not the wire layer's. Applying a stricter rule here than to
 * the live stream would mean an event that is fine to push is not fine to
 * replay, which is precisely the drift replaying events exists to avoid.
 */
export function validateSessionHistory(value: unknown): ValidationResult<SessionHistory> {
  if (!isRecord(value)) return fail("SessionHistory must be an object");
  if (!isString(value.sessionId)) return fail("SessionHistory.sessionId must be a string");
  if (!Array.isArray(value.events)) return fail("SessionHistory.events must be an array");
  if (typeof value.truncated !== "boolean") {
    return fail("SessionHistory.truncated must be a boolean");
  }
  if (!isNumber(value.droppedEvents) || value.droppedEvents < 0) {
    return fail("SessionHistory.droppedEvents must be a non-negative number");
  }
  if (!value.truncated && value.droppedEvents !== 0) {
    // A payload claiming nothing was dropped while reporting a count is one a
    // client would render one of two contradictory ways. Neither is safe to
    // guess, and the honest reading — "this peer is confused" — is a failure.
    return fail("SessionHistory.droppedEvents must be 0 when truncated is false");
  }
  const events: AgentEvent[] = [];
  for (let i = 0; i < value.events.length; i++) {
    const event: unknown = value.events[i];
    if (!isRecord(event) || !isString(event.type)) {
      return fail(`events[${i}] must be an object with a string "type"`);
    }
    // Shallow-validated only; see the doc comment above.
    events.push(event as AgentEvent);
  }
  return {
    ok: true,
    value: {
      sessionId: value.sessionId,
      events,
      truncated: value.truncated,
      droppedEvents: value.droppedEvents,
    },
  };
}

/**
 * Validate a `permissionState` (or `setPermissionMode`) result.
 *
 * Run at **both** ends, exactly as {@link validateModelCatalog} is: the host
 * re-validates what it built before it leaves, and the client re-validates
 * what arrived. Fields are copied out one at a time rather than spread, for
 * the reason {@link validateModelCatalogEntry} states — whatever else a host
 * happens to hang off its state object cannot ride along into a client. Here
 * the field that matters is `tools`: it carries tool *names* and must never
 * start carrying descriptions or schemas, which is a thing a copy-one-field-
 * at-a-time validator makes impossible rather than merely discouraged.
 */
export function validatePermissionState(value: unknown): ValidationResult<PermissionState> {
  if (!isRecord(value)) return fail("PermissionState must be an object");
  if (!isString(value.sessionId)) return fail("PermissionState.sessionId must be a string");
  if (!isString(value.mode) || !(PERMISSION_MODES as readonly string[]).includes(value.mode)) {
    return fail('PermissionState.mode must be one of "default" | "acceptEdits" | "plan" | "yolo"');
  }
  if (!Array.isArray(value.rules)) return fail("PermissionState.rules must be an array");
  const rules: PermissionRule[] = [];
  for (let i = 0; i < value.rules.length; i++) {
    const result = validatePermissionRule(value.rules[i]);
    if (!result.ok) return fail(`PermissionState.rules[${i}] invalid: ${result.error}`);
    rules.push(result.value);
  }
  if (!Array.isArray(value.tools)) return fail("PermissionState.tools must be an array");
  const tools: string[] = [];
  for (let i = 0; i < value.tools.length; i++) {
    const name: unknown = value.tools[i];
    if (!isString(name)) return fail(`PermissionState.tools[${i}] must be a string`);
    tools.push(name);
  }
  return {
    ok: true,
    value: { sessionId: value.sessionId, mode: value.mode as PermissionMode, rules, tools },
  };
}

const COMMAND_KINDS = ["skill", "builtin"] as const;

/** Validate one {@link CommandDescriptor}. */
export function validateCommandDescriptor(value: unknown): ValidationResult<CommandDescriptor> {
  if (!isRecord(value)) return fail("CommandDescriptor must be an object");
  if (!isString(value.name) || value.name === "") {
    return fail("CommandDescriptor.name must be a non-empty string");
  }
  if (!isString(value.description)) {
    return fail("CommandDescriptor.description must be a string");
  }
  if (!isString(value.kind) || !(COMMAND_KINDS as readonly string[]).includes(value.kind)) {
    return fail('CommandDescriptor.kind must be one of "skill" | "builtin"');
  }
  if (value.source !== undefined && !isString(value.source)) {
    return fail("CommandDescriptor.source must be a string when present");
  }
  const descriptor: CommandDescriptor = {
    name: value.name,
    description: value.description,
    kind: value.kind as CommandDescriptor["kind"],
    ...(value.source === undefined ? {} : { source: value.source }),
  };
  return { ok: true, value: descriptor };
}

/**
 * Validate a `listCommands` result.
 *
 * The server answers `{ commands: [...] }`; a bare array is also accepted, the
 * same latitude {@link validateModelCatalog} gives a leaner server variant.
 */
export function validateCommandList(value: unknown): ValidationResult<CommandList> {
  const raw = Array.isArray(value) ? value : isRecord(value) ? value.commands : undefined;
  if (!Array.isArray(raw)) {
    return fail('CommandList must be an array of commands or an object with a "commands" array');
  }
  const commands: CommandDescriptor[] = [];
  for (let i = 0; i < raw.length; i++) {
    const result = validateCommandDescriptor(raw[i]);
    if (!result.ok) return fail(`commands[${i}] invalid: ${result.error}`);
    commands.push(result.value);
  }
  return { ok: true, value: { commands } };
}

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function ok<T>(request: T): { ok: true; request: T } {
  return { ok: true, request };
}

function okMessage(message: ServerMessage): { ok: true; message: ServerMessage } {
  return { ok: true, message };
}

/**
 * Compile-time exhaustiveness guard: if a new branch is added to
 * `ClientRequest["method"]` or `ServerMessage["kind"]` without a matching
 * `case` above, this call fails to type-check `_value as never`.
 */
function exhaustiveCheck(_value: never, error: string): { ok: false; error: string } {
  return { ok: false, error };
}
