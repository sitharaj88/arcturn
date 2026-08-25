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
  ModelCatalog,
  ModelCatalogEntry,
  ModelCost,
  ModelCredentialStatus,
  PermissionDecision,
  PermissionRule,
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
      return ok<ClientRequest>({
        id,
        method: "prompt",
        params: { sessionId: params.sessionId, text: params.text },
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
      return ok<ClientRequest>({
        id,
        method: "permissionDecision",
        params: { sessionId: params.sessionId, decision: decisionResult.value },
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

const PERMISSION_ACTIONS = ["allow", "deny", "ask"] as const;
const PERMISSION_SCOPES = ["session", "project", "user"] as const;
const PERMISSION_BEHAVIORS = ["allow", "deny"] as const;

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
