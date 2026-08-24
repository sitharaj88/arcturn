/**
 * A hand-written stand-in for the `vscode` module.
 *
 * The real one only exists inside a running editor: it is injected by the
 * extension host and has no npm package behind it, so under vitest an
 * `import "vscode"` cannot resolve at all. Everything in this repository that
 * touches the editor API therefore lives in a thin adapter, and those
 * adapters are tested against this fake — which records what was asked of it
 * so a test can assert on the *sequence*, not just the outcome.
 *
 * Only the surface the extension actually uses is modelled. Adding to it is
 * expected; faking something the code never calls is not.
 */

/** A terminal that remembers everything typed into it. */
export interface FakeTerminal {
  readonly name: string;
  readonly options: Record<string, unknown>;
  /** How many times `show()` was called — focus is a behavior worth asserting. */
  shows: number;
  readonly sent: { text: string; addNewLine: boolean }[];
  disposed: boolean;
  /**
   * Mirrors `vscode.Terminal.exitStatus`: set only when the *shell* exits.
   * It says nothing about whether the TUI inside is still running, which is
   * exactly the gap the terminal hub has to reason about.
   */
  exitStatus: { code: number | undefined } | undefined;
  show(): void;
  sendText(text: string, addNewLine?: boolean): void;
  dispose(): void;
}

/** One notification the extension raised. */
export interface FakeMessage {
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly items: string[];
}

export interface FakeUri {
  readonly fsPath: string;
  readonly scheme: string;
  toString(): string;
}

interface FakeFolder {
  readonly uri: FakeUri;
  readonly name: string;
  readonly index: number;
}

/** Everything the fake recorded, readable and resettable from a test. */
export interface FakeState {
  terminals: FakeTerminal[];
  commands: Map<string, (...args: never[]) => unknown>;
  codeActionProviders: { selector: unknown; provider: FakeCodeActionProvider; metadata: unknown }[];
  config: Record<string, unknown>;
  workspaceFolders: FakeFolder[] | undefined;
  activeTextEditor: unknown;
  diagnostics: unknown[];
  messages: FakeMessage[];
  /** The button label `showXMessage` resolves with, if any. */
  messageAnswer: string | undefined;
  closeHandlers: ((terminal: FakeTerminal) => void)[];
  configChangeHandlers: ((event: unknown) => void)[];
  /** Listeners for `window.onDidEndTerminalShellExecution`. */
  shellExecutionEndHandlers: ((event: { terminal: FakeTerminal }) => void)[];
  /**
   * Which of the three real host shapes to present.
   *
   * The third one is the one that cost us a shipping bug. `typeof x ===
   * "function"` is not a capability check on VS Code: an API that is still a
   * *proposal* is present on `window`, is a function, and throws the moment
   * it is called unless the manifest opted into the proposal. Modelling only
   * "callable" and "missing" is what let a feature detection that could not
   * possibly work pass its unit tests.
   */
  shellIntegration: "available" | "absent" | "proposal-gated";
  disposed: number;
}

interface FakeCodeActionProvider {
  provideCodeActions(
    document: unknown,
    range: unknown,
    context: unknown,
    token: unknown,
  ): unknown[] | undefined;
}

export const fake: FakeState = {
  terminals: [],
  commands: new Map(),
  codeActionProviders: [],
  config: {},
  workspaceFolders: undefined,
  activeTextEditor: undefined,
  diagnostics: [],
  messages: [],
  messageAnswer: undefined,
  closeHandlers: [],
  configChangeHandlers: [],
  shellExecutionEndHandlers: [],
  shellIntegration: "available",
  disposed: 0,
};

/** Drop every recording. Call this in `beforeEach`, or tests leak into each other. */
export function resetFake(): void {
  fake.terminals = [];
  fake.commands = new Map();
  fake.codeActionProviders = [];
  fake.config = {};
  fake.workspaceFolders = undefined;
  fake.activeTextEditor = undefined;
  fake.diagnostics = [];
  fake.messages = [];
  fake.messageAnswer = undefined;
  fake.closeHandlers = [];
  fake.configChangeHandlers = [];
  fake.shellExecutionEndHandlers = [];
  fake.shellIntegration = "available";
  fake.disposed = 0;
}

/** Simulate the TUI inside `terminal` exiting back to a shell prompt. */
export function endShellExecution(terminal: FakeTerminal): void {
  for (const handler of [...fake.shellExecutionEndHandlers]) handler({ terminal });
}

/** Build a workspace folder whose `uri` behaves enough like the real one. */
export function fakeFolder(fsPath: string, name: string, index = 0): FakeFolder {
  return { uri: fakeUri(fsPath), name, index };
}

/** A uri with just enough behavior for path work and map keys. */
export function fakeUri(fsPath: string): FakeUri {
  return { fsPath, scheme: "file", toString: () => `file://${fsPath}` };
}

class FakeDisposable {
  constructor(private readonly onDispose: () => void) {}
  dispose(): void {
    fake.disposed++;
    this.onDispose();
  }
}

/**
 * The module object handed to `vi.mock("vscode", …)`.
 *
 * Returned fresh on every call so a test file that resets modules gets a
 * clean set of classes, while {@link fake} stays the single shared ledger.
 */
export function createFakeVscode(): Record<string, unknown> {
  class ThemeIcon {
    constructor(public readonly id: string) {}
  }
  class Position {
    constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
  }
  class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(
      startLine: number | Position,
      startChar?: number,
      endLine?: number,
      endChar?: number,
    ) {
      if (startLine instanceof Position) {
        this.start = startLine;
        this.end = (startChar as unknown as Position) ?? startLine;
      } else {
        this.start = new Position(startLine, startChar ?? 0);
        this.end = new Position(endLine ?? startLine, endChar ?? 0);
      }
    }
  }
  class CodeActionKind {
    static readonly QuickFix = new CodeActionKind("quickfix");
    constructor(public readonly value: string) {}
  }
  class CodeAction {
    command?: unknown;
    diagnostics?: unknown[];
    isPreferred?: boolean;
    constructor(
      public readonly title: string,
      public readonly kind?: CodeActionKind,
    ) {}
  }

  return {
    ThemeIcon,
    Position,
    Range,
    Selection: Range,
    CodeAction,
    CodeActionKind,
    Disposable: FakeDisposable,
    Uri: { file: fakeUri, parse: fakeUri },
    window: {
      get activeTextEditor() {
        return fake.activeTextEditor;
      },
      createTerminal(options: Record<string, unknown>): FakeTerminal {
        const terminal: FakeTerminal = {
          name: String(options.name ?? ""),
          options,
          shows: 0,
          sent: [],
          disposed: false,
          exitStatus: undefined,
          show() {
            terminal.shows++;
          },
          sendText(text: string, addNewLine = true) {
            terminal.sent.push({ text, addNewLine });
          },
          dispose() {
            terminal.disposed = true;
            for (const handler of fake.closeHandlers) handler(terminal);
          },
        };
        fake.terminals.push(terminal);
        return terminal;
      },
      // Exposed as a getter so a test can change the host shape between cases
      // without rebuilding the whole module mock.
      get onDidEndTerminalShellExecution() {
        if (fake.shellIntegration === "absent") return undefined;
        if (fake.shellIntegration === "proposal-gated") {
          // Word for word what VS Code 1.90-1.92 throws: the property is
          // there, it is a function, and calling it is fatal.
          return () => {
            throw new Error(
              "Extension 'sitharaj88.arcturn-vscode' CANNOT use API proposal: terminalShellIntegration.",
            );
          };
        }
        return (handler: (event: { terminal: FakeTerminal }) => void) => {
          fake.shellExecutionEndHandlers.push(handler);
          return new FakeDisposable(() => {
            fake.shellExecutionEndHandlers = fake.shellExecutionEndHandlers.filter(
              (h) => h !== handler,
            );
          });
        };
      },
      onDidCloseTerminal(handler: (terminal: FakeTerminal) => void) {
        fake.closeHandlers.push(handler);
        return new FakeDisposable(() => {
          fake.closeHandlers = fake.closeHandlers.filter((h) => h !== handler);
        });
      },
      showInformationMessage(message: string, ...items: string[]) {
        fake.messages.push({ level: "info", message, items });
        return Promise.resolve(fake.messageAnswer);
      },
      showWarningMessage(message: string, ...items: string[]) {
        fake.messages.push({ level: "warning", message, items });
        return Promise.resolve(fake.messageAnswer);
      },
      showErrorMessage(message: string, ...items: string[]) {
        fake.messages.push({ level: "error", message, items });
        return Promise.resolve(fake.messageAnswer);
      },
    },
    workspace: {
      get workspaceFolders() {
        return fake.workspaceFolders;
      },
      getWorkspaceFolder(uri: FakeUri) {
        return fake.workspaceFolders?.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath));
      },
      getConfiguration(section: string) {
        return {
          get<T>(key: string, fallback?: T): T | undefined {
            const value = fake.config[`${section}.${key}`];
            return (value as T | undefined) ?? fallback;
          },
        };
      },
      onDidChangeConfiguration(handler: (event: unknown) => void) {
        fake.configChangeHandlers.push(handler);
        return new FakeDisposable(() => {
          fake.configChangeHandlers = fake.configChangeHandlers.filter((h) => h !== handler);
        });
      },
    },
    commands: {
      registerCommand(id: string, handler: (...args: never[]) => unknown) {
        fake.commands.set(id, handler);
        return new FakeDisposable(() => fake.commands.delete(id));
      },
      executeCommand(id: string, ...args: never[]) {
        return Promise.resolve(fake.commands.get(id)?.(...args));
      },
    },
    languages: {
      registerCodeActionsProvider(
        selector: unknown,
        provider: FakeCodeActionProvider,
        metadata: unknown,
      ) {
        fake.codeActionProviders.push({ selector, provider, metadata });
        return new FakeDisposable(() => {
          fake.codeActionProviders = fake.codeActionProviders.filter(
            (p) => p.provider !== provider,
          );
        });
      },
    },
  };
}
