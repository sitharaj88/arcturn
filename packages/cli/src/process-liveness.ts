/**
 * Is a recorded pid still a live process?
 *
 * `~/.arcturn` is shared. `arcturn serve` and a terminal session run over the
 * same records directory at once, and both `TeamManager` and
 * `BackgroundAgentManager` correct a record still `running` at load time to
 * `interrupted` — right when it means "the process that owned this died",
 * catastrophically wrong when it means "another live process owns this". A
 * record therefore names its owner, and a loader that finds that owner alive
 * leaves it alone.
 *
 * Its own module because both managers need it and neither should have to
 * import the other: `team.ts` was modelled on `background-agents.ts`, and an
 * edge back the other way would invert that.
 */

/**
 * Does `pid` name a process that exists right now?
 *
 * Signal `0` runs every permission and existence check and delivers nothing,
 * so it answers the question without touching the process. `EPERM` means it
 * exists and belongs to somebody else — still alive, and still not ours to
 * recover from.
 *
 * The unavoidable caveat is pid reuse: a dead owner whose number the OS handed
 * to something else reads as alive, and its records are left un-recovered
 * until that number frees up again. That failure mode leaks a worktree; the
 * one it replaces deleted a live team's worktree out from under it.
 *
 * @param pid - Process id to probe. Non-integers and non-positive numbers
 *   (including the `0` and negative values `process.kill` reads as "my process
 *   group") are never live owners, and are refused rather than probed.
 * @returns `true` when a process with that id exists.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
