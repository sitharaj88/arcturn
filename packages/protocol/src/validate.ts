/**
 * Hand-rolled, exhaustive runtime validation for the two wire-protocol
 * unions defined in `@arcturn/types`: {@link ClientRequest} and
 * {@link ServerMessage}. No schema library is used (protocol is dependency-
 * free besides `@arcturn/types`); every branch of both unions is checked
 * explicitly so an unhandled variant is a compile error (see the
 * `exhaustiveCheck` calls below).
 */

import type {
  AdoptBackgroundAgentResult,
  AgentEvent,
  ApplyChangeFailure,
  ApplyChangesResult,
  BackgroundAgentList,
  BackgroundAgentState,
  BackgroundAgentSummary,
  BackgroundAgentTranscript,
  CancelBackgroundAgentResult,
  CheckpointEntry,
  CheckpointList,
  ClientRequest,
  CommandDescriptor,
  CommandList,
  CompactionSummary,
  ContextKind,
  ContextResolution,
  DiscardChangesResult,
  LineRange,
  McpConnectionState,
  McpServerSummary,
  McpStatus,
  McpTransport,
  ModelCatalog,
  ModelCatalogEntry,
  ModelCost,
  ModelCredentialStatus,
  OrgMemoryEntry,
  OrgMemoryList,
  OrgMemoryProposal,
  OrgMemoryStatus,
  PendingChange,
  PendingChanges,
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  PermissionScope,
  PermissionState,
  PromptAttachment,
  PromptAttachmentKind,
  RewindFailure,
  RewindResult,
  ServerCapabilities,
  ServerMessage,
  SessionExport,
  SessionHeader,
  SessionHistory,
  StartedBackgroundAgent,
  TranscriptFormat,
  WorkflowCatalog,
  WorkflowRoleLane,
  WorkflowRoleSummary,
  WorkflowRunHandle,
  WorkflowRunQuestion,
  WorkflowRunState,
  WorkflowRunStatus,
  WorkflowRunStepStatus,
  WorkflowRuns,
  WorkflowSummary,
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

/**
 * Most approaches one scout run may race.
 *
 * Each is a git worktree, a checkout and a model session running at once. The
 * cap is about the machine rather than the protocol: a client asking for fifty
 * would get fifty concurrent checkouts of the repository.
 */
export const MAX_SCOUT_APPROACHES = 8;

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
  "compact",
  "exportSession",
  "mcpStatus",
  "mcpAuthBegin",
  "mcpAuthComplete",
  "mcpAuthCancel",
  "startScout",
  "scoutRun",
  "cancelScout",
  "mcpResources",
  "mcpReadResource",
  "mcpPrompts",
  "mcpGetPrompt",
  "pendingChanges",
  "applyChanges",
  "discardChanges",
  "backgroundAgents",
  "startBackgroundAgent",
  "cancelBackgroundAgent",
  "adoptBackgroundAgent",
  "orgMemory",
  "proposeOrgMemory",
  "revokeOrgMemory",
  "listCheckpoints",
  "rewindTo",
  "listWorkflows",
  "runWorkflow",
  "workflowStatus",
  "resumeWorkflow",
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
      let queryRange: LineRange | undefined;
      if (params.range !== undefined) {
        const parsed = validateLineRange(params.range);
        if (!parsed.ok) return fail(`resolveContext params.range invalid: ${parsed.error}`);
        queryRange = parsed.value;
      }
      return ok<ClientRequest>({
        id,
        method: "resolveContext",
        params: {
          sessionId: params.sessionId,
          query: params.query,
          ...(queryRange === undefined ? {} : { range: queryRange }),
        },
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
    case "compact": {
      if (!isRecord(params)) return fail('compact requires an object "params"');
      if (!isString(params.sessionId)) return fail("compact params.sessionId must be a string");
      return ok<ClientRequest>({ id, method: "compact", params: { sessionId: params.sessionId } });
    }
    case "exportSession": {
      if (!isRecord(params)) return fail('exportSession requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("exportSession params.sessionId must be a string");
      }
      if (
        params.format !== undefined &&
        (!isString(params.format) ||
          !(TRANSCRIPT_FORMATS as readonly string[]).includes(params.format))
      ) {
        return fail('exportSession params.format must be one of "markdown" | "html"');
      }
      if (params.includeThinking !== undefined && typeof params.includeThinking !== "boolean") {
        return fail("exportSession params.includeThinking must be a boolean when present");
      }
      // Both optional fields are copied only when present rather than
      // defaulted here: the engine owns the defaults (they are the terminal's
      // `/export` defaults), and a validator that filled them in would be a
      // second place those two answers live.
      const format = params.format as TranscriptFormat | undefined;
      const includeThinking = params.includeThinking;
      return ok<ClientRequest>({
        id,
        method: "exportSession",
        params: {
          sessionId: params.sessionId,
          ...(format === undefined ? {} : { format }),
          ...(includeThinking === undefined ? {} : { includeThinking }),
        },
      });
    }
    case "mcpStatus": {
      // No params: MCP servers are a property of the server process, not of a
      // conversation — the same shape `listModels` has.
      return ok<ClientRequest>({ id, method: "mcpStatus" });
    }
    case "mcpAuthBegin": {
      if (!isRecord(params)) return fail('mcpAuthBegin requires an object "params"');
      const server = params.server;
      if (typeof server !== "string" || server === "") {
        return fail('mcpAuthBegin requires a non-empty "server"');
      }
      const redirectUri = params.redirectUri;
      if (typeof redirectUri !== "string" || redirectUri === "") {
        return fail('mcpAuthBegin requires a non-empty "redirectUri"');
      }
      // Parseability is checked here rather than at the authorization server,
      // where a malformed value would come back as an opaque `invalid_request`
      // long after the client could act on it.
      try {
        new URL(redirectUri);
      } catch {
        return fail('mcpAuthBegin "redirectUri" must be an absolute URI');
      }
      return ok<ClientRequest>({ id, method: "mcpAuthBegin", params: { server, redirectUri } });
    }
    case "mcpAuthComplete": {
      if (!isRecord(params)) return fail('mcpAuthComplete requires an object "params"');
      const handle = params.handle;
      const code = params.code;
      const state = params.state;
      if (typeof handle !== "string" || handle === "") {
        return fail('mcpAuthComplete requires a non-empty "handle"');
      }
      if (typeof code !== "string" || code === "") {
        return fail('mcpAuthComplete requires a non-empty "code"');
      }
      // Required, not optional: a `state` a client may omit is a `state` an
      // attacker may omit, and the engine would have nothing to compare.
      if (typeof state !== "string" || state === "") {
        return fail('mcpAuthComplete requires a non-empty "state"');
      }
      return ok<ClientRequest>({
        id,
        method: "mcpAuthComplete",
        params: { handle, code, state },
      });
    }
    case "mcpAuthCancel": {
      if (!isRecord(params)) return fail('mcpAuthCancel requires an object "params"');
      const handle = params.handle;
      if (typeof handle !== "string" || handle === "") {
        return fail('mcpAuthCancel requires a non-empty "handle"');
      }
      return ok<ClientRequest>({ id, method: "mcpAuthCancel", params: { handle } });
    }
    case "startScout": {
      if (!isRecord(params)) return fail('startScout requires an object "params"');
      const raw = params.approaches;
      if (!Array.isArray(raw)) return fail('startScout requires an "approaches" array');
      // Two is the floor the CLI already enforces: one approach is not an
      // exploration, and refusing it here means the engine never makes a
      // worktree for a run that cannot answer the question it was asked.
      if (raw.length < 2) return fail("startScout requires at least two approaches");
      if (raw.length > MAX_SCOUT_APPROACHES) {
        return fail(`startScout accepts at most ${MAX_SCOUT_APPROACHES} approaches`);
      }
      const approaches: { name: string; task: string }[] = [];
      for (const entry of raw) {
        if (!isRecord(entry)) return fail("each scout approach must be an object");
        const name = entry.name;
        const task = entry.task;
        if (typeof name !== "string" || name === "") {
          return fail('each scout approach needs a non-empty "name"');
        }
        // The name becomes a git branch and a worktree directory, so anything
        // that is not a plain identifier is refused here rather than turned
        // into a path by `git worktree add`.
        if (!/^[\w-]{1,24}$/.test(name)) {
          return fail(`scout approach name "${name}" must be 1-24 of [A-Za-z0-9_-]`);
        }
        if (typeof task !== "string" || task === "") {
          return fail('each scout approach needs a non-empty "task"');
        }
        approaches.push({ name, task });
      }
      const names = new Set(approaches.map((entry) => entry.name));
      if (names.size !== approaches.length) {
        // Two approaches sharing a name would share a worktree path.
        return fail("scout approach names must be unique");
      }
      return ok<ClientRequest>({ id, method: "startScout", params: { approaches } });
    }
    case "scoutRun": {
      if (!isRecord(params)) return fail('scoutRun requires an object "params"');
      const runId = params.runId;
      if (typeof runId !== "string" || runId === "") {
        return fail('scoutRun requires a non-empty "runId"');
      }
      return ok<ClientRequest>({ id, method: "scoutRun", params: { runId } });
    }
    case "cancelScout": {
      if (!isRecord(params)) return fail('cancelScout requires an object "params"');
      const runId = params.runId;
      if (typeof runId !== "string" || runId === "") {
        return fail('cancelScout requires a non-empty "runId"');
      }
      return ok<ClientRequest>({ id, method: "cancelScout", params: { runId } });
    }
    case "mcpResources": {
      // An optional server filter and nothing else. Absent params is legal and
      // means "every connected server", which is the common case.
      const filter = serverFilter("mcpResources", params);
      if (!filter.ok) return fail(filter.error);
      return ok<ClientRequest>({ id, method: "mcpResources", params: filter.value });
    }
    case "mcpPrompts": {
      const filter = serverFilter("mcpPrompts", params);
      if (!filter.ok) return fail(filter.error);
      return ok<ClientRequest>({ id, method: "mcpPrompts", params: filter.value });
    }
    case "mcpReadResource": {
      if (!isRecord(params)) return fail('mcpReadResource requires an object "params"');
      const server = params.server;
      const uri = params.uri;
      if (typeof server !== "string" || server === "") {
        return fail('mcpReadResource requires a non-empty "server"');
      }
      if (typeof uri !== "string" || uri === "") {
        return fail('mcpReadResource requires a non-empty "uri"');
      }
      return ok<ClientRequest>({ id, method: "mcpReadResource", params: { server, uri } });
    }
    case "mcpGetPrompt": {
      if (!isRecord(params)) return fail('mcpGetPrompt requires an object "params"');
      const server = params.server;
      const name = params.name;
      if (typeof server !== "string" || server === "") {
        return fail('mcpGetPrompt requires a non-empty "server"');
      }
      if (typeof name !== "string" || name === "") {
        return fail('mcpGetPrompt requires a non-empty "name"');
      }
      const rawArgs = params.arguments;
      if (rawArgs === undefined) {
        return ok<ClientRequest>({ id, method: "mcpGetPrompt", params: { server, name } });
      }
      if (!isRecord(rawArgs)) return fail('mcpGetPrompt "arguments" must be an object');
      const args: Record<string, string> = {};
      for (const [key, entry] of Object.entries(rawArgs)) {
        // Strings only. A template's arguments are interpolated by a remote
        // server, and a number or an object arriving here would be stringified
        // by somebody — better that it is refused than guessed at.
        if (typeof entry !== "string") {
          return fail(`mcpGetPrompt argument ${JSON.stringify(key)} must be a string`);
        }
        args[key] = entry;
      }
      return ok<ClientRequest>({
        id,
        method: "mcpGetPrompt",
        params: { server, name, arguments: args },
      });
    }
    case "pendingChanges": {
      if (!isRecord(params)) return fail('pendingChanges requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("pendingChanges params.sessionId must be a string");
      }
      if (params.path !== undefined) {
        if (!isString(params.path)) {
          return fail("pendingChanges params.path must be a string when present");
        }
        if (params.path.length > MAX_PENDING_CHANGE_PATH_LENGTH) {
          return fail(
            `pendingChanges params.path must be at most ${String(MAX_PENDING_CHANGE_PATH_LENGTH)} characters`,
          );
        }
      }
      const path = params.path;
      return ok<ClientRequest>({
        id,
        method: "pendingChanges",
        params:
          path === undefined
            ? { sessionId: params.sessionId }
            : { sessionId: params.sessionId, path },
      });
    }
    case "applyChanges":
    case "discardChanges": {
      // One branch for two verbs because they take the same params, and
      // because a subset selection that validated differently on the way in
      // depending on which of the two it was is exactly how "apply these four"
      // and "discard these four" come to mean different sets of four.
      const verb = method as "applyChanges" | "discardChanges";
      if (!isRecord(params)) return fail(`${verb} requires an object "params"`);
      if (!isString(params.sessionId)) {
        return fail(`${verb} params.sessionId must be a string`);
      }
      const paths = validateChangePaths(verb, params.paths);
      if (!paths.ok) return fail(paths.error);
      return ok<ClientRequest>({
        id,
        method: verb,
        params:
          paths.value === undefined
            ? { sessionId: params.sessionId }
            : { sessionId: params.sessionId, paths: paths.value },
      });
    }
    case "backgroundAgents": {
      // The only params object on this wire that is entirely optional, because
      // the listing form takes nothing at all — `{ method }` with no `params`
      // is the whole request, exactly as `mcpStatus` is. An `id` narrows it to
      // one agent and adds its transcript.
      if (params !== undefined && !isRecord(params)) {
        return fail("backgroundAgents params must be an object when present");
      }
      const agentId = isRecord(params) ? params.id : undefined;
      if (agentId !== undefined) {
        if (!isString(agentId) || agentId === "") {
          return fail("backgroundAgents params.id must be a non-empty string when present");
        }
        if (agentId.length > MAX_BACKGROUND_AGENT_ID_LENGTH) {
          return fail(
            `backgroundAgents params.id must be at most ${String(MAX_BACKGROUND_AGENT_ID_LENGTH)} characters`,
          );
        }
      }
      return ok<ClientRequest>({
        id,
        method: "backgroundAgents",
        ...(agentId === undefined ? {} : { params: { id: agentId } }),
      });
    }
    case "startBackgroundAgent": {
      if (!isRecord(params)) return fail('startBackgroundAgent requires an object "params"');
      if (!isString(params.task) || params.task.trim() === "") {
        return fail("startBackgroundAgent params.task must be a non-empty string");
      }
      if (params.task.length > MAX_BACKGROUND_TASK_LENGTH) {
        return fail(
          `startBackgroundAgent params.task must be at most ${String(MAX_BACKGROUND_TASK_LENGTH)} characters`,
        );
      }
      // Exactly one field is copied out, and that is the point rather than an
      // accident of this verb being simple: `tools`, `permissionMode`, `cwd`
      // and `model` are the caps a background agent runs under, and a
      // validator that copied a field the request type does not define is how
      // a client would come to widen one. See `ClientRequest`'s doc.
      return ok<ClientRequest>({
        id,
        method: "startBackgroundAgent",
        params: { task: params.task },
      });
    }
    case "cancelBackgroundAgent": {
      if (!isRecord(params)) return fail('cancelBackgroundAgent requires an object "params"');
      const bad = validateBackgroundAgentId("cancelBackgroundAgent", params.id);
      if (bad !== undefined) return fail(bad);
      return ok<ClientRequest>({
        id,
        method: "cancelBackgroundAgent",
        params: { id: params.id as string },
      });
    }
    case "adoptBackgroundAgent": {
      if (!isRecord(params)) return fail('adoptBackgroundAgent requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("adoptBackgroundAgent params.sessionId must be a string");
      }
      const badAgent = validateBackgroundAgentId("adoptBackgroundAgent", params.id);
      if (badAgent !== undefined) return fail(badAgent);
      return ok<ClientRequest>({
        id,
        method: "adoptBackgroundAgent",
        params: { sessionId: params.sessionId, id: params.id as string },
      });
    }
    case "orgMemory": {
      // No params: the store is keyed by project and lives under the user's
      // home, so it is a property of the server — the shape `mcpStatus` has.
      return ok<ClientRequest>({ id, method: "orgMemory" });
    }
    case "proposeOrgMemory": {
      if (!isRecord(params)) return fail('proposeOrgMemory requires an object "params"');
      const badRole = validateOrgMemoryField("proposeOrgMemory", "role", params.role);
      if (badRole !== undefined) return fail(badRole);
      const badText = validateOrgMemoryField("proposeOrgMemory", "text", params.text);
      if (badText !== undefined) return fail(badText);
      // Two fields, and no third. There is deliberately no `status` here: the
      // engine files this `proposed` and has nothing to read a different
      // answer from. See `ClientRequest`'s doc for why that gate is a person
      // rather than a field.
      return ok<ClientRequest>({
        id,
        method: "proposeOrgMemory",
        params: { role: params.role as string, text: params.text as string },
      });
    }
    case "revokeOrgMemory": {
      if (!isRecord(params)) return fail('revokeOrgMemory requires an object "params"');
      const badId = validateOrgMemoryField("revokeOrgMemory", "id", params.id);
      if (badId !== undefined) return fail(badId);
      if (params.remove !== undefined && typeof params.remove !== "boolean") {
        return fail("revokeOrgMemory params.remove must be a boolean when present");
      }
      const remove = params.remove;
      return ok<ClientRequest>({
        id,
        method: "revokeOrgMemory",
        params: {
          id: params.id as string,
          ...(remove === undefined ? {} : { remove }),
        },
      });
    }
    case "listCheckpoints": {
      if (!isRecord(params)) return fail('listCheckpoints requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("listCheckpoints params.sessionId must be a string");
      }
      return ok<ClientRequest>({
        id,
        method: "listCheckpoints",
        params: { sessionId: params.sessionId },
      });
    }
    case "rewindTo": {
      if (!isRecord(params)) return fail('rewindTo requires an object "params"');
      if (!isString(params.sessionId)) return fail("rewindTo params.sessionId must be a string");
      if (!isString(params.checkpointId) || params.checkpointId === "") {
        return fail("rewindTo params.checkpointId must be a non-empty string");
      }
      if (params.checkpointId.length > MAX_CHECKPOINT_ID_LENGTH) {
        return fail(
          `rewindTo params.checkpointId must be at most ${String(MAX_CHECKPOINT_ID_LENGTH)} characters`,
        );
      }
      // Required, not optional. An optional safety field is one an older or
      // lazier client omits, and the omission would be indistinguishable from
      // a client that genuinely showed the user what this costs — which is the
      // single thing the field exists to prove. See `ClientRequest`'s doc.
      if (!isString(params.confirmation) || params.confirmation === "") {
        return fail(
          "rewindTo params.confirmation must be a non-empty string, copied from the " +
            "CheckpointEntry.confirmation of the row the user was shown",
        );
      }
      if (params.confirmation.length > MAX_CHECKPOINT_ID_LENGTH) {
        return fail(
          `rewindTo params.confirmation must be at most ${String(MAX_CHECKPOINT_ID_LENGTH)} characters`,
        );
      }
      return ok<ClientRequest>({
        id,
        method: "rewindTo",
        params: {
          sessionId: params.sessionId,
          checkpointId: params.checkpointId,
          confirmation: params.confirmation,
        },
      });
    }
    case "listWorkflows": {
      // No params: workflow files are discovered from the served workspace and
      // the user's home, both properties of the server — the shape `listModels`
      // and `listCommands` have.
      return ok<ClientRequest>({ id, method: "listWorkflows" });
    }
    case "runWorkflow": {
      if (!isRecord(params)) return fail('runWorkflow requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("runWorkflow params.sessionId must be a string");
      }
      if (!isString(params.name) || params.name === "") {
        return fail("runWorkflow params.name must be a non-empty string");
      }
      if (params.name.length > MAX_WORKFLOW_NAME_LENGTH) {
        return fail(
          `runWorkflow params.name must be at most ${String(MAX_WORKFLOW_NAME_LENGTH)} characters`,
        );
      }
      if (params.input !== undefined) {
        if (!isString(params.input)) {
          return fail("runWorkflow params.input must be a string when present");
        }
        if (params.input.length > MAX_WORKFLOW_INPUT_LENGTH) {
          return fail(
            `runWorkflow params.input must be at most ${String(MAX_WORKFLOW_INPUT_LENGTH)} characters`,
          );
        }
      }
      // Shape only. Whether the number is *allowed* — that it is not above the
      // workflow file's own `budgetUsd:` — is the engine's call, because the
      // file is the only thing that knows, and a validator that guessed would
      // be a second authority on a money ceiling. What is settled here is the
      // one thing a validator can settle: `0` and negatives disable the cost
      // guard, so a "ceiling" of `0` would widen rather than narrow, and that
      // is refused at the boundary rather than deep in the engine.
      if (params.budgetUsd !== undefined) {
        if (!isNumber(params.budgetUsd) || params.budgetUsd <= 0) {
          return fail(
            "runWorkflow params.budgetUsd must be a positive number of US dollars when " +
              "present — it may only lower the workflow's own ceiling, and 0 would disable it",
          );
        }
      }
      const budgetUsd = params.budgetUsd;
      const input = params.input;
      return ok<ClientRequest>({
        id,
        method: "runWorkflow",
        params: {
          sessionId: params.sessionId,
          name: params.name,
          ...(input === undefined ? {} : { input }),
          ...(budgetUsd === undefined ? {} : { budgetUsd }),
        },
      });
    }
    case "workflowStatus": {
      // `params` itself is optional here, unlike everywhere else in this
      // switch: the listing form takes nothing, and requiring an empty object
      // for it would make the common call the awkward one.
      if (params !== undefined && !isRecord(params)) {
        return fail("workflowStatus params must be an object when present");
      }
      const runId = isRecord(params) ? params.runId : undefined;
      if (runId !== undefined) {
        if (!isString(runId) || runId === "") {
          return fail("workflowStatus params.runId must be a non-empty string when present");
        }
        if (runId.length > MAX_WORKFLOW_RUN_ID_LENGTH) {
          return fail(
            `workflowStatus params.runId must be at most ${String(MAX_WORKFLOW_RUN_ID_LENGTH)} characters`,
          );
        }
      }
      return ok<ClientRequest>({
        id,
        method: "workflowStatus",
        params: runId === undefined ? {} : { runId },
      });
    }
    case "resumeWorkflow": {
      if (!isRecord(params)) return fail('resumeWorkflow requires an object "params"');
      if (!isString(params.sessionId)) {
        return fail("resumeWorkflow params.sessionId must be a string");
      }
      if (!isString(params.runId) || params.runId === "") {
        return fail("resumeWorkflow params.runId must be a non-empty string");
      }
      if (params.runId.length > MAX_WORKFLOW_RUN_ID_LENGTH) {
        return fail(
          `resumeWorkflow params.runId must be at most ${String(MAX_WORKFLOW_RUN_ID_LENGTH)} characters`,
        );
      }
      if (params.answer !== undefined) {
        if (!isString(params.answer)) {
          return fail("resumeWorkflow params.answer must be a string when present");
        }
        if (params.answer.length > MAX_WORKFLOW_INPUT_LENGTH) {
          return fail(
            `resumeWorkflow params.answer must be at most ${String(MAX_WORKFLOW_INPUT_LENGTH)} characters`,
          );
        }
      }
      const answer = params.answer;
      return ok<ClientRequest>({
        id,
        method: "resumeWorkflow",
        params: {
          sessionId: params.sessionId,
          runId: params.runId,
          ...(answer === undefined ? {} : { answer }),
        },
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
 * Ceiling on an MCP server's name on the wire.
 *
 * The name is a key in a JSON file a person wrote, so 200 is generous rather
 * than restrictive — the same ceiling the VS Code panel puts on a model id,
 * and for the same reason: the value lands in a menu row and in a log line,
 * and neither wants an unbounded string.
 */
export const MAX_MCP_SERVER_NAME_LENGTH = 200;

/**
 * Ceiling on one pending-change path on the wire.
 *
 * The same 4096 {@link MAX_CONTEXT_QUERY_LENGTH} uses, and for the same
 * reason: it is a path, and it arrives from a client this server has no reason
 * to trust with an unbounded string it would then normalize and compare.
 */
export const MAX_PENDING_CHANGE_PATH_LENGTH = 4096;

/**
 * Ceiling on how many paths one `applyChanges`/`discardChanges` may name.
 *
 * Matches {@link PENDING_CHANGES_MAX_FILES} in `@arcturn/server`, which is the
 * most rows `pendingChanges` will ever list — a client can select every file
 * it was shown and no more. Bounded at all because the selection is walked
 * against the pending set before anything is written, and an unbounded array
 * is work a token holder could ask for by sending one frame.
 */
export const MAX_CHANGE_SELECTION = 1000;

/**
 * Ceiling on a checkpoint id and on the confirmation echoed with it.
 *
 * A turn id is a UUID and a confirmation is a hex digest, so 200 is the same
 * generous-but-bounded ceiling {@link MAX_MCP_SERVER_NAME_LENGTH} uses. Both
 * arrive from a client holding the serve token on the way into the one verb
 * that deletes files, and neither has any business being unbounded.
 */
export const MAX_CHECKPOINT_ID_LENGTH = 200;

/**
 * Ceiling on a background agent's id on the wire.
 *
 * An id is `bg-` plus eight hex characters, so 64 is the same
 * generous-but-bounded shape {@link MAX_CHECKPOINT_ID_LENGTH} has. Bounded
 * because the value is looked up in a map and rendered into a refusal
 * sentence, and neither wants an unbounded string from a client.
 */
export const MAX_BACKGROUND_AGENT_ID_LENGTH = 64;

/**
 * Ceiling on the task one `startBackgroundAgent` may carry.
 *
 * A task is a prompt, and a prompt on this wire is already bounded by the
 * frame size `ws` will accept. This is the *second* bound, and it exists for a
 * different cost: a background agent's task is written verbatim into a durable
 * JSON record on disk, re-read by every manager that ever loads that
 * directory, and rendered into a listing row. 16 KiB is far past any real
 * delegated instruction and far short of a record file a client could grow
 * without limit by sending frames.
 */
export const MAX_BACKGROUND_TASK_LENGTH = 16 * 1024;

/**
 * Ceiling on an org-memory id, role and lesson text on the wire.
 *
 * Deliberately **looser** than the store's own bounds (an id is 24 characters,
 * a lesson 160) rather than a copy of them. The store re-applies its real
 * limits on write and refuses — with a sentence naming which limit — and that
 * refusal is the one a person needs to read. A validator that rejected first
 * would answer "invalid request" where the engine would have said "at most 160
 * characters; clipping can invert a lesson", so this bounds only what an
 * unbounded string would cost the *wire*, and leaves meaning to the store.
 */
export const MAX_ORG_MEMORY_FIELD_LENGTH = 4096;

/**
 * Ceiling on a workflow name.
 *
 * A workflow name is a filename stem normalized to `[a-z0-9-]`, so this is far
 * past any real one and far short of a frame that makes the engine scan two
 * directories comparing a megabyte-long string against every file in them.
 */
export const MAX_WORKFLOW_NAME_LENGTH = 200;

/**
 * Ceiling on a run id.
 *
 * A run id names a directory under the served home, and it arrives from a
 * client holding the serve token, so it is bounded on the same terms
 * {@link MAX_CHECKPOINT_ID_LENGTH} is. Note that bounding it is *not* what
 * keeps a traversal out — the engine joins it under its own runs root and the
 * store refuses anything that escapes; this is the boundary's own limit on how
 * much string it will carry.
 */
export const MAX_WORKFLOW_RUN_ID_LENGTH = 200;

/**
 * Ceiling on a workflow's `{{input}}` and on an `ORG-ASK:` answer.
 *
 * Both are prose a person typed, and both end up spliced into a prompt, so
 * this is `MAX_PROMPT_LENGTH`'s order of magnitude rather than a path's: long
 * enough for a pasted PR description or a considered answer to a design
 * question, short enough that it is not an unbounded string on the way into
 * the one verb that spends money.
 */
export const MAX_WORKFLOW_INPUT_LENGTH = 100_000;

/**
 * Validate the optional `paths` selection shared by `applyChanges` and
 * `discardChanges`.
 *
 * `undefined` (the field omitted) means "everything" and is a legal answer;
 * an **empty array** is not, and is refused rather than read as "everything".
 * A client that computed an empty selection and got the whole shadow tree
 * applied — or discarded — would have the worst possible version of this bug,
 * and the two spellings are only one character apart at the call site.
 */
function validateChangePaths(
  method: string,
  value: unknown,
): ValidationResult<string[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value)) {
    return fail(`${method} params.paths must be an array of strings when present`);
  }
  if (value.length === 0) {
    return fail(
      `${method} params.paths must not be empty: omit the field to mean every pending change, ` +
        "rather than sending an empty selection that would silently mean the same thing",
    );
  }
  if (value.length > MAX_CHANGE_SELECTION) {
    return fail(`${method} params.paths must hold at most ${String(MAX_CHANGE_SELECTION)} items`);
  }
  const paths: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry: unknown = value[i];
    if (!isString(entry) || entry === "") {
      return fail(`${method} params.paths[${String(i)}] must be a non-empty string`);
    }
    if (entry.length > MAX_PENDING_CHANGE_PATH_LENGTH) {
      return fail(
        `${method} params.paths[${String(i)}] must be at most ${String(MAX_PENDING_CHANGE_PATH_LENGTH)} characters`,
      );
    }
    paths.push(entry);
  }
  return { ok: true, value: paths };
}

/**
 * Validate a background agent id on the way in.
 *
 * @returns The failure sentence, or `undefined` when the value is fine — a
 *   shape that lets two verbs share one check without either of them
 *   unwrapping a result they would immediately re-wrap.
 */
function validateBackgroundAgentId(method: string, value: unknown): string | undefined {
  if (!isString(value) || value === "") {
    return `${method} params.id must be a non-empty string`;
  }
  if (value.length > MAX_BACKGROUND_AGENT_ID_LENGTH) {
    return `${method} params.id must be at most ${String(MAX_BACKGROUND_AGENT_ID_LENGTH)} characters`;
  }
  return undefined;
}

/**
 * Validate one org-memory string field on the way in.
 *
 * Length only, and deliberately: the store's own rules — one line, 160
 * characters, no control marker, no fence delimiter — are re-applied by the
 * engine on write and produce a refusal that says *which* rule was broken.
 * Duplicating them here would answer a different, less useful sentence first,
 * and would put the store's bounds in two places that could drift.
 */
function validateOrgMemoryField(method: string, field: string, value: unknown): string | undefined {
  if (!isString(value) || value.trim() === "") {
    return `${method} params.${field} must be a non-empty string`;
  }
  if (value.length > MAX_ORG_MEMORY_FIELD_LENGTH) {
    return `${method} params.${field} must be at most ${String(MAX_ORG_MEMORY_FIELD_LENGTH)} characters`;
  }
  return undefined;
}

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
 * Every {@link PromptAttachment} kind this contract knows.
 *
 * One list, read by both the attachment validator and
 * {@link ContextResolution.attachmentKinds}: the set an engine advertises and
 * the set it accepts have to be the same set, and two literals would let them
 * stop being.
 */
const PROMPT_ATTACHMENT_KINDS = ["file", "fileReference", "image", "mcpResource"] as const;

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
/**
 * Validate one {@link LineRange}.
 *
 * The convention is `LineRange`'s own — 1-based, inclusive at both ends — and
 * the three rules here are the only ones that can be checked without opening
 * the file: a bound must be a whole number, `start` must be at least 1, and
 * `end` must not come before `start`. Each of those is a client bug rather
 * than a user's selection, and clamping one would mean inventing an intent
 * nobody expressed.
 *
 * There is deliberately **no upper bound**. A range whose `end` runs past the
 * file is an ordinary thing — select-to-end, or a file edited since the
 * selection was taken — and the engine clamps and reports it at read time. It
 * cannot cost anything to allow: the engine never reads more of a file than
 * the file, so `{ start: 1, end: 10_000_000 }` is exactly as expensive as
 * attaching that file with no range at all, and the existing per-file and
 * total-byte caps still bound both.
 */
export function validateLineRange(value: unknown): ValidationResult<LineRange> {
  if (!isRecord(value)) return fail("LineRange must be an object");
  if (!isNumber(value.start) || !Number.isSafeInteger(value.start)) {
    return fail("LineRange.start must be a whole number");
  }
  if (!isNumber(value.end) || !Number.isSafeInteger(value.end)) {
    return fail("LineRange.end must be a whole number");
  }
  if (value.start < 1) {
    return fail("LineRange.start must be at least 1 — line numbers are 1-based");
  }
  if (value.end < value.start) {
    return fail(
      `LineRange.end (${String(value.end)}) must not be before LineRange.start ` +
        `(${String(value.start)}) — both ends are inclusive`,
    );
  }
  return { ok: true, value: { start: value.start, end: value.end } };
}

/**
 * Read the optional `{ server }` filter the two MCP listing verbs share.
 *
 * A helper rather than a shared `case` label: falling two cases through widens
 * `method` to `string`, and the request union is discriminated on it.
 */
function serverFilter(
  method: string,
  params: unknown,
): ValidationResult<{ server?: string } | undefined> {
  if (params === undefined) return { ok: true, value: undefined };
  if (!isRecord(params)) return fail(`${method} params must be an object when present`);
  const server = params.server;
  if (server === undefined) return { ok: true, value: {} };
  if (!isString(server) || server === "") {
    return fail(`${method} "server" must be a non-empty string when present`);
  }
  return { ok: true, value: { server } };
}

export function validatePromptAttachment(value: unknown): ValidationResult<PromptAttachment> {
  if (!isRecord(value)) return fail("PromptAttachment must be an object");
  const kind = value.kind;
  if (kind !== "file" && kind !== "fileReference" && kind !== "image" && kind !== "mcpResource") {
    return fail(
      `PromptAttachment.kind must be one of ${PROMPT_ATTACHMENT_KINDS.map((k) => `"${k}"`).join(" | ")}`,
    );
  }
  if (kind === "mcpResource") {
    // Neither `path` nor `data`: an MCP resource is named by a server and a
    // URI, and the engine fetches it. Handled before the path/data pairing
    // below, which is a rule about *files* and would reject this shape for
    // having neither.
    if (!isString(value.server) || value.server === "") {
      return fail('PromptAttachment of kind "mcpResource" needs a non-empty "server"');
    }
    if (!isString(value.uri) || value.uri === "") {
      return fail('PromptAttachment of kind "mcpResource" needs a non-empty "uri"');
    }
    if (value.uri.length > MAX_CONTEXT_QUERY_LENGTH) {
      return fail(
        `PromptAttachment.uri must be at most ${String(MAX_CONTEXT_QUERY_LENGTH)} characters`,
      );
    }
    if (value.range !== undefined) {
      return fail(
        'PromptAttachment.range is accepted for kind "file" only — a resource is what the ' +
          "server chose to publish, and slicing it here would be this client deciding what a " +
          "remote document's lines mean",
      );
    }
    return { ok: true, value: { kind: "mcpResource", server: value.server, uri: value.uri } };
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
    // A line range is a `file` idea only. An image has no lines, and a
    // `fileReference` has no text — so a range on either cannot be honoured,
    // and this validator is where it is *refused* rather than dropped, because
    // a dropped range is the whole file arriving while the client believes it
    // sent a selection.
    if (value.range !== undefined) {
      if (kind === "fileReference") {
        return fail(
          'PromptAttachment.range is not accepted for kind "fileReference" — a reference names ' +
            "a file and sends none of it, so there is nothing for a range to narrow. A client " +
            'that knows which lines are selected should send kind "file" with that range: the ' +
            "excerpt is what the user pointed at",
        );
      }
      if (kind !== "file") {
        return fail(
          'PromptAttachment.range is accepted for kind "file" only — an image has no lines',
        );
      }
      const range = validateLineRange(value.range);
      if (!range.ok) return fail(`PromptAttachment.range invalid: ${range.error}`);
      return { ok: true, value: { kind: "file", path: value.path, range: range.value } };
    }
    const attachment: PromptAttachment =
      kind === "file"
        ? { kind: "file", path: value.path }
        : kind === "fileReference"
          ? { kind: "fileReference", path: value.path }
          : { kind: "image", path: value.path };
    return { ok: true, value: attachment };
  }
  if (value.range !== undefined) {
    return fail('PromptAttachment.range is accepted for kind "file" only — an image has no lines');
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
  let range: LineRange | undefined;
  if (value.range !== undefined) {
    const parsed = validateLineRange(value.range);
    if (!parsed.ok) return fail(`ContextResolution.range invalid: ${parsed.error}`);
    range = parsed.value;
  }
  // Copied out one entry at a time, and refused rather than filtered when an
  // entry is not a kind this contract knows. A silently-dropped entry would
  // let a newer engine advertise a kind a client then never sends, which is
  // the quiet degradation this field exists to make impossible.
  let attachmentKinds: PromptAttachmentKind[] | undefined;
  if (value.attachmentKinds !== undefined) {
    if (!Array.isArray(value.attachmentKinds)) {
      return fail("ContextResolution.attachmentKinds must be an array when present");
    }
    attachmentKinds = [];
    for (const entry of value.attachmentKinds) {
      if (!isString(entry) || !(PROMPT_ATTACHMENT_KINDS as readonly string[]).includes(entry)) {
        return fail(
          `ContextResolution.attachmentKinds must contain only ${PROMPT_ATTACHMENT_KINDS.join(" | ")}`,
        );
      }
      attachmentKinds.push(entry as PromptAttachmentKind);
    }
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
      ...(range === undefined ? {} : { range }),
      ...(attachmentKinds === undefined ? {} : { attachmentKinds }),
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

/** The two documents `exportSession` renders. Mirrors {@link TranscriptFormat}. */
const TRANSCRIPT_FORMATS = ["markdown", "html"] as const;

/**
 * Validate a `compact` result.
 *
 * Run at both ends, like {@link validateModelCatalog}. Two cross-field lies
 * are refused here rather than in a client that would render them as fact:
 * a negative token count (there is no such conversation), and a `reason` on a
 * compaction that says it succeeded — the field exists to explain why nothing
 * happened, and one attached to `compacted: true` is a payload a client would
 * render as "compacted, but…" over a compaction that worked.
 */
export function validateCompactionSummary(value: unknown): ValidationResult<CompactionSummary> {
  if (!isRecord(value)) return fail("CompactionSummary must be an object");
  if (!isString(value.sessionId)) return fail("CompactionSummary.sessionId must be a string");
  if (typeof value.compacted !== "boolean") {
    return fail("CompactionSummary.compacted must be a boolean");
  }
  if (!isNumber(value.tokensBefore) || value.tokensBefore < 0) {
    return fail("CompactionSummary.tokensBefore must be a non-negative number");
  }
  if (!isNumber(value.tokensAfter) || value.tokensAfter < 0) {
    return fail("CompactionSummary.tokensAfter must be a non-negative number");
  }
  if (value.reason !== undefined && !isString(value.reason)) {
    return fail("CompactionSummary.reason must be a string when present");
  }
  if (value.compacted && value.reason !== undefined) {
    return fail("CompactionSummary.reason must be absent when compacted is true");
  }
  return {
    ok: true,
    value: {
      sessionId: value.sessionId,
      compacted: value.compacted,
      tokensBefore: value.tokensBefore,
      tokensAfter: value.tokensAfter,
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    },
  };
}

/**
 * Validate an `exportSession` result.
 *
 * The cross-field check is {@link validateSessionHistory}'s, for the same
 * reason: a payload claiming nothing was dropped while reporting a count is
 * one a client would render one of two contradictory ways, and neither is safe
 * to guess. `filename` is checked to be a **name** rather than a path —
 * nothing this engine sends may steer a client's save dialog into a directory
 * the person did not choose, and a `..` in a suggested filename is the classic
 * way that is attempted.
 */
export function validateSessionExport(value: unknown): ValidationResult<SessionExport> {
  if (!isRecord(value)) return fail("SessionExport must be an object");
  if (!isString(value.sessionId)) return fail("SessionExport.sessionId must be a string");
  if (
    !isString(value.format) ||
    !(TRANSCRIPT_FORMATS as readonly string[]).includes(value.format)
  ) {
    return fail('SessionExport.format must be one of "markdown" | "html"');
  }
  if (!isString(value.filename) || value.filename === "") {
    return fail("SessionExport.filename must be a non-empty string");
  }
  if (/[\\/]/.test(value.filename) || value.filename.includes("..")) {
    return fail("SessionExport.filename must be a bare filename, not a path");
  }
  if (!isString(value.content)) return fail("SessionExport.content must be a string");
  if (!isNumber(value.messageCount) || value.messageCount < 0) {
    return fail("SessionExport.messageCount must be a non-negative number");
  }
  if (typeof value.truncated !== "boolean") {
    return fail("SessionExport.truncated must be a boolean");
  }
  if (!isNumber(value.droppedMessages) || value.droppedMessages < 0) {
    return fail("SessionExport.droppedMessages must be a non-negative number");
  }
  if (!value.truncated && value.droppedMessages !== 0) {
    return fail("SessionExport.droppedMessages must be 0 when truncated is false");
  }
  return {
    ok: true,
    value: {
      sessionId: value.sessionId,
      format: value.format as TranscriptFormat,
      filename: value.filename,
      content: value.content,
      messageCount: value.messageCount,
      truncated: value.truncated,
      droppedMessages: value.droppedMessages,
    },
  };
}

const MCP_TRANSPORTS = ["stdio", "http"] as const;
const MCP_STATES = ["disconnected", "connecting", "connected", "failed"] as const;

/**
 * Validate one {@link McpServerSummary}.
 *
 * This is the validator whose *omissions* are the feature. Four fields are
 * copied out by name and nothing else is; two of them are closed enumerations
 * checked against a literal list. So a `url`, a `command`, an `env`, a set of
 * headers or an OAuth token cannot reach a client even if a host's projection
 * grew careless, because there is no branch here that copies an unknown key.
 * That is `validatePermissionState`'s argument about `tools` carrying names
 * and only names, applied to the payload with the most to leak.
 *
 * `name` is bounded and refused if it carries a control character: it is the
 * one free string here, it lands in a menu and in a log line, and a newline in
 * it would forge a second line in both.
 */
export function validateMcpServerSummary(value: unknown): ValidationResult<McpServerSummary> {
  if (!isRecord(value)) return fail("McpServerSummary must be an object");
  if (!isString(value.name) || value.name === "") {
    return fail("McpServerSummary.name must be a non-empty string");
  }
  if (value.name.length > MAX_MCP_SERVER_NAME_LENGTH) {
    return fail(
      `McpServerSummary.name must be at most ${String(MAX_MCP_SERVER_NAME_LENGTH)} characters`,
    );
  }
  if (hasControlCharacter(value.name)) {
    return fail("McpServerSummary.name must not contain control characters");
  }
  if (
    !isString(value.transport) ||
    !(MCP_TRANSPORTS as readonly string[]).includes(value.transport)
  ) {
    return fail('McpServerSummary.transport must be one of "stdio" | "http"');
  }
  if (!isString(value.state) || !(MCP_STATES as readonly string[]).includes(value.state)) {
    return fail(
      'McpServerSummary.state must be one of "disconnected" | "connecting" | "connected" | "failed"',
    );
  }
  if (value.toolCount !== undefined) {
    if (!isNumber(value.toolCount) || value.toolCount < 0 || !Number.isInteger(value.toolCount)) {
      return fail("McpServerSummary.toolCount must be a non-negative integer when present");
    }
    if (value.state !== "connected") {
      // A count for a server that is not connected is a number nobody can
      // source: the manager only records one once a bridge has listed tools.
      return fail('McpServerSummary.toolCount must be absent unless state is "connected"');
    }
  }
  return {
    ok: true,
    value: {
      name: value.name,
      transport: value.transport as McpTransport,
      state: value.state as McpConnectionState,
      ...(value.toolCount === undefined ? {} : { toolCount: value.toolCount }),
    },
  };
}

/**
 * Validate an `mcpStatus` result.
 *
 * The server answers `{ servers: [...] }`; a bare array is also accepted, the
 * same latitude {@link validateModelCatalog} and {@link validateCommandList}
 * give a leaner server variant.
 */
export function validateMcpStatus(value: unknown): ValidationResult<McpStatus> {
  const raw = Array.isArray(value) ? value : isRecord(value) ? value.servers : undefined;
  if (!Array.isArray(raw)) {
    return fail('McpStatus must be an array of servers or an object with a "servers" array');
  }
  const servers: McpServerSummary[] = [];
  for (let i = 0; i < raw.length; i++) {
    const result = validateMcpServerSummary(raw[i]);
    if (!result.ok) return fail(`servers[${i}] invalid: ${result.error}`);
    servers.push(result.value);
  }
  return { ok: true, value: { servers } };
}

const PENDING_CHANGE_KINDS = ["added", "modified"] as const;

/**
 * Validate one {@link PendingChange}.
 *
 * Copied field by field, like every other result validator here, and with one
 * field this file cares about more than the rest: `after` is the content a
 * client will render as *the change* and, on the other side of the wire, the
 * content the engine will write over somebody's file. Rebuilding rather than
 * spreading is what keeps anything the host happened to hang off its own
 * change object — a shadow path, an absolute temp file — from riding along.
 */
export function validatePendingChange(value: unknown): ValidationResult<PendingChange> {
  if (!isRecord(value)) return fail("PendingChange must be an object");
  if (!isString(value.path) || value.path === "") {
    return fail("PendingChange.path must be a non-empty string");
  }
  if (!isString(value.absolutePath) || value.absolutePath === "") {
    return fail("PendingChange.absolutePath must be a non-empty string");
  }
  if (!isString(value.kind) || !(PENDING_CHANGE_KINDS as readonly string[]).includes(value.kind)) {
    return fail('PendingChange.kind must be one of "added" | "modified"');
  }
  if (!isNumber(value.bytes) || value.bytes < 0) {
    return fail("PendingChange.bytes must be a non-negative number");
  }
  if (!isNumber(value.previousBytes) || value.previousBytes < 0) {
    return fail("PendingChange.previousBytes must be a non-negative number");
  }
  if (value.after !== undefined && !isString(value.after)) {
    return fail("PendingChange.after must be a string when present");
  }
  if (value.contentOmitted !== undefined && typeof value.contentOmitted !== "boolean") {
    return fail("PendingChange.contentOmitted must be a boolean when present");
  }
  const change: PendingChange = {
    path: value.path,
    absolutePath: value.absolutePath,
    kind: value.kind as PendingChange["kind"],
    bytes: value.bytes,
    previousBytes: value.previousBytes,
    ...(value.after === undefined ? {} : { after: value.after }),
    ...(value.contentOmitted === true ? { contentOmitted: true } : {}),
  };
  return { ok: true, value: change };
}

/**
 * Validate a `pendingChanges` result.
 *
 * `dryRun` is required rather than defaulted, deliberately. A missing flag
 * defaulted to `false` would make a real dry-run session look like an ordinary
 * one; defaulted to `true` it would make an ordinary session look like it was
 * holding changes back. Neither guess is safe, so a payload without it is not
 * a payload.
 */
export function validatePendingChanges(value: unknown): ValidationResult<PendingChanges> {
  if (!isRecord(value)) return fail("PendingChanges must be an object");
  if (!isString(value.sessionId)) return fail("PendingChanges.sessionId must be a string");
  if (typeof value.dryRun !== "boolean") return fail("PendingChanges.dryRun must be a boolean");
  if (typeof value.truncated !== "boolean") {
    return fail("PendingChanges.truncated must be a boolean");
  }
  if (!isNumber(value.droppedChanges) || value.droppedChanges < 0) {
    return fail("PendingChanges.droppedChanges must be a non-negative number");
  }
  if (!Array.isArray(value.changes)) return fail("PendingChanges.changes must be an array");
  const changes: PendingChange[] = [];
  for (let i = 0; i < value.changes.length; i++) {
    const result = validatePendingChange(value.changes[i]);
    if (!result.ok) return fail(`PendingChanges.changes[${String(i)}] invalid: ${result.error}`);
    changes.push(result.value);
  }
  return {
    ok: true,
    value: {
      sessionId: value.sessionId,
      dryRun: value.dryRun,
      changes,
      truncated: value.truncated,
      droppedChanges: value.droppedChanges,
    },
  };
}

/** Validate an `applyChanges` result. */
export function validateApplyChangesResult(value: unknown): ValidationResult<ApplyChangesResult> {
  if (!isRecord(value)) return fail("ApplyChangesResult must be an object");
  if (!isString(value.sessionId)) return fail("ApplyChangesResult.sessionId must be a string");
  const applied = stringList("ApplyChangesResult.applied", value.applied);
  if (!applied.ok) return fail(applied.error);
  if (!Array.isArray(value.failed)) return fail("ApplyChangesResult.failed must be an array");
  const failed: ApplyChangeFailure[] = [];
  for (let i = 0; i < value.failed.length; i++) {
    const entry: unknown = value.failed[i];
    if (!isRecord(entry)) return fail(`ApplyChangesResult.failed[${String(i)}] must be an object`);
    if (!isString(entry.path) || entry.path === "") {
      return fail(`ApplyChangesResult.failed[${String(i)}].path must be a non-empty string`);
    }
    if (!isString(entry.message)) {
      return fail(`ApplyChangesResult.failed[${String(i)}].message must be a string`);
    }
    failed.push({ path: entry.path, message: entry.message });
  }
  if (!isNumber(value.remaining) || value.remaining < 0) {
    return fail("ApplyChangesResult.remaining must be a non-negative number");
  }
  return {
    ok: true,
    value: {
      sessionId: value.sessionId,
      applied: applied.value,
      failed,
      remaining: value.remaining,
    },
  };
}

/** Validate a `discardChanges` result. */
export function validateDiscardChangesResult(
  value: unknown,
): ValidationResult<DiscardChangesResult> {
  if (!isRecord(value)) return fail("DiscardChangesResult must be an object");
  if (!isString(value.sessionId)) return fail("DiscardChangesResult.sessionId must be a string");
  const discarded = stringList("DiscardChangesResult.discarded", value.discarded);
  if (!discarded.ok) return fail(discarded.error);
  if (!isNumber(value.remaining) || value.remaining < 0) {
    return fail("DiscardChangesResult.remaining must be a non-negative number");
  }
  return {
    ok: true,
    value: {
      sessionId: value.sessionId,
      discarded: discarded.value,
      remaining: value.remaining,
    },
  };
}

const BACKGROUND_AGENT_STATES = ["running", "done", "failed", "cancelled", "interrupted"] as const;

/**
 * Validate one {@link BackgroundAgentSummary}.
 *
 * Rebuilt field by field like every other payload here, and with a reason
 * sharper than the usual one: `task`, `finalText` and every transcript line
 * are **model- and user-authored prose** on its way into a list a person
 * reads. Rebuilding is what keeps a field the manager's record grows tomorrow
 * — a working directory, an absolute session path, an override the wire has no
 * business carrying — from riding along into a client that would render it.
 */
export function validateBackgroundAgentSummary(
  value: unknown,
): ValidationResult<BackgroundAgentSummary> {
  if (!isRecord(value)) return fail("BackgroundAgentSummary must be an object");
  if (!isString(value.id) || value.id === "") {
    return fail("BackgroundAgentSummary.id must be a non-empty string");
  }
  if (!isString(value.sessionId) || value.sessionId === "") {
    return fail("BackgroundAgentSummary.sessionId must be a non-empty string");
  }
  if (!isString(value.task)) return fail("BackgroundAgentSummary.task must be a string");
  if (!isString(value.modelId)) return fail("BackgroundAgentSummary.modelId must be a string");
  if (
    !isString(value.status) ||
    !(BACKGROUND_AGENT_STATES as readonly string[]).includes(value.status)
  ) {
    return fail(
      `BackgroundAgentSummary.status must be one of ${BACKGROUND_AGENT_STATES.map((state) => `"${state}"`).join(" | ")}`,
    );
  }
  if (!isNumber(value.createdAt)) {
    return fail("BackgroundAgentSummary.createdAt must be a number");
  }
  if (value.startedAt !== undefined && !isNumber(value.startedAt)) {
    return fail("BackgroundAgentSummary.startedAt must be a number when present");
  }
  if (value.endedAt !== undefined && !isNumber(value.endedAt)) {
    return fail("BackgroundAgentSummary.endedAt must be a number when present");
  }
  if (!isNumber(value.elapsedMs) || value.elapsedMs < 0) {
    return fail("BackgroundAgentSummary.elapsedMs must be a non-negative number");
  }
  if (!isNumber(value.costUsd) || value.costUsd < 0) {
    return fail("BackgroundAgentSummary.costUsd must be a non-negative number");
  }
  if (value.finalText !== undefined && !isString(value.finalText)) {
    return fail("BackgroundAgentSummary.finalText must be a string when present");
  }
  if (value.error !== undefined && !isString(value.error)) {
    return fail("BackgroundAgentSummary.error must be a string when present");
  }
  let transcript: BackgroundAgentTranscript | undefined;
  if (value.transcript !== undefined) {
    const result = validateBackgroundAgentTranscript(value.transcript);
    if (!result.ok) return fail(result.error);
    transcript = result.value;
  }
  const startedAt = value.startedAt;
  const endedAt = value.endedAt;
  const finalText = value.finalText;
  const error = value.error;
  return {
    ok: true,
    value: {
      id: value.id,
      sessionId: value.sessionId,
      task: value.task,
      modelId: value.modelId,
      status: value.status as BackgroundAgentState,
      createdAt: value.createdAt,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
      elapsedMs: value.elapsedMs,
      costUsd: value.costUsd,
      ...(finalText === undefined ? {} : { finalText }),
      ...(error === undefined ? {} : { error }),
      ...(transcript === undefined ? {} : { transcript }),
    },
  };
}

/** Validate one {@link BackgroundAgentTranscript}. */
export function validateBackgroundAgentTranscript(
  value: unknown,
): ValidationResult<BackgroundAgentTranscript> {
  if (!isRecord(value)) return fail("BackgroundAgentTranscript must be an object");
  if (!Array.isArray(value.lines)) {
    return fail("BackgroundAgentTranscript.lines must be an array");
  }
  const lines: string[] = [];
  for (let i = 0; i < value.lines.length; i++) {
    const line: unknown = value.lines[i];
    // Empty lines are allowed here where `stringList` would refuse them: a
    // rendered transcript legitimately contains blank separators, and dropping
    // them would change what a person reads.
    if (!isString(line)) {
      return fail(`BackgroundAgentTranscript.lines[${String(i)}] must be a string`);
    }
    lines.push(line);
  }
  if (typeof value.truncated !== "boolean") {
    return fail("BackgroundAgentTranscript.truncated must be a boolean");
  }
  if (!isNumber(value.droppedLines) || value.droppedLines < 0) {
    return fail("BackgroundAgentTranscript.droppedLines must be a non-negative number");
  }
  return {
    ok: true,
    value: { lines, truncated: value.truncated, droppedLines: value.droppedLines },
  };
}

/** Validate a `backgroundAgents` result. */
export function validateBackgroundAgentList(value: unknown): ValidationResult<BackgroundAgentList> {
  if (!isRecord(value)) return fail('BackgroundAgentList must be an object with an "agents" array');
  if (!Array.isArray(value.agents)) return fail("BackgroundAgentList.agents must be an array");
  const agents: BackgroundAgentSummary[] = [];
  for (let i = 0; i < value.agents.length; i++) {
    const result = validateBackgroundAgentSummary(value.agents[i]);
    if (!result.ok) return fail(`agents[${i}] invalid: ${result.error}`);
    agents.push(result.value);
  }
  // Required, not defaultable. A listing that silently stopped short reads as
  // the whole listing, and a person hunting for an agent they started last
  // month would conclude it never existed — the reason `SessionHistory` reports
  // its own truncation rather than leaving it to be inferred.
  if (typeof value.truncated !== "boolean") {
    return fail("BackgroundAgentList.truncated must be a boolean");
  }
  if (!isNumber(value.droppedAgents) || value.droppedAgents < 0) {
    return fail("BackgroundAgentList.droppedAgents must be a non-negative number");
  }
  return {
    ok: true,
    value: { agents, truncated: value.truncated, droppedAgents: value.droppedAgents },
  };
}

/** Validate a `startBackgroundAgent` result. */
export function validateStartedBackgroundAgent(
  value: unknown,
): ValidationResult<StartedBackgroundAgent> {
  if (!isRecord(value)) return fail("StartedBackgroundAgent must be an object");
  if (!isString(value.id) || value.id === "") {
    return fail("StartedBackgroundAgent.id must be a non-empty string");
  }
  if (!isString(value.sessionId) || value.sessionId === "") {
    return fail("StartedBackgroundAgent.sessionId must be a non-empty string");
  }
  return { ok: true, value: { id: value.id, sessionId: value.sessionId } };
}

/** Validate a `cancelBackgroundAgent` result. */
export function validateCancelBackgroundAgentResult(
  value: unknown,
): ValidationResult<CancelBackgroundAgentResult> {
  if (!isRecord(value)) return fail("CancelBackgroundAgentResult must be an object");
  if (typeof value.accepted !== "boolean") {
    return fail("CancelBackgroundAgentResult.accepted must be a boolean");
  }
  const agent = validateBackgroundAgentSummary(value.agent);
  if (!agent.ok) return fail(`CancelBackgroundAgentResult.agent invalid: ${agent.error}`);
  return { ok: true, value: { accepted: value.accepted, agent: agent.value } };
}

const ADOPT_DELIVERIES = ["prompt", "steer"] as const;

/** Validate an `adoptBackgroundAgent` result. */
export function validateAdoptBackgroundAgentResult(
  value: unknown,
): ValidationResult<AdoptBackgroundAgentResult> {
  if (!isRecord(value)) return fail("AdoptBackgroundAgentResult must be an object");
  if (!isString(value.agentId) || value.agentId === "") {
    return fail("AdoptBackgroundAgentResult.agentId must be a non-empty string");
  }
  if (
    !isString(value.delivered) ||
    !(ADOPT_DELIVERIES as readonly string[]).includes(value.delivered)
  ) {
    return fail('AdoptBackgroundAgentResult.delivered must be one of "prompt" | "steer"');
  }
  return {
    ok: true,
    value: { agentId: value.agentId, delivered: value.delivered as "prompt" | "steer" },
  };
}

const ORG_MEMORY_STATUSES = ["proposed", "active"] as const;

/**
 * Validate one {@link OrgMemoryEntry}.
 *
 * `status` is a closed enumeration checked by name, and anything that is not
 * literally `"active"` or `"proposed"` is **refused** rather than coerced. The
 * store itself fails closed the other way — it reads an unrecognised status as
 * `proposed` — and the two are not in conflict: the store is repairing a file
 * a person may have hand-edited, while this is a wire payload, where a status
 * nobody can name is a bug in the sender and quietly downgrading it would hide
 * the one field this whole feature turns on.
 */
export function validateOrgMemoryEntry(value: unknown): ValidationResult<OrgMemoryEntry> {
  if (!isRecord(value)) return fail("OrgMemoryEntry must be an object");
  if (!isString(value.id) || value.id === "") {
    return fail("OrgMemoryEntry.id must be a non-empty string");
  }
  if (!isString(value.role) || value.role === "") {
    return fail("OrgMemoryEntry.role must be a non-empty string");
  }
  if (!isString(value.text)) return fail("OrgMemoryEntry.text must be a string");
  if (
    !isString(value.status) ||
    !(ORG_MEMORY_STATUSES as readonly string[]).includes(value.status)
  ) {
    return fail('OrgMemoryEntry.status must be one of "proposed" | "active"');
  }
  if (!isNumber(value.createdAt)) return fail("OrgMemoryEntry.createdAt must be a number");
  if (value.origin !== undefined && !isString(value.origin)) {
    return fail("OrgMemoryEntry.origin must be a string when present");
  }
  const origin = value.origin;
  return {
    ok: true,
    value: {
      id: value.id,
      role: value.role,
      text: value.text,
      status: value.status as OrgMemoryStatus,
      createdAt: value.createdAt,
      ...(origin === undefined ? {} : { origin }),
    },
  };
}

/** Validate an `orgMemory` (or `revokeOrgMemory`) result. */
export function validateOrgMemoryList(value: unknown): ValidationResult<OrgMemoryList> {
  if (!isRecord(value)) return fail("OrgMemoryList must be an object");
  if (!Array.isArray(value.entries)) return fail("OrgMemoryList.entries must be an array");
  const entries: OrgMemoryEntry[] = [];
  for (let i = 0; i < value.entries.length; i++) {
    const result = validateOrgMemoryEntry(value.entries[i]);
    if (!result.ok) return fail(`entries[${i}] invalid: ${result.error}`);
    entries.push(result.value);
  }
  const warnings = stringList("OrgMemoryList.warnings", value.warnings);
  if (!warnings.ok) return fail(warnings.error);
  return { ok: true, value: { entries, warnings: warnings.value } };
}

/**
 * Validate a `proposeOrgMemory` result.
 *
 * The one assertion here that is not a type check: the entry a propose answers
 * with must be `proposed`. There is no request field that could have made it
 * active and no engine path that sets one, so an `active` entry arriving on
 * this response means something between the two is wrong about the gate this
 * whole verb exists to keep — and a client that rendered it would tell a
 * person their suggestion is already in force. Refused, loudly, at the seam.
 */
export function validateOrgMemoryProposal(value: unknown): ValidationResult<OrgMemoryProposal> {
  if (!isRecord(value)) return fail("OrgMemoryProposal must be an object");
  const entry = validateOrgMemoryEntry(value.entry);
  if (!entry.ok) return fail(`OrgMemoryProposal.entry invalid: ${entry.error}`);
  if (entry.value.status !== "proposed") {
    return fail(
      'OrgMemoryProposal.entry.status must be "proposed": a proposal that arrived active would ' +
        "mean an entry reached a role's prompt without a person approving it",
    );
  }
  const store = validateOrgMemoryList(value.store);
  if (!store.ok) return fail(`OrgMemoryProposal.store invalid: ${store.error}`);
  return { ok: true, value: { entry: entry.value, store: store.value } };
}

/**
 * Validate one {@link CheckpointEntry}.
 *
 * Rebuilt field by field, like every other payload here, and with one field
 * that earns extra suspicion: `label` is the head of a prompt — user- or
 * model-influenced text on its way into a menu a person clicks — so it is
 * rejected outright if it carries a control character rather than quietly
 * copied. `commandDescriptor`'s description gets the same treatment for the
 * same reason.
 */
export function validateCheckpointEntry(value: unknown): ValidationResult<CheckpointEntry> {
  if (!isRecord(value)) return fail("CheckpointEntry must be an object");
  if (!isString(value.id) || value.id === "") {
    return fail("CheckpointEntry.id must be a non-empty string");
  }
  if (!isString(value.label)) return fail("CheckpointEntry.label must be a string");
  if (hasControlCharacter(value.label)) {
    return fail("CheckpointEntry.label must not contain control characters");
  }
  if (!isNumber(value.timestamp)) return fail("CheckpointEntry.timestamp must be a number");
  if (!isNumber(value.fileCount) || value.fileCount < 0) {
    return fail("CheckpointEntry.fileCount must be a non-negative number");
  }
  if (!isNumber(value.deleteCount) || value.deleteCount < 0) {
    return fail("CheckpointEntry.deleteCount must be a non-negative number");
  }
  const files = stringList("CheckpointEntry.files", value.files);
  if (!files.ok) return fail(files.error);
  if (typeof value.truncatedFiles !== "boolean") {
    return fail("CheckpointEntry.truncatedFiles must be a boolean");
  }
  if (typeof value.forksConversation !== "boolean") {
    return fail("CheckpointEntry.forksConversation must be a boolean");
  }
  if (!isString(value.confirmation) || value.confirmation === "") {
    return fail("CheckpointEntry.confirmation must be a non-empty string");
  }
  return {
    ok: true,
    value: {
      id: value.id,
      label: value.label,
      timestamp: value.timestamp,
      fileCount: value.fileCount,
      deleteCount: value.deleteCount,
      files: files.value,
      truncatedFiles: value.truncatedFiles,
      forksConversation: value.forksConversation,
      confirmation: value.confirmation,
    },
  };
}

/**
 * Validate a `listCheckpoints` result.
 *
 * `available` is required rather than defaulted, for the reason
 * {@link validatePendingChanges}'s `dryRun` is: defaulted `true` an engine
 * with no checkpoint store looks like one that has simply not recorded
 * anything yet, and defaulted `false` a working engine looks broken. Neither
 * guess is safe, so a payload without it is not a payload.
 */
export function validateCheckpointList(value: unknown): ValidationResult<CheckpointList> {
  if (!isRecord(value)) return fail("CheckpointList must be an object");
  if (!isString(value.sessionId)) return fail("CheckpointList.sessionId must be a string");
  if (typeof value.available !== "boolean") {
    return fail("CheckpointList.available must be a boolean");
  }
  if (typeof value.truncated !== "boolean")
    return fail("CheckpointList.truncated must be a boolean");
  if (!isNumber(value.droppedCheckpoints) || value.droppedCheckpoints < 0) {
    return fail("CheckpointList.droppedCheckpoints must be a non-negative number");
  }
  if (!Array.isArray(value.checkpoints)) return fail("CheckpointList.checkpoints must be an array");
  const checkpoints: CheckpointEntry[] = [];
  for (let i = 0; i < value.checkpoints.length; i++) {
    const entry = validateCheckpointEntry(value.checkpoints[i]);
    if (!entry.ok) return fail(`CheckpointList.checkpoints[${String(i)}] invalid: ${entry.error}`);
    checkpoints.push(entry.value);
  }
  return {
    ok: true,
    value: {
      sessionId: value.sessionId,
      checkpoints,
      available: value.available,
      truncated: value.truncated,
      droppedCheckpoints: value.droppedCheckpoints,
    },
  };
}

/**
 * Validate a `rewindTo` result.
 *
 * `conversationForked` is required for the reason `available` above is: a
 * client that defaulted it would tell somebody their transcript matched their
 * files when only one of the two had moved.
 */
export function validateRewindResult(value: unknown): ValidationResult<RewindResult> {
  if (!isRecord(value)) return fail("RewindResult must be an object");
  if (!isString(value.sessionId)) return fail("RewindResult.sessionId must be a string");
  if (!isString(value.checkpointId) || value.checkpointId === "") {
    return fail("RewindResult.checkpointId must be a non-empty string");
  }
  const restored = stringList("RewindResult.restored", value.restored);
  if (!restored.ok) return fail(restored.error);
  const deleted = stringList("RewindResult.deleted", value.deleted);
  if (!deleted.ok) return fail(deleted.error);
  if (!Array.isArray(value.failed)) return fail("RewindResult.failed must be an array");
  const failed: RewindFailure[] = [];
  for (let i = 0; i < value.failed.length; i++) {
    const entry: unknown = value.failed[i];
    if (!isRecord(entry)) return fail(`RewindResult.failed[${String(i)}] must be an object`);
    if (!isString(entry.path) || entry.path === "") {
      return fail(`RewindResult.failed[${String(i)}].path must be a non-empty string`);
    }
    if (!isString(entry.message)) {
      return fail(`RewindResult.failed[${String(i)}].message must be a string`);
    }
    failed.push({ path: entry.path, message: entry.message });
  }
  if (typeof value.conversationForked !== "boolean") {
    return fail("RewindResult.conversationForked must be a boolean");
  }
  return {
    ok: true,
    value: {
      sessionId: value.sessionId,
      checkpointId: value.checkpointId,
      restored: restored.value,
      deleted: deleted.value,
      failed,
      conversationForked: value.conversationForked,
    },
  };
}

const WORKFLOW_ROLE_LANES = ["read", "exec", "write", "unknown", "undeclared"] as const;
const WORKFLOW_RUN_STATES = [
  "running",
  "done",
  "failed",
  "cancelled",
  "paused",
  "stalled",
  "resumable",
  "unknown",
] as const;
const WORKFLOW_STEP_STATUSES = [
  "running",
  "done",
  "failed",
  "skipped",
  "cancelled",
  "paused",
] as const;

/**
 * Validate one {@link WorkflowSummary}.
 *
 * The interesting field is `roles[].lane`, and it is validated against a
 * **closed** enumeration for the reason {@link validateMcpServerSummary}
 * validates a transport that way: this string is the sentence a person reads
 * before deciding whether a pipeline is safe to run, so an engine that grew a
 * sixth lane name tomorrow must fail loudly here rather than have a client
 * render a word it has no rule for.
 *
 * Everything else is copied out one field at a time — the discipline every
 * validator in this file keeps — so a catalog projection that grew careless
 * cannot put anything the contract does not define on the wire.
 */
export function validateWorkflowSummary(value: unknown): ValidationResult<WorkflowSummary> {
  if (!isRecord(value)) return fail("WorkflowSummary must be an object");
  if (!isString(value.name) || value.name === "") {
    return fail("WorkflowSummary.name must be a non-empty string");
  }
  if (!isString(value.description)) return fail("WorkflowSummary.description must be a string");
  if (hasControlCharacter(value.description)) {
    return fail("WorkflowSummary.description must not contain control characters");
  }
  if (!isString(value.source)) return fail("WorkflowSummary.source must be a string");
  if (!isNumber(value.stages) || value.stages < 0) {
    return fail("WorkflowSummary.stages must be a non-negative number");
  }
  if (!isNumber(value.steps) || value.steps < 0) {
    return fail("WorkflowSummary.steps must be a non-negative number");
  }
  if (value.budgetUsd !== undefined && (!isNumber(value.budgetUsd) || value.budgetUsd < 0)) {
    return fail("WorkflowSummary.budgetUsd must be a non-negative number when present");
  }
  if (
    value.stepTimeoutMs !== undefined &&
    (!isNumber(value.stepTimeoutMs) || value.stepTimeoutMs < 0)
  ) {
    return fail("WorkflowSummary.stepTimeoutMs must be a non-negative number when present");
  }
  if (!Array.isArray(value.roles)) return fail("WorkflowSummary.roles must be an array");
  const roles: WorkflowRoleSummary[] = [];
  for (let i = 0; i < value.roles.length; i++) {
    const entry: unknown = value.roles[i];
    if (!isRecord(entry)) return fail(`WorkflowSummary.roles[${String(i)}] must be an object`);
    if (!isString(entry.name) || entry.name === "") {
      return fail(`WorkflowSummary.roles[${String(i)}].name must be a non-empty string`);
    }
    if (!isString(entry.lane) || !(WORKFLOW_ROLE_LANES as readonly string[]).includes(entry.lane)) {
      return fail(
        `WorkflowSummary.roles[${String(i)}].lane must be one of ` +
          WORKFLOW_ROLE_LANES.map((lane) => `"${lane}"`).join(" | "),
      );
    }
    roles.push({ name: entry.name, lane: entry.lane as WorkflowRoleLane });
  }
  const summary: WorkflowSummary = {
    name: value.name,
    description: value.description,
    source: value.source,
    stages: value.stages,
    steps: value.steps,
    roles,
    ...(value.budgetUsd === undefined ? {} : { budgetUsd: value.budgetUsd }),
    ...(value.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: value.stepTimeoutMs }),
  };
  return { ok: true, value: summary };
}

/**
 * Validate a `listWorkflows` result.
 *
 * A bare array is accepted alongside `{ workflows: [...] }`, the same latitude
 * {@link validateModelCatalog} gives a leaner server.
 */
export function validateWorkflowCatalog(value: unknown): ValidationResult<WorkflowCatalog> {
  const raw = Array.isArray(value) ? value : isRecord(value) ? value.workflows : undefined;
  if (!Array.isArray(raw)) {
    return fail(
      'WorkflowCatalog must be an array of summaries or an object with a "workflows" array',
    );
  }
  const workflows: WorkflowSummary[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = validateWorkflowSummary(raw[i]);
    if (!entry.ok) return fail(`workflows[${String(i)}] invalid: ${entry.error}`);
    workflows.push(entry.value);
  }
  return { ok: true, value: { workflows } };
}

/**
 * Validate a `runWorkflow` / `resumeWorkflow` result.
 *
 * `budgetUsd` is the ceiling **in force**, not the one that was asked for, so
 * it is validated as a number rather than checked against anything: the engine
 * decided it, and re-deciding it here would be the second authority on a money
 * ceiling this file is careful not to become.
 */
export function validateWorkflowRunHandle(value: unknown): ValidationResult<WorkflowRunHandle> {
  if (!isRecord(value)) return fail("WorkflowRunHandle must be an object");
  if (!isString(value.runId) || value.runId === "") {
    return fail("WorkflowRunHandle.runId must be a non-empty string");
  }
  if (!isString(value.workflow)) return fail("WorkflowRunHandle.workflow must be a string");
  if (!isString(value.sessionId)) return fail("WorkflowRunHandle.sessionId must be a string");
  if (!isNumber(value.stages) || value.stages < 0) {
    return fail("WorkflowRunHandle.stages must be a non-negative number");
  }
  if (!isNumber(value.steps) || value.steps < 0) {
    return fail("WorkflowRunHandle.steps must be a non-negative number");
  }
  if (typeof value.resumed !== "boolean") {
    return fail("WorkflowRunHandle.resumed must be a boolean");
  }
  if (value.budgetUsd !== undefined && (!isNumber(value.budgetUsd) || value.budgetUsd < 0)) {
    return fail("WorkflowRunHandle.budgetUsd must be a non-negative number when present");
  }
  if (
    value.stepTimeoutMs !== undefined &&
    (!isNumber(value.stepTimeoutMs) || value.stepTimeoutMs < 0)
  ) {
    return fail("WorkflowRunHandle.stepTimeoutMs must be a non-negative number when present");
  }
  const handle: WorkflowRunHandle = {
    runId: value.runId,
    workflow: value.workflow,
    sessionId: value.sessionId,
    stages: value.stages,
    steps: value.steps,
    resumed: value.resumed,
    ...(value.budgetUsd === undefined ? {} : { budgetUsd: value.budgetUsd }),
    ...(value.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: value.stepTimeoutMs }),
  };
  return { ok: true, value: handle };
}

/** One step row of a `workflowStatus` detail, rebuilt field by field. */
function validateWorkflowRunStep(
  label: string,
  value: unknown,
): ValidationResult<WorkflowRunStepStatus> {
  if (!isRecord(value)) return fail(`${label} must be an object`);
  if (!isString(value.id) || value.id === "") {
    return fail(`${label}.id must be a non-empty string`);
  }
  if (!isNumber(value.stage)) return fail(`${label}.stage must be a number`);
  if (value.branch !== undefined && !isNumber(value.branch)) {
    return fail(`${label}.branch must be a number when present`);
  }
  if (value.agent !== undefined && !isString(value.agent)) {
    return fail(`${label}.agent must be a string when present`);
  }
  if (value.modelTag !== undefined && !isString(value.modelTag)) {
    return fail(`${label}.modelTag must be a string when present`);
  }
  if (
    !isString(value.status) ||
    !(WORKFLOW_STEP_STATUSES as readonly string[]).includes(value.status)
  ) {
    return fail(
      `${label}.status must be one of ` +
        WORKFLOW_STEP_STATUSES.map((status) => `"${status}"`).join(" | "),
    );
  }
  for (const key of ["tokens", "attempts", "startedAt", "endedAt"] as const) {
    if (value[key] !== undefined && !isNumber(value[key])) {
      return fail(`${label}.${key} must be a number when present`);
    }
  }
  if (value.patch !== undefined && !isString(value.patch)) {
    return fail(`${label}.patch must be a string when present`);
  }
  const step: WorkflowRunStepStatus = {
    id: value.id,
    stage: value.stage,
    status: value.status as WorkflowRunStepStatus["status"],
    ...(value.branch === undefined ? {} : { branch: value.branch as number }),
    ...(value.agent === undefined ? {} : { agent: value.agent as string }),
    ...(value.modelTag === undefined ? {} : { modelTag: value.modelTag as string }),
    ...(value.tokens === undefined ? {} : { tokens: value.tokens as number }),
    ...(value.attempts === undefined ? {} : { attempts: value.attempts as number }),
    ...(value.patch === undefined ? {} : { patch: value.patch as string }),
    ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt as number }),
    ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt as number }),
  };
  return { ok: true, value: step };
}

/**
 * Validate one {@link WorkflowRunStatus}.
 *
 * `questions` carries model-written prose into a surface a person reads and
 * answers, so it is checked for control characters on the same terms an MCP
 * server name is: a newline in a question would forge a second row in whatever
 * list the client draws.
 */
export function validateWorkflowRunStatus(value: unknown): ValidationResult<WorkflowRunStatus> {
  if (!isRecord(value)) return fail("WorkflowRunStatus must be an object");
  if (!isString(value.runId) || value.runId === "") {
    return fail("WorkflowRunStatus.runId must be a non-empty string");
  }
  if (!isString(value.workflow)) return fail("WorkflowRunStatus.workflow must be a string");
  if (!isString(value.state) || !(WORKFLOW_RUN_STATES as readonly string[]).includes(value.state)) {
    return fail(
      "WorkflowRunStatus.state must be one of " +
        WORKFLOW_RUN_STATES.map((state) => `"${state}"`).join(" | "),
    );
  }
  for (const key of ["stageCount", "stepsDone", "stepsTotal"] as const) {
    if (!isNumber(value[key]) || (value[key] as number) < 0) {
      return fail(`WorkflowRunStatus.${key} must be a non-negative number`);
    }
  }
  for (const key of ["stage", "spentUsd", "turns", "startedAt", "updatedAt"] as const) {
    if (value[key] !== undefined && !isNumber(value[key])) {
      return fail(`WorkflowRunStatus.${key} must be a number when present`);
    }
  }
  if (value.stopReason !== undefined && !isString(value.stopReason)) {
    return fail("WorkflowRunStatus.stopReason must be a string when present");
  }
  if (!Array.isArray(value.questions)) {
    return fail("WorkflowRunStatus.questions must be an array");
  }
  const questions: WorkflowRunQuestion[] = [];
  for (let i = 0; i < value.questions.length; i++) {
    const entry: unknown = value.questions[i];
    if (!isRecord(entry))
      return fail(`WorkflowRunStatus.questions[${String(i)}] must be an object`);
    if (!isString(entry.stepId) || entry.stepId === "") {
      return fail(`WorkflowRunStatus.questions[${String(i)}].stepId must be a non-empty string`);
    }
    if (!isString(entry.question)) {
      return fail(`WorkflowRunStatus.questions[${String(i)}].question must be a string`);
    }
    if (hasControlCharacter(entry.question)) {
      return fail(
        `WorkflowRunStatus.questions[${String(i)}].question must not contain control characters`,
      );
    }
    let diagnosis: string | undefined;
    if (entry.diagnosis !== undefined) {
      if (!isString(entry.diagnosis)) {
        return fail(
          `WorkflowRunStatus.questions[${String(i)}].diagnosis must be a string when present`,
        );
      }
      if (hasControlCharacter(entry.diagnosis)) {
        return fail(
          `WorkflowRunStatus.questions[${String(i)}].diagnosis must not contain control characters`,
        );
      }
      diagnosis = entry.diagnosis;
    }
    let raise: { kind: "turns" | "budget"; current?: number } | undefined;
    if (entry.raise !== undefined) {
      if (!isRecord(entry.raise)) {
        return fail(
          `WorkflowRunStatus.questions[${String(i)}].raise must be an object when present`,
        );
      }
      if (entry.raise.kind !== "turns" && entry.raise.kind !== "budget") {
        return fail(
          `WorkflowRunStatus.questions[${String(i)}].raise.kind must be "turns" or "budget"`,
        );
      }
      if (entry.raise.current !== undefined && !isNumber(entry.raise.current)) {
        return fail(
          `WorkflowRunStatus.questions[${String(i)}].raise.current must be a number when present`,
        );
      }
      raise = {
        kind: entry.raise.kind,
        ...(entry.raise.current === undefined ? {} : { current: entry.raise.current as number }),
      };
    }
    questions.push({
      stepId: entry.stepId,
      question: entry.question,
      ...(diagnosis === undefined ? {} : { diagnosis }),
      ...(raise === undefined ? {} : { raise }),
    });
  }
  let steps: WorkflowRunStepStatus[] | undefined;
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps)) {
      return fail("WorkflowRunStatus.steps must be an array when present");
    }
    steps = [];
    for (let i = 0; i < value.steps.length; i++) {
      const step = validateWorkflowRunStep(`WorkflowRunStatus.steps[${String(i)}]`, value.steps[i]);
      if (!step.ok) return fail(step.error);
      steps.push(step.value);
    }
  }
  const status: WorkflowRunStatus = {
    runId: value.runId,
    workflow: value.workflow,
    state: value.state as WorkflowRunState,
    stageCount: value.stageCount as number,
    stepsDone: value.stepsDone as number,
    stepsTotal: value.stepsTotal as number,
    questions,
    ...(value.stage === undefined ? {} : { stage: value.stage as number }),
    ...(value.spentUsd === undefined ? {} : { spentUsd: value.spentUsd as number }),
    ...(value.turns === undefined ? {} : { turns: value.turns as number }),
    ...(value.stopReason === undefined ? {} : { stopReason: value.stopReason }),
    ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt as number }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt as number }),
    ...(steps === undefined ? {} : { steps }),
  };
  return { ok: true, value: status };
}

/** Validate a `workflowStatus` result. */
export function validateWorkflowRuns(value: unknown): ValidationResult<WorkflowRuns> {
  const raw = Array.isArray(value) ? value : isRecord(value) ? value.runs : undefined;
  if (!Array.isArray(raw)) {
    return fail('WorkflowRuns must be an array of runs or an object with a "runs" array');
  }
  const runs: WorkflowRunStatus[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = validateWorkflowRunStatus(raw[i]);
    if (!entry.ok) return fail(`runs[${String(i)}] invalid: ${entry.error}`);
    runs.push(entry.value);
  }
  return { ok: true, value: { runs } };
}

/**
 * Validate the `capabilities` object an `authenticate` response may carry.
 *
 * Deliberately lenient rather than exhaustive, the way a capability object
 * has to be: every field is optional, an unrecognised field is dropped rather
 * than refused (a server ahead of this client may have added one), and a
 * `capabilities` that is present but malformed degrades to `{}` — the same
 * "predates the field" reading an absent object gets — rather than failing
 * the whole handshake over one advertisement neither side needs to agree on.
 *
 * @param value - The `capabilities` field of an `authenticate` response, or
 *   `undefined` when the server sent none.
 */
export function validateServerCapabilities(value: unknown): ServerCapabilities {
  if (!isRecord(value)) return {};
  const capabilities: ServerCapabilities = {};
  if (typeof value.ceilingRaise === "boolean") capabilities.ceilingRaise = value.ceilingRaise;
  return capabilities;
}

/** An array of non-empty strings, rebuilt element by element. */
function stringList(label: string, value: unknown): ValidationResult<string[]> {
  if (!Array.isArray(value)) return fail(`${label} must be an array`);
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry: unknown = value[i];
    if (!isString(entry) || entry === "") {
      return fail(`${label}[${String(i)}] must be a non-empty string`);
    }
    out.push(entry);
  }
  return { ok: true, value: out };
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

/**
 * Whether a string carries a control character.
 *
 * Checked by code point rather than by a regex, because a regex holding
 * control characters is itself the thing linters warn about. Applied to the
 * few wire strings that reach a rendered surface verbatim — an MCP server's
 * name is one — where a newline would forge a second menu row or log line.
 */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
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
