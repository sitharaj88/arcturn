/**
 * CLI provisioning: find the engine, check it is new enough, and — when it is
 * not there at all — offer to install it in a terminal the user is watching.
 *
 * This is the adapter half; every rule it applies lives in `cli-resolve.ts`
 * where it can be tested without an editor. What is here is the part that
 * genuinely needs VS Code and the operating system: reading settings,
 * stat-ing a file, spawning `arcturn --version`, and raising exactly one
 * notification.
 *
 * The install is never silent (RFC 0004 §1). `npm install -g` runs arbitrary
 * package scripts as the user; an extension that did that behind a spinner
 * would be asking for trust it has not earned. It is typed into a visible
 * terminal instead, where it can be read, cancelled, and re-run by hand.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import * as vscode from "vscode";
import {
  type CliLocation,
  decideCli,
  describeMissingCli,
  describeUpgrade,
  installCommand,
  isOutdated,
  MIN_ENGINE_VERSION,
  normalizeCliPathSetting,
  parseVersionOutput,
} from "./cli-resolve.js";
import { resolveUserEnvironment, type UserEnvironment } from "./user-env.js";

/**
 * The engine binary this extension will drive.
 *
 * This is the seam type: Builder B's `activateSidebar` receives a
 * `() => Promise<ResolvedCli | undefined>` and spawns `arcturn serve` from
 * `command`. `version` is whatever `--version` said, or absent when it could
 * not be read — never a guess.
 */
export interface ResolvedCli extends CliLocation {
  readonly version?: string;
}

/** The seam signature handed across to the sidebar. */
export type ResolveCli = () => Promise<ResolvedCli | undefined>;

/** Injection points for tests; production leaves all of them alone. */
export interface CliProvisionerOptions {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  /**
   * `PATH` to search. Overrides {@link CliProvisionerOptions.environment}, and
   * is the reason no unit test here has to run a shell.
   */
  readonly pathVar?: string;
  readonly isExecutable?: (candidate: string) => boolean;
  /** Where the daily update-check timestamp lives. `context.globalState` in production. */
  readonly state?: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> };
  /** Clock, for tests. */
  readonly now?: () => number;
  /** Registry probe, for tests. Production asks registry.npmjs.org once a day. */
  readonly fetchLatestVersion?: () => Promise<string | undefined>;
  readonly probeVersion?: (
    command: string,
    env?: Record<string, string | undefined>,
  ) => Promise<string | undefined>;
  /**
   * The user's real environment.
   *
   * Defaults to `user-env.ts`'s once-per-window login-shell probe. It is a
   * function, not a value, because resolving it spawns a process and RFC 0004
   * §3 gives activation no budget for that — see the call sites in
   * {@link resolveOnce}, both of which are inside a `resolveCli()` a user
   * action asked for.
   */
  readonly environment?: () => Promise<UserEnvironment>;
}

/** The provisioner owned by `activate()` for the lifetime of the window. */
export interface CliProvisioner extends vscode.Disposable {
  /** Resolve the engine, notifying at most once per window if it is missing. */
  readonly resolveCli: ResolveCli;
  /** Type an install (or upgrade) into a visible terminal. */
  runInstall(kind: "install" | "upgrade"): void;
  /** Await any notification follow-up still in flight. Tests only. */
  settled(): Promise<void>;
}

const VERSION_TIMEOUT_MS = 5000;

/**
 * Ask the binary what it is. Silence (or a crash) answers `undefined`.
 *
 * The environment matters here as much as it does for `serve`: a global npm
 * install writes a shell shim that runs `node`, and on a GUI-launched macOS
 * editor `node` is not on the inherited `PATH`. Without the resolved
 * environment this probe answers `undefined` for a perfectly good install and
 * the user gets no version at all.
 */
function probeVersionByExec(
  command: string,
  env?: Record<string, string | undefined>,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["--version"],
      {
        timeout: VERSION_TIMEOUT_MS,
        windowsHide: true,
        ...(env === undefined ? {} : { env }),
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(parseVersionOutput(`${stdout}${stderr}`));
      },
    );
  });
}

/** A file we could actually run. A directory named `arcturn` is not one. */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    // Windows has no execute bit worth consulting; existence of the shim is
    // the real signal there, and `cliExecutableNames` already narrowed it to
    // shapes the shell can run.
    if (process.platform === "win32") return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A day: often enough to stay current, rare enough to never be noticed. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The engine's latest published version, from the npm registry.
 *
 * The one network request this extension makes. The abbreviated-metadata
 * endpoint answers in one small JSON object, and anything unexpected —
 * offline, a proxy, a registry hiccup — resolves `undefined` rather than
 * throwing, because "could not check" must never surface as an error to
 * somebody who merely opened their editor.
 */
async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch("https://registry.npmjs.org/arcturn/latest", {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

export function createCliProvisioner(options: CliProvisionerOptions = {}): CliProvisioner {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const probeVersion = options.probeVersion ?? probeVersionByExec;
  /**
   * Resolving the environment means running the user's login shell. Supplying
   * `pathVar` is how a test says "I have already decided what to search", and
   * it therefore also opts out of the probe — which is what keeps every unit
   * test in `cli.test.ts` hermetic on a machine with any shell profile at all.
   */
  const environment =
    options.environment ??
    (options.pathVar === undefined
      ? resolveUserEnvironment
      : async (): Promise<UserEnvironment> => ({
          env: { ...process.env, PATH: options.pathVar },
          source: "process",
          diagnostic: "",
          secrets: [],
          retryable: false,
        }));
  /** At most one probe per provisioner, however many commands ask. */
  let pendingEnv: Promise<UserEnvironment> | undefined;
  const currentEnv = (): Promise<UserEnvironment> => (pendingEnv ??= environment());

  let pending: Promise<ResolvedCli | undefined> | undefined;
  let notifiedMissing = false;
  let notifiedUpgrade = false;
  // Notification follow-ups are fire-and-forget in production; tests await this.
  let followUp: Promise<void> = Promise.resolve();

  function track(work: Promise<void>): void {
    followUp = followUp.then(() => work);
  }

  /** Type the command into a visible terminal. Never resets any guard. */
  function launchInstall(kind: "install" | "upgrade"): void {
    const command = installCommand(kind);
    const terminal = vscode.window.createTerminal({
      name: "Arcturn install",
      iconPath: new vscode.ThemeIcon("cloud-download"),
    });
    terminal.show();
    terminal.sendText(command, true);
    // The next command must look again rather than reuse the miss we cached
    // before the install ran. Only the resolve cache — the notified guards
    // stay set, because clearing them here is how the automatic path once
    // looped: install resets guard, next resolve reinstalls, forever.
    pending = undefined;
  }

  function runInstall(kind: "install" | "upgrade"): void {
    launchInstall(kind);
    // A user-invoked install is also consent to be told again if it did not
    // take; the automatic path deliberately keeps its one-shot guards.
    notifiedMissing = false;
    notifiedUpgrade = false;
  }

  /** Whether the user has left automatic install and update on (the default). */
  function autoManaged(): boolean {
    return vscode.workspace.getConfiguration("arcturn").get<boolean>("cli.autoUpdate") ?? true;
  }

  async function offerInstall(
    message: string,
    choicesOptions: { allowAuto?: boolean } = {},
  ): Promise<void> {
    // Automatic by default — a fresh install landing on a panel that needs a
    // CLI it does not have should just get one, in a terminal the user can
    // watch and Ctrl+C, not behind a button they have to find. The
    // notification is the consent surface: it says what is running and where,
    // and the setting turns the whole behaviour off.
    if (autoManaged() && choicesOptions.allowAuto !== false) {
      launchInstall("install");
      const choice = await vscode.window.showInformationMessage(
        "Arcturn is installing its CLI engine in the terminal (npm install -g arcturn). " +
          "Turn this off with arcturn.cli.autoUpdate.",
        "Set path instead…",
      );
      if (choice === "Set path instead…") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "arcturn.cliPath");
      }
      return;
    }
    const choice = await vscode.window.showWarningMessage(message, "Install", "Set path…");
    if (choice === "Install") runInstall("install");
    else if (choice === "Set path…") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "arcturn.cliPath");
    }
  }

  async function offerUpgrade(current: string, upgradeOptions?: { allowAuto?: boolean }): Promise<void> {
    // The same rule as offerInstall: `npm install -g` can freshen what PATH
    // found, but it cannot touch the file an explicit `arcturn.cliPath`
    // points at, so a pinned engine is asked about and never auto-launched.
    if (autoManaged() && upgradeOptions?.allowAuto !== false) {
      launchInstall("upgrade");
      void vscode.window.showInformationMessage(
        `Arcturn is updating its engine (${current} → ${MIN_ENGINE_VERSION}+) in the terminal. ` +
          "Reconnect when it finishes to pick it up.",
      );
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      describeUpgrade(current, MIN_ENGINE_VERSION),
      "Upgrade",
      "Not now",
    );
    if (choice === "Upgrade") runInstall("upgrade");
  }

  /**
   * Once a day, ask npm whether a newer engine exists, and update if so.
   *
   * The one network request this extension makes, and it is metadata about a
   * public package — no user data rides it. Throttled through the memento so
   * a window reload is not a registry hit, gated on the same setting as the
   * rest of auto-management, and every failure is silence: an engine that
   * cannot check for updates is merely current-until-tomorrow.
   */
  async function maybeAutoUpdate(installed: string | undefined): Promise<void> {
    if (!autoManaged() || installed === undefined) return;
    const state = options.state;
    const now = options.now?.() ?? Date.now();
    const last = state?.get<number>("arcturn.lastUpdateCheck") ?? 0;
    if (now - last < UPDATE_CHECK_INTERVAL_MS) return;
    await state?.update("arcturn.lastUpdateCheck", now);
    let latest: string | undefined;
    try {
      latest = await (options.fetchLatestVersion ?? fetchLatestVersion)();
    } catch {
      return;
    }
    if (latest === undefined || !isOutdated(installed, latest)) return;
    launchInstall("upgrade");
    void vscode.window.showInformationMessage(
      `Arcturn is updating its engine (${installed} → ${latest}) in the terminal. ` +
        "Reconnect when it finishes to pick it up.",
    );
  }

  async function resolveOnce(): Promise<ResolvedCli | undefined> {
    const configured = normalizeCliPathSetting(
      vscode.workspace.getConfiguration("arcturn").get<string>("cliPath"),
      home,
      platform,
    );
    // The first thing in this function that costs a process — and it is only
    // reached from `resolveCli()`, which only a command or the sidebar calls.
    const userEnv = await currentEnv();
    const pathVar = options.pathVar ?? userEnv.env.PATH;
    const decision = decideCli({ configured, pathVar, platform, isExecutable });
    if (decision.kind === "missing") {
      if (!notifiedMissing) {
        notifiedMissing = true;
        // On Windows there is no login shell to have failed at, so the note
        // would be a claim about a probe that was never meant to run.
        const fellBack = platform !== "win32" && userEnv.source === "process";
        // A broken explicit `arcturn.cliPath` is a typo in a setting, and an
        // automatic `npm install -g` cannot repair a setting — only the
        // message naming it can. Auto-install is for the plain "nothing on
        // PATH" case.
        track(
          offerInstall(describeMissingCli(decision, fellBack), {
            allowAuto: configured === undefined,
          }),
        );
      }
      return undefined;
    }

    const version = await probeVersion(decision.cli.command, userEnv.env);
    if (isOutdated(version, MIN_ENGINE_VERSION) && !notifiedUpgrade) {
      notifiedUpgrade = true;
      // Offered, not enforced: an old engine still runs, and blocking the
      // user over a version number they did not choose is not our call.
      track(
        offerUpgrade(version as string, { allowAuto: decision.cli.source === "path" }),
      );
    } else if (version !== undefined && decision.cli.source === "path") {
      // Above the floor: still check, once a day, whether npm has moved on.
      // Only for a PATH-resolved binary — `npm install -g` can freshen what
      // PATH found, but it can never touch the file an explicit
      // `arcturn.cliPath` points at, so for a pinned path the check would
      // open a terminal that fixes nothing.
      track(maybeAutoUpdate(version));
    }
    return version === undefined ? { ...decision.cli } : { ...decision.cli, version };
  }

  const configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("arcturn.cliPath")) return;
    // The user just answered the question the notification asked. Cache the
    // old miss and they would have to reload the window to see their fix.
    pending = undefined;
    notifiedMissing = false;
    notifiedUpgrade = false;
  });

  return {
    resolveCli() {
      pending ??= resolveOnce();
      return pending;
    },
    runInstall,
    settled() {
      return followUp;
    },
    dispose() {
      configSubscription.dispose();
    },
  };
}
