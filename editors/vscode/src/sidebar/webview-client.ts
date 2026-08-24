/**
 * The webview's own script and stylesheet, as strings.
 *
 * They are inlined into the page under a nonce rather than shipped as files
 * under `media/` deliberately: the CSP in `webview-html.ts` grants
 * `script-src 'nonce-…'` and nothing else, and inlining means the sidebar has
 * no packaging dependency at all — esbuild bundles this module into
 * `dist/extension.js` and there is no second asset that a `.vscodeignore`
 * could drop from the VSIX.
 *
 * Two rules the script keeps, both checked by `webview-html.test.ts`:
 *
 * 1. **No HTML from strings.** Every node is built with `createElement` and
 *    filled with `textContent`. Assistant output, tool arguments and tool
 *    results are model- and tool-controlled text; the only safe way to render
 *    them is as text, so `innerHTML` and friends appear nowhere.
 * 2. **Inbound messages are validated.** `KNOWN_HOST_MESSAGES` gates every
 *    `message` event before a field of it is read — the mirror image of
 *    `parseWebviewMessage` on the host side.
 *
 * Both strings must avoid a literal `</script` / `</style` sequence, which
 * would terminate the inline block early.
 */

/** The sidebar's stylesheet. Colours are VS Code theme tokens only. */
export const SIDEBAR_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}
#root { display: flex; flex-direction: column; height: 100vh; }
.hidden { display: none !important; }
#banner {
  margin: 8px;
  padding: 8px 10px;
  border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
  background: var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background));
  border-radius: 4px;
}
#banner .banner-text { display: block; margin-bottom: 6px; white-space: pre-wrap; }
.engine-output {
  margin: 0 0 8px;
  padding: 6px 8px;
  max-height: 12em;
  overflow: auto;
  border-left: 2px solid var(--vscode-editorError-foreground, var(--vscode-panel-border));
  background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
  font-family: var(--vscode-editor-font-family);
  font-size: 0.95em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
#banner-actions { margin-top: 0; }
#transcript {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 8px;
  outline-offset: -2px;
}
.block { margin-bottom: 10px; }
.user {
  padding: 6px 8px;
  border-left: 3px solid var(--vscode-textLink-foreground);
  background: var(--vscode-editorWidget-background);
  white-space: pre-wrap;
}
.text { white-space: pre-wrap; line-height: 1.45; }
.notice { padding: 4px 8px; border-radius: 3px; white-space: pre-wrap; }
.notice-info { color: var(--vscode-descriptionForeground); }
.notice-warn { color: var(--vscode-editorWarning-foreground); }
.notice-error { color: var(--vscode-editorError-foreground); }
.disclosure {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: none;
  border-radius: 3px;
  text-align: left;
  font: inherit;
  color: var(--vscode-foreground);
  background: var(--vscode-editorWidget-background);
  cursor: pointer;
}
.disclosure:hover { background: var(--vscode-list-hoverBackground); }
.disclosure:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.chevron { width: 1em; color: var(--vscode-descriptionForeground); }
.tool-name { font-family: var(--vscode-editor-font-family); }
.tool-status { margin-left: auto; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
.status-error { color: var(--vscode-editorError-foreground); }
.status-denied { color: var(--vscode-editorWarning-foreground); }
.status-awaitingPermission { color: var(--vscode-editorWarning-foreground); }
.body {
  margin: 4px 0 0 1.4em;
  padding: 6px 8px;
  border-left: 1px solid var(--vscode-panel-border);
  font-family: var(--vscode-editor-font-family);
  font-size: 0.95em;
  white-space: pre-wrap;
  overflow-x: auto;
}
.body-label { display: block; color: var(--vscode-descriptionForeground); margin-top: 6px; }
.thinking .body { font-style: italic; color: var(--vscode-descriptionForeground); }
#side { padding: 0 8px; }
#todos { list-style: none; margin: 0 0 8px; padding: 0; }
#todos li { padding: 2px 0; }
.todo-done { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
.todo-inProgress { color: var(--vscode-textLink-foreground); }
#plan { white-space: pre-wrap; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
#composer {
  border-top: 1px solid var(--vscode-panel-border);
  padding: 8px;
  background: var(--vscode-sideBar-background);
}
#prompt {
  width: 100%;
  resize: vertical;
  min-height: 52px;
  padding: 6px;
  font-family: inherit;
  font-size: inherit;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 3px;
}
#prompt:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.row { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
button {
  font: inherit;
  padding: 4px 10px;
  border: none;
  border-radius: 3px;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  cursor: pointer;
}
button.secondary {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
}
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
#cost {
  margin-left: auto;
  font-size: 0.9em;
  font-variant-numeric: tabular-nums;
  color: var(--vscode-descriptionForeground);
}
#hint { font-size: 0.9em; color: var(--vscode-descriptionForeground); }
`;

/** The sidebar's script. Runs under a nonce; builds every node as text. */
export const SIDEBAR_SCRIPT = `
"use strict";
(function () {
  var vscode = acquireVsCodeApi();
  var KNOWN_HOST_MESSAGES = { state: 1, connection: 1, cost: 1 };

  var banner = document.getElementById("banner");
  var bannerText = document.getElementById("banner-text");
  var engineOutput = document.getElementById("engine-output");
  var bannerActions = document.getElementById("banner-actions");
  var transcript = document.getElementById("transcript");
  var todosList = document.getElementById("todos");
  var planBox = document.getElementById("plan");
  var prompt = document.getElementById("prompt");
  var sendButton = document.getElementById("send");
  var abortButton = document.getElementById("abort");
  var hint = document.getElementById("hint");
  var cost = document.getElementById("cost");

  function post(message) {
    vscode.postMessage(message);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function labelled(parent, label, value) {
    if (!value) return;
    parent.appendChild(el("span", "body-label", label));
    parent.appendChild(el("div", "body", value));
  }

  function disclosure(block, title, statusText, statusClass) {
    var button = el("button", "disclosure");
    button.type = "button";
    button.setAttribute("aria-expanded", block.collapsed ? "false" : "true");
    button.appendChild(el("span", "chevron", block.collapsed ? "\\u25B8" : "\\u25BE"));
    button.appendChild(el("span", "tool-name", title));
    if (statusText) {
      button.appendChild(el("span", "tool-status " + statusClass, statusText));
    }
    button.addEventListener("click", function () {
      post({ type: "toggle", blockId: block.id });
    });
    return button;
  }

  function renderBlock(block) {
    if (block.kind === "user") return el("div", "block user", block.text);
    if (block.kind === "text") return el("div", "block text", block.text);
    if (block.kind === "notice") {
      return el("div", "block notice notice-" + block.level, block.text);
    }
    if (block.kind === "thinking") {
      var wrap = el("div", "block thinking");
      wrap.appendChild(disclosure(block, "Thinking", "", ""));
      if (!block.collapsed) wrap.appendChild(el("div", "body", block.text));
      return wrap;
    }
    if (block.kind === "tool") {
      var row = el("div", "block tool");
      row.appendChild(
        disclosure(block, block.name, block.status, "status-" + block.status)
      );
      if (!block.collapsed) {
        var body = el("div", "");
        labelled(body, "Arguments", block.argsText);
        labelled(body, "Output", block.progress);
        labelled(body, "Result", block.result);
        row.appendChild(body);
      }
      return row;
    }
    return el("div", "block", "");
  }

  function renderTranscript(blocks) {
    var atBottom =
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < blocks.length; i += 1) {
      fragment.appendChild(renderBlock(blocks[i]));
    }
    transcript.textContent = "";
    transcript.appendChild(fragment);
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
  }

  function renderTodos(todos) {
    todosList.textContent = "";
    if (!todos || todos.length === 0) {
      todosList.classList.add("hidden");
      return;
    }
    todosList.classList.remove("hidden");
    for (var i = 0; i < todos.length; i += 1) {
      var todo = todos[i];
      var mark = todo.status === "done" ? "\\u2713" : todo.status === "inProgress" ? "\\u25B8" : "\\u25CB";
      todosList.appendChild(el("li", "todo-" + todo.status, mark + " " + todo.text));
    }
  }

  function renderState(state) {
    renderTranscript(state.blocks || []);
    renderTodos(state.todos);
    if (state.plan) {
      planBox.textContent = state.plan;
      planBox.classList.remove("hidden");
    } else {
      planBox.classList.add("hidden");
    }
    abortButton.disabled = !state.running;
    sendButton.textContent = state.running ? "Steer" : "Send";
    var parts = [];
    if (state.model) parts.push(state.model);
    if (state.pendingPermissions > 0) parts.push("waiting for permission");
    if (state.running) parts.push("running");
    hint.textContent = parts.join(" \\u00B7 ");
  }

  /**
   * The engine's own stderr, as text.
   *
   * textContent, never markup: this is whatever the child process wrote, and
   * an engine (or a tool it ran) that printed a tag must render as characters.
   */
  function renderEngineOutput(text) {
    if (!text) {
      engineOutput.textContent = "";
      engineOutput.classList.add("hidden");
      return;
    }
    engineOutput.textContent = text;
    engineOutput.classList.remove("hidden");
  }

  /** Rebuild the card's buttons from the host's list. Ids are host-supplied. */
  function renderActions(actions) {
    bannerActions.textContent = "";
    if (!actions || actions.length === 0) {
      bannerActions.classList.add("hidden");
      return;
    }
    bannerActions.classList.remove("hidden");
    for (var i = 0; i < actions.length; i += 1) {
      var action = actions[i];
      if (!action || typeof action.id !== "string" || typeof action.label !== "string") continue;
      var button = el("button", i === actions.length - 1 ? "" : "secondary", action.label);
      button.type = "button";
      bannerActions.appendChild(button);
      (function (id) {
        button.addEventListener("click", function () {
          post({ type: "action", id: id });
        });
      })(action.id);
    }
  }

  function renderConnection(status, detail, output, actions) {
    if (status === "ready") {
      banner.classList.add("hidden");
      renderEngineOutput("");
      renderActions([]);
      prompt.disabled = false;
      sendButton.disabled = false;
      return;
    }
    banner.classList.remove("hidden");
    prompt.disabled = status !== "ready";
    sendButton.disabled = status !== "ready";
    if (status === "starting") {
      bannerText.textContent = "Starting the Arcturn engine\\u2026";
      renderEngineOutput("");
      renderActions([]);
      return;
    }
    if (status === "idle") {
      bannerText.textContent = "Arcturn is not connected.";
      renderEngineOutput("");
      renderActions([{ id: "reconnect", label: "Connect" }]);
      return;
    }
    bannerText.textContent = detail || "The Arcturn engine stopped.";
    renderEngineOutput(output);
    renderActions(
      actions && actions.length > 0 ? actions : [{ id: "reconnect", label: "Retry" }]
    );
  }

  function send() {
    var text = prompt.value;
    if (!text || text.trim() === "") return;
    post({ type: "send", text: text });
    prompt.value = "";
    prompt.focus();
  }

  sendButton.addEventListener("click", send);
  abortButton.addEventListener("click", function () {
    post({ type: "abort" });
  });
  document.getElementById("sessions").addEventListener("click", function () {
    post({ type: "command", command: "sessions" });
  });
  document.getElementById("model").addEventListener("click", function () {
    post({ type: "command", command: "model" });
  });
  prompt.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || typeof message !== "object") return;
    if (!Object.prototype.hasOwnProperty.call(KNOWN_HOST_MESSAGES, message.type)) return;
    if (message.type === "state") {
      if (message.state && typeof message.state === "object") renderState(message.state);
      return;
    }
    if (message.type === "connection") {
      if (typeof message.status !== "string") return;
      renderConnection(
        message.status,
        typeof message.detail === "string" ? message.detail : "",
        typeof message.engineOutput === "string" ? message.engineOutput : "",
        Array.isArray(message.actions) ? message.actions : []
      );
      return;
    }
    if (message.type === "cost") {
      if (typeof message.label === "string") cost.textContent = message.label;
    }
  });

  post({ type: "ready" });
})();
`;
