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

  function runInstall(kind: "install" | "upgrade"): void {
    const command = installCommand(kind);
    const terminal = vscode.window.createTerminal({
      name: "Arcturn install",
      iconPath: new vscode.ThemeIcon("cloud-download"),
    });
    terminal.show();
    terminal.sendText(command, true);
    // The next command must look again rather than reuse the miss we cached
    // before the install ran.
    pending = undefined;
    notifiedMissing = false;
    notifiedUpgrade = false;
  }

  async function offerInstall(message: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(message, "Install", "Set path…");
    if (choice === "Install") runInstall("install");
    else if (choice === "Set path…") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "arcturn.cliPath");
    }
  }

  async function offerUpgrade(current: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      describeUpgrade(current, MIN_ENGINE_VERSION),
      "Upgrade",
      "Not now",
    );
    if (choice === "Upgrade") runInstall("upgrade");
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
        track(offerInstall(describeMissingCli(decision, fellBack)));
      }
      return undefined;
    }

    const version = await probeVersion(decision.cli.command, userEnv.env);
    if (isOutdated(version, MIN_ENGINE_VERSION) && !notifiedUpgrade) {
      notifiedUpgrade = true;
      // Offered, not enforced: an old engine still runs, and blocking the
      // user over a version number they did not choose is not our call.
      track(offerUpgrade(version as string));
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
