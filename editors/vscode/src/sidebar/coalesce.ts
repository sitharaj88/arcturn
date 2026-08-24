/**
 * Collapse a burst of updates into one delivery.
 *
 * The chat reducer produces a new state on every `textDelta` — dozens per
 * second during a stream. Posting each one across the webview boundary would
 * serialise the whole transcript dozens of times a second for a view that can
 * only repaint at frame rate anyway. This keeps the newest value and delivers
 * it once per interval.
 *
 * Pure of `vscode` and of the DOM, so the timing is testable directly.
 */

/** A latest-wins delivery buffer. */
export interface Coalescer<T> {
  /** Replace the pending value; delivery happens on the next tick. */
  push(value: T): void;
  /** Deliver the pending value now, if there is one. */
  flush(): void;
  /** Drop anything pending and ignore everything after. Idempotent. */
  dispose(): void;
}

/**
 * Create a {@link Coalescer}.
 *
 * @param deliver - Called with the most recent value.
 * @param intervalMs - Minimum gap between deliveries. Default 16ms — one frame.
 */
export function createCoalescer<T>(deliver: (value: T) => void, intervalMs = 16): Coalescer<T> {
  let pending: { value: T } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const fire = (): void => {
    timer = undefined;
    if (disposed) return;
    const next = pending;
    pending = undefined;
    if (next !== undefined) deliver(next.value);
  };

  return {
    push(value: T): void {
      if (disposed) return;
      pending = { value };
      if (timer !== undefined) return;
      timer = setTimeout(fire, intervalMs);
      (timer as { unref?: () => void }).unref?.();
    },
    flush(): void {
      if (disposed) return;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      fire();
    },
    dispose(): void {
      disposed = true;
      pending = undefined;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
