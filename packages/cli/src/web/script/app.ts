/**
 * The browser client's **impure** half: the WebSocket protocol client (with
 * authentication, reconnect/backoff and resubscribe), the DOM mounter, and
 * the app that wires the two to the page's static shell.
 *
 * Like `model.ts` this ships as literal script text so the page stays a single
 * self-contained file with no build step, and so the tests exercise the exact
 * source the browser runs. Everything here is injectable — the socket factory,
 * the timers, the random source, `document` and `window` — so the whole client
 * can be driven headlessly from vitest: against an in-memory fake socket for
 * backoff and auth-rejection paths, and against a real `ws` socket connected
 * to a real `ArcturnServer` for the permission round trip.
 *
 * ## The one DOM rule
 *
 * {@link createElement} is the only function in the client that touches the
 * DOM, and it uses `createElement` + `setAttribute` + `textContent` and
 * nothing else. There is no `innerHTML`, no `insertAdjacentHTML`, no
 * `document.write`, and no `eval` anywhere in the page, so server-, model- or
 * tool-authored text cannot become markup.
 *
 * ## Wire protocol
 *
 * Only the methods in `@arcturn/types`' `ClientRequest` union are ever sent
 * (`listSessions`, `createSession`, `openSession`, `prompt`, `steer`, `abort`,
 * `permissionDecision`), plus the server's pre-protocol `authenticate` frame
 * from `@arcturn/server`'s `auth.ts`. Nothing is invented.
 *
 * As in `attach.ts`, `prompt` resolves only when the whole remote *run* ends,
 * so it is sent with deadlines disabled and the inbound `runStart` event is
 * treated as the acknowledgement.
 *
 * @packageDocumentation
 */

/**
 * Browser source text defining `globalThis.ArcturnWeb.app`.
 *
 * Requires `MODEL_SCRIPT` to have been evaluated first. Bootstraps itself only
 * when a real `document` exists, so evaluating it in Node is side-effect free.
 */
export const APP_SCRIPT = `
(function (root) {
  "use strict";

  var model = (root.ArcturnWeb || {}).model;
  var TOKEN_KEY = "arcturn.web.token";
  var SESSION_KEY = "arcturn.web.session";

  function noop() {}

  /* --------------------------------------------------------------- transport */

  /**
   * A reconnecting client for the Arcturn wire protocol.
   *
   * Status values: "connecting", "authenticating", "online", "offline",
   * "unauthorized". Only "unauthorized" is terminal — a rejected token must
   * not be retried in a loop.
   */
  function createClient(options) {
    var opts = options || {};
    var url = String(opts.url || "");
    var token = typeof opts.token === "string" && opts.token !== "" ? opts.token : null;
    var socketFactory = opts.socketFactory;
    var timers = opts.timers || {};
    var setTimer = timers.setTimeout || setTimeout;
    var clearTimer = timers.clearTimeout || clearTimeout;
    var random = opts.random || Math.random;
    var backoff = opts.backoff || {};
    var probeIntervalMs = typeof opts.probeIntervalMs === "number" ? opts.probeIntervalMs : 25000;
    var defaultTimeoutMs = typeof opts.requestTimeoutMs === "number" ? opts.requestTimeoutMs : 20000;
    var onEvent = opts.onEvent || noop;
    var onSessions = opts.onSessions || noop;
    var onStatus = opts.onStatus || noop;
    var onReady = opts.onReady || noop;
    var onProtocolError = opts.onProtocolError || noop;

    var socket = null;
    var pending = {};
    var nextId = 0;
    var attempt = 0;
    var stopped = false;
    var status = "offline";
    var retryTimer = null;
    var probeTimer = null;

    function setStatus(next, detail) {
      if (status === next) return;
      status = next;
      onStatus(next, detail);
    }

    function failPending(code, message) {
      var ids = Object.keys(pending);
      for (var i = 0; i < ids.length; i++) {
        var entry = pending[ids[i]];
        delete pending[ids[i]];
        if (entry.timer !== null) clearTimer(entry.timer);
        entry.reject({ code: code, message: message });
      }
    }

    function stopProbe() {
      if (probeTimer !== null) {
        clearTimer(probeTimer);
        probeTimer = null;
      }
    }

    function startProbe() {
      stopProbe();
      if (probeIntervalMs <= 0) return;
      probeTimer = setTimer(function () {
        probeTimer = null;
        if (status !== "online") return;
        request("listSessions", undefined, { timeoutMs: Math.max(5000, probeIntervalMs / 2) })
          .then(function () { startProbe(); })
          .catch(function () { forceReconnect(); });
      }, probeIntervalMs);
    }

    function scheduleRetry() {
      if (stopped || retryTimer !== null) return;
      var delay = model.backoffDelay(attempt, backoff, random);
      attempt += 1;
      setStatus("offline", delay);
      retryTimer = setTimer(function () {
        retryTimer = null;
        connect();
      }, delay);
    }

    function connect() {
      if (stopped || socket !== null) return;
      setStatus("connecting");
      var ws;
      try {
        ws = socketFactory(url);
      } catch (error) {
        scheduleRetry();
        return;
      }
      socket = ws;
      ws.onopen = function () {
        if (socket !== ws) return;
        if (token === null) {
          ready();
          return;
        }
        setStatus("authenticating");
        // The server closes any connection whose first frame is not this one.
        requestOn(ws, "authenticate", { token: token }, { timeoutMs: 15000 })
          .then(function () { if (socket === ws) ready(); })
          .catch(function () { if (socket === ws) reject4401(ws); });
      };
      ws.onmessage = function (message) {
        if (socket === ws) receive(message && message.data);
      };
      ws.onclose = function (event) {
        if (socket !== ws) return;
        var code = event && typeof event.code === "number" ? event.code : 0;
        socket = null;
        stopProbe();
        failPending("closed", "The connection closed.");
        if (code === 4401) {
          setStatus("unauthorized", "The server rejected this token.");
          stopped = true;
          return;
        }
        scheduleRetry();
      };
      ws.onerror = function () {
        // A socket error is always followed by a close event, which retries.
      };
    }

    function reject4401(ws) {
      setStatus("unauthorized", "The server rejected this token.");
      stopped = true;
      socket = null;
      try {
        ws.close();
      } catch (error) {
        // Already closing.
      }
    }

    function ready() {
      attempt = 0;
      setStatus("online");
      startProbe();
      try {
        onReady();
      } catch (error) {
        onProtocolError(String(error));
      }
    }

    function receive(raw) {
      var parsed;
      try {
        parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
      } catch (error) {
        onProtocolError("Malformed frame from the server.");
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      if (parsed.kind === "event") {
        onEvent(String(parsed.sessionId), parsed.event);
        return;
      }
      if (parsed.kind === "sessions") {
        onSessions(parsed.sessions || []);
        return;
      }
      if (parsed.kind !== "response") return;
      var entry = pending[parsed.id];
      if (!entry) return;
      delete pending[parsed.id];
      if (entry.timer !== null) clearTimer(entry.timer);
      if (parsed.error) {
        entry.reject({
          code: String(parsed.error.code || "internal"),
          message: String(parsed.error.message || "Request failed.")
        });
        return;
      }
      entry.resolve(parsed.result);
    }

    function requestOn(ws, method, params, settings) {
      var config = settings || {};
      nextId += 1;
      var id = "w" + nextId;
      var frame = { id: id, method: method };
      if (params !== undefined) frame.params = params;
      return new Promise(function (resolve, reject) {
        var timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : defaultTimeoutMs;
        var entry = { resolve: resolve, reject: reject, timer: null };
        pending[id] = entry;
        if (timeoutMs > 0) {
          entry.timer = setTimer(function () {
            if (!pending[id]) return;
            delete pending[id];
            reject({ code: "timeout", message: "The server did not answer in time." });
          }, timeoutMs);
        }
        try {
          ws.send(JSON.stringify(frame));
        } catch (error) {
          delete pending[id];
          if (entry.timer !== null) clearTimer(entry.timer);
          reject({ code: "closed", message: "The connection is not open." });
        }
      });
    }

    function request(method, params, settings) {
      if (socket === null || status === "unauthorized") {
        return Promise.reject({ code: "closed", message: "Not connected." });
      }
      return requestOn(socket, method, params, settings);
    }

    function forceReconnect() {
      var ws = socket;
      socket = null;
      stopProbe();
      failPending("closed", "The connection was reset.");
      if (ws) {
        try {
          ws.onclose = null;
          ws.onmessage = null;
          ws.onopen = null;
          ws.close();
        } catch (error) {
          // Already gone.
        }
      }
      setStatus("offline");
      if (!stopped) connect();
    }

    function retryNow() {
      if (status === "unauthorized") return;
      if (retryTimer !== null) {
        clearTimer(retryTimer);
        retryTimer = null;
      }
      attempt = 0;
      if (socket === null) connect();
    }

    function close() {
      stopped = true;
      stopProbe();
      if (retryTimer !== null) {
        clearTimer(retryTimer);
        retryTimer = null;
      }
      failPending("closed", "The client closed the connection.");
      var ws = socket;
      socket = null;
      if (ws) {
        try {
          ws.close();
        } catch (error) {
          // Already gone.
        }
      }
      setStatus("offline");
    }

    return {
      connect: connect,
      close: close,
      request: request,
      retryNow: retryNow,
      forceReconnect: forceReconnect,
      getStatus: function () { return status; },
      getAttempt: function () { return attempt; }
    };
  }

  /* -------------------------------------------------------------------- DOM */

  /**
   * Build one real element from a vnode.
   *
   * The only DOM writes in the entire client: createElement, setAttribute and
   * textContent. No HTML is ever parsed, so hostile text stays text.
   */
  function createElement(doc, vnode) {
    var element = doc.createElement(vnode.tag);
    if (vnode.cls) element.setAttribute("class", vnode.cls);
    if (vnode.attrs) {
      var names = Object.keys(vnode.attrs);
      for (var a = 0; a < names.length; a++) {
        element.setAttribute(names[a], String(vnode.attrs[names[a]]));
      }
    }
    if (typeof vnode.text === "string") element.textContent = vnode.text;
    var children = vnode.children || [];
    for (var i = 0; i < children.length; i++) {
      element.appendChild(createElement(doc, children[i]));
    }
    return element;
  }

  /** Reconcile a container's children against keyed, revisioned vnodes. */
  function mount(doc, container, nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var vnode = nodes[i];
      var key = vnode.key === undefined ? String(i) : String(vnode.key);
      var rev = vnode.rev === undefined ? "0" : String(vnode.rev);
      var existing = container.childNodes[i];
      if (existing && existing.getAttribute &&
        existing.getAttribute("data-key") === key &&
        existing.getAttribute("data-rev") === rev) {
        continue;
      }
      var element = createElement(doc, vnode);
      element.setAttribute("data-key", key);
      element.setAttribute("data-rev", rev);
      if (existing) container.replaceChild(element, existing);
      else container.appendChild(element);
    }
    while (container.childNodes.length > nodes.length) {
      container.removeChild(container.childNodes[container.childNodes.length - 1]);
    }
  }

  /* -------------------------------------------------------------- token I/O */

  /**
   * Take the token out of the URL and hide it again immediately: it must never
   * sit in the address bar, in history, or in anything that gets shared.
   *
   * The URL fragment is the only accepted carrier: unlike a query parameter,
   * a fragment is never sent to a server (access logs, proxies, browser
   * history sync), which is the "never sent to a server" invariant this
   * module and web/server.ts both document. A query-string token would break
   * that invariant, so it is deliberately not read here, not even as a
   * fallback.
   */
  function takeTokenFromLocation(win) {
    var location = win.location || {};
    var found = null;
    var hash = String(location.hash || "");
    var match = /(?:^#|&)token=([^&]*)/.exec(hash);
    if (match) found = decodeURIComponent(match[1]);
    if (found !== null && win.history && win.history.replaceState) {
      try {
        win.history.replaceState(
          null,
          "",
          String(location.pathname || "/") + String(location.search || ""),
        );
      } catch (error) {
        // A sandboxed document may refuse; the token is still never rendered.
      }
    }
    return found === null || found === "" ? null : found;
  }

  function storage(win) {
    try {
      return win.sessionStorage || null;
    } catch (error) {
      return null;
    }
  }

  function readStored(win, key) {
    var store = storage(win);
    if (!store) return null;
    try {
      return store.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStored(win, key, value) {
    var store = storage(win);
    if (!store) return;
    try {
      if (value === null) store.removeItem(key);
      else store.setItem(key, value);
    } catch (error) {
      // Private mode; the session simply will not be remembered.
    }
  }

  /** Resolve the WebSocket URL: an explicit ?ws= wins, else the page's host. */
  function resolveWsUrl(win, config) {
    var location = win.location || {};
    var search = String(location.search || "");
    var explicit = /(?:^\\?|&)ws=([^&]*)/.exec(search);
    if (explicit) return decodeURIComponent(explicit[1]);
    if (config && typeof config.wsUrl === "string" && config.wsUrl !== "") return config.wsUrl;
    var secure = String(location.protocol || "http:") === "https:";
    var host = String(location.hostname || "127.0.0.1");
    if (host.indexOf(":") >= 0 && host.charAt(0) !== "[") host = "[" + host + "]";
    var port = config && config.wsPort ? config.wsPort : location.port;
    return (secure ? "wss://" : "ws://") + host + ":" + port;
  }

  /* -------------------------------------------------------------------- app */

  /** Wire the page's static shell to a live session. */
  function boot(doc, win) {
    var config = win.__ARCTURN__ || {};
    var state = model.createState();
    var sessions = [];
    var currentSession = null;
    var openPermission = null;
    var permissionGate = { scrollable: false, atBottom: true };
    var renderQueued = false;
    var spinnerFrame = 0;
    var reduceMotion = false;
    try {
      reduceMotion = !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (error) {
      reduceMotion = false;
    }

    function byId(id) {
      return doc.getElementById(id);
    }

    var ui = {
      conn: byId("conn"),
      title: byId("session-title"),
      cwd: byId("session-cwd"),
      transcript: byId("transcript"),
      live: byId("live"),
      todos: byId("todos"),
      activity: byId("activity"),
      activityText: byId("activity-text"),
      spinner: byId("activity-spinner"),
      composer: byId("composer"),
      input: byId("composer-input"),
      send: byId("btn-send"),
      abort: byId("btn-abort"),
      sessionsButton: byId("btn-sessions"),
      scrim: byId("scrim"),
      permission: byId("permission"),
      permissionBody: byId("permission-body"),
      permissionGate: byId("permission-gate"),
      permissionAllow: byId("perm-allow"),
      permissionAlways: byId("perm-always"),
      permissionDeny: byId("perm-deny"),
      sessionsSheet: byId("sessions"),
      sessionsList: byId("sessions-list"),
      sessionsNew: byId("btn-new-session"),
      sessionsClose: byId("btn-close-sessions"),
      token: byId("token"),
      tokenForm: byId("token-form"),
      tokenInput: byId("token-input"),
      tokenError: byId("token-error"),
      tokenSkip: byId("btn-token-skip")
    };

    /* ------------------------------------------------------------ rendering */

    function requestRender() {
      if (renderQueued) return;
      renderQueued = true;
      var schedule = win.requestAnimationFrame
        ? function (fn) { win.requestAnimationFrame(fn); }
        : function (fn) { setTimeout(fn, 16); };
      schedule(function () {
        renderQueued = false;
        render();
      });
    }

    function render() {
      var container = ui.transcript;
      var pinned = container.scrollHeight - container.scrollTop - container.clientHeight < 96;
      mount(doc, container, model.transcriptNodes(state));
      mount(doc, ui.live, model.liveNodes(state));
      mount(doc, ui.todos, model.todoNodes(state));
      if (pinned) container.scrollTop = container.scrollHeight;

      ui.activity.hidden = !state.running;
      if (state.running) {
        ui.activityText.textContent = model.activityText(state);
        ui.spinner.textContent = reduceMotion
          ? model.MARK.dot
          : model.SPINNER[spinnerFrame % model.SPINNER.length];
      }
      ui.abort.hidden = !state.running;
      ui.send.textContent = state.running ? "Steer" : "Send";
      renderPermission();
    }

    function renderPermission() {
      var next = state.permissions.length > 0 ? state.permissions[0] : null;
      if (next === null) {
        openPermission = null;
        ui.permission.hidden = true;
        updateScrim();
        return;
      }
      if (openPermission && openPermission.id === next.id) {
        updateGate();
        return;
      }
      openPermission = next;
      mount(doc, ui.permissionBody, model.permissionNodes(next));
      ui.permission.hidden = false;
      permissionGate = { scrollable: false, atBottom: true };
      updateScrim();
      measureGate();
      if (ui.permissionDeny.focus) ui.permissionDeny.focus();
    }

    function measureGate() {
      var body = ui.permissionBody;
      permissionGate.scrollable = body.scrollHeight - body.clientHeight > 8;
      permissionGate.atBottom = !permissionGate.scrollable;
      updateGate();
    }

    function updateGate() {
      var allowed = model.approvalGate(permissionGate);
      ui.permissionAllow.disabled = !allowed;
      // A session-scoped grant is minted by the ENGINE from the request's own
      // suggestedRule, so a request carrying none is not repeatable and the
      // button must not be offered — the engine refuses a scope it has no rule
      // for rather than quietly downgrading it to an allow-once.
      ui.permissionAlways.disabled = !allowed || !openPermission || !openPermission.suggestedRule;
      ui.permissionGate.hidden = allowed;
    }

    function updateScrim() {
      ui.scrim.hidden = ui.permission.hidden && ui.sessionsSheet.hidden && ui.token.hidden;
    }

    function notice(level, message) {
      model.applyEvent(state, { type: "notice", level: level, text: message });
      requestRender();
    }

    function setStatusLabel(next, detail) {
      ui.conn.setAttribute("data-state", next);
      var label = next;
      if (next === "offline" && typeof detail === "number") {
        label = "reconnecting in " + Math.max(1, Math.round(detail / 1000)) + "s";
      }
      ui.conn.textContent = label;
      if (next === "unauthorized") showTokenSheet(String(detail || "The token was rejected."));
    }

    /* --------------------------------------------------------------- client */

    var wsUrl = resolveWsUrl(win, config);
    var token = takeTokenFromLocation(win);
    if (token !== null) writeStored(win, TOKEN_KEY, token);
    else token = readStored(win, TOKEN_KEY);

    var client = createClient({
      url: wsUrl,
      token: token === null ? "" : token,
      socketFactory: function (url) { return new win.WebSocket(url); },
      onStatus: setStatusLabel,
      onEvent: onEvent,
      onSessions: function (list) {
        sessions = list;
        renderSessions();
      },
      onReady: onReady,
      onProtocolError: function (message) { notice("warn", message); }
    });

    function onEvent(sessionId, event) {
      if (currentSession && sessionId !== currentSession.sessionId) return;
      model.applyEvent(state, event);
      requestRender();
    }

    function onReady() {
      var wanted = currentSession ? currentSession.sessionId : readStored(win, SESSION_KEY);
      client.request("listSessions").then(function (result) {
        sessions = (result && result.sessions) || [];
        renderSessions();
        if (wanted) return openSession(wanted, currentSession !== null);
        var newest = null;
        for (var i = 0; i < sessions.length; i++) {
          if (!newest || Number(sessions[i].createdAt || 0) > Number(newest.createdAt || 0)) {
            newest = sessions[i];
          }
        }
        if (newest) return openSession(newest.sessionId, false);
        return createSession();
      }).catch(function (error) {
        notice("error", "Could not list sessions: " + describe(error));
      });
    }

    function openSession(sessionId, resubscribe) {
      return client.request("openSession", { sessionId: sessionId }).then(function (header) {
        var switching = !currentSession || currentSession.sessionId !== sessionId;
        currentSession = header && header.sessionId ? header : { sessionId: sessionId, cwd: "" };
        writeStored(win, SESSION_KEY, currentSession.sessionId);
        if (switching && !resubscribe) {
          state = model.createState();
        }
        if (resubscribe) notice("info", "Reconnected.");
        ui.title.textContent = currentSession.title || currentSession.sessionId;
        ui.cwd.textContent = currentSession.cwd || "";
        renderSessions();
        requestRender();
      }).catch(function (error) {
        if (resubscribe) {
          notice("warn", "Could not re-attach: " + describe(error));
          return;
        }
        notice("error", "Could not open session: " + describe(error));
      });
    }

    function createSession() {
      // The wire requires a cwd; "." resolves to the served workspace root
      // server-side (SessionHost confines it), and an existing session's cwd
      // is a better guess when one is known.
      var cwd = ".";
      for (var i = 0; i < sessions.length; i++) {
        if (sessions[i] && typeof sessions[i].cwd === "string") cwd = sessions[i].cwd;
      }
      return client.request("createSession", { cwd: cwd }).then(function (header) {
        state = model.createState();
        return openSession(header.sessionId, false);
      }).catch(function (error) {
        notice("error", "Could not create a session: " + describe(error));
      });
    }

    function describe(error) {
      if (!error) return "unknown error";
      if (typeof error === "string") return error;
      if (error.message) return String(error.message);
      return String(error);
    }

    /* ---------------------------------------------------------- interaction */

    function submit() {
      var value = String(ui.input.value || "").trim();
      if (value === "") return;
      if (!currentSession) {
        notice("warn", "Not attached to a session yet.");
        return;
      }
      var sessionId = currentSession.sessionId;
      ui.input.value = "";
      resizeInput();
      if (state.running) {
        client.request("steer", { sessionId: sessionId, text: value })
          .catch(function (error) { notice("error", "Steer failed: " + describe(error)); });
        notice("info", "steering: " + value);
        return;
      }
      // prompt() resolves only when the whole run ends, so deadlines are off
      // and runStart is the acknowledgement (see attach.ts).
      client.request("prompt", { sessionId: sessionId, text: value }, { timeoutMs: 0 })
        .catch(function (error) {
          if (error && error.code === "closed") return;
          notice("error", "Prompt failed: " + describe(error));
        });
    }

    function decide(behavior, persist) {
      if (!openPermission || !currentSession) return;
      var request = openPermission;
      var decision = { requestId: request.id, behavior: behavior };
      if (behavior === "deny") {
        decision.message =
          "The user denied this action. Do not retry it; choose another approach or ask.";
      }
      // "session", not "project": this page is a REMOTE client, and RFC 0005
      // §1.2 is explicit that nothing persists to disk from one. The scope
      // rides beside the decision and the ENGINE mints the rule from the
      // suggestedRule it put on the ask — a client says how long, never what.
      var scope = persist ? "session" : undefined;
      state.permissions = state.permissions.filter(function (open) {
        return open.id !== request.id;
      });
      openPermission = null;
      ui.permission.hidden = true;
      updateScrim();
      requestRender();
      var params = { sessionId: currentSession.sessionId, decision: decision };
      if (scope) params.scope = scope;
      client.request("permissionDecision", params)
        .catch(function (error) { notice("error", "Decision failed: " + describe(error)); });
    }

    function renderSessions() {
      mount(doc, ui.sessionsList, model.sessionNodes(sessions,
        currentSession ? currentSession.sessionId : ""));
    }

    function showSheet(element, show) {
      element.hidden = !show;
      updateScrim();
    }

    function showTokenSheet(message) {
      ui.tokenError.textContent = message;
      ui.tokenError.hidden = message === "";
      ui.tokenInput.value = "";
      showSheet(ui.token, true);
      if (ui.tokenInput.focus) ui.tokenInput.focus();
    }

    function resizeInput() {
      ui.input.style.height = "auto";
      ui.input.style.height = Math.min(ui.input.scrollHeight, win.innerHeight * 0.3) + "px";
    }

    ui.composer.addEventListener("submit", function (event) {
      event.preventDefault();
      submit();
    });
    ui.input.addEventListener("input", resizeInput);
    ui.input.addEventListener("keydown", function (event) {
      var coarse = false;
      try {
        coarse = !!(win.matchMedia && win.matchMedia("(pointer: coarse)").matches);
      } catch (error) {
        coarse = false;
      }
      var send = event.key === "Enter" && !event.shiftKey &&
        (!coarse || event.metaKey || event.ctrlKey);
      if (send) {
        event.preventDefault();
        submit();
      }
    });
    ui.abort.addEventListener("click", function () {
      if (!currentSession) return;
      client.request("abort", { sessionId: currentSession.sessionId })
        .catch(function (error) { notice("error", "Abort failed: " + describe(error)); });
    });
    ui.permissionAllow.addEventListener("click", function () { decide("allow", false); });
    ui.permissionAlways.addEventListener("click", function () { decide("allow", true); });
    ui.permissionDeny.addEventListener("click", function () { decide("deny", false); });
    ui.permissionBody.addEventListener("scroll", function () {
      var body = ui.permissionBody;
      permissionGate.atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 12;
      updateGate();
    });
    ui.sessionsButton.addEventListener("click", function () {
      renderSessions();
      showSheet(ui.sessionsSheet, true);
      client.request("listSessions").then(function (result) {
        sessions = (result && result.sessions) || [];
        renderSessions();
      }).catch(noop);
    });
    ui.sessionsClose.addEventListener("click", function () {
      showSheet(ui.sessionsSheet, false);
    });
    ui.sessionsNew.addEventListener("click", function () {
      showSheet(ui.sessionsSheet, false);
      createSession();
    });
    ui.sessionsList.addEventListener("click", function (event) {
      var target = event.target;
      while (target && target !== ui.sessionsList && !target.getAttribute("data-session")) {
        target = target.parentNode;
      }
      if (!target || target === ui.sessionsList) return;
      var sessionId = target.getAttribute("data-session");
      showSheet(ui.sessionsSheet, false);
      if (!sessionId || (currentSession && currentSession.sessionId === sessionId)) return;
      state = model.createState();
      currentSession = null;
      openSession(sessionId, false);
    });
    ui.tokenForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = String(ui.tokenInput.value || "");
      ui.tokenInput.value = "";
      if (value === "") return;
      writeStored(win, TOKEN_KEY, value);
      showSheet(ui.token, false);
      win.location.reload();
    });
    ui.tokenSkip.addEventListener("click", function () {
      writeStored(win, TOKEN_KEY, null);
      showSheet(ui.token, false);
      win.location.reload();
    });
    ui.scrim.addEventListener("click", function () {
      if (!ui.sessionsSheet.hidden) showSheet(ui.sessionsSheet, false);
    });
    doc.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (!ui.sessionsSheet.hidden) showSheet(ui.sessionsSheet, false);
    });

    // A phone that locks its screen suspends the socket without closing it;
    // coming back to the tab is the moment to check and reconnect at once.
    doc.addEventListener("visibilitychange", function () {
      if (doc.visibilityState === "visible") client.retryNow();
    });
    win.addEventListener("online", function () { client.retryNow(); });
    win.addEventListener("pageshow", function () { client.retryNow(); });

    // Keep the composer above the on-screen keyboard: the visual viewport
    // shrinks when it opens, and 100dvh does not follow on every browser.
    var viewport = win.visualViewport;
    function fitViewport() {
      var height = viewport ? viewport.height : win.innerHeight;
      doc.documentElement.style.setProperty("--app-h", Math.round(height) + "px");
      requestRender();
    }
    if (viewport && viewport.addEventListener) {
      viewport.addEventListener("resize", fitViewport);
      viewport.addEventListener("scroll", fitViewport);
    }
    win.addEventListener("resize", fitViewport);
    fitViewport();

    var interval = win.setInterval || setInterval;
    interval(function () {
      if (!state.running) return;
      spinnerFrame += 1;
      ui.activityText.textContent = model.activityText(state);
      ui.spinner.textContent = reduceMotion
        ? model.MARK.dot
        : model.SPINNER[spinnerFrame % model.SPINNER.length];
    }, reduceMotion ? 1000 : 120);

    render();
    client.connect();
    return { client: client, render: render, getState: function () { return state; } };
  }

  root.ArcturnWeb = root.ArcturnWeb || {};
  root.ArcturnWeb.app = {
    createClient: createClient,
    createElement: createElement,
    mount: mount,
    resolveWsUrl: resolveWsUrl,
    takeTokenFromLocation: takeTokenFromLocation,
    boot: boot
  };

  if (typeof document !== "undefined" && typeof window !== "undefined") {
    root.ArcturnWeb.instance = boot(document, window);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
`;
