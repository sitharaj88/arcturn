/**
 * The theme-change contract: `themeVersion()` and `onThemeChange()`.
 *
 * Downstream caches (styled transcript lines, rendered markdown tables, widget
 * buffers) bake ANSI in at build time, so they need both a cheap "did anything
 * change?" probe and a push notification. These tests pin the guarantees those
 * consumers rely on: the version is monotonic, listeners see the *new* theme,
 * unsubscribing is honoured, and one throwing subscriber cannot take out its
 * peers or the `setTheme` caller.
 *
 * @packageDocumentation
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTheme,
  darkTheme,
  getTheme,
  lightTheme,
  onThemeChange,
  setTheme,
  type Theme,
  themeVersion,
} from "./theme.js";

/** Active theme is module-global; restore it so tests stay order-independent. */
afterEach(() => {
  setTheme(darkTheme);
});

describe("themeVersion", () => {
  it("bumps by exactly one per setTheme call, including redundant ones", () => {
    const start = themeVersion();
    setTheme(lightTheme);
    expect(themeVersion()).toBe(start + 1);
    setTheme(darkTheme);
    expect(themeVersion()).toBe(start + 2);
    // Re-installing the same theme still counts: callers cache on the number,
    // and identity comparison is not the contract.
    setTheme(darkTheme);
    expect(themeVersion()).toBe(start + 3);
  });

  it("does not move when no theme is installed", () => {
    const before = themeVersion();
    getTheme();
    expect(themeVersion()).toBe(before);
  });
});

describe("onThemeChange", () => {
  it("notifies listeners with the newly active theme", () => {
    const seen: string[] = [];
    const off = onThemeChange((theme) => {
      seen.push(theme.name);
    });
    setTheme(lightTheme);
    off();
    expect(seen).toEqual([lightTheme.name]);
  });

  it("fires after getTheme already reports the new theme", () => {
    let observed: Theme | undefined;
    const off = onThemeChange(() => {
      observed = getTheme();
    });
    setTheme(lightTheme);
    off();
    expect(observed).toBe(lightTheme);
  });

  it("passes the version that matches the change", () => {
    let versionInside = -1;
    const off = onThemeChange(() => {
      versionInside = themeVersion();
    });
    setTheme(lightTheme);
    const after = themeVersion();
    off();
    expect(versionInside).toBe(after);
  });

  it("runs listeners in registration order", () => {
    const order: number[] = [];
    const offs = [1, 2, 3].map((n) => onThemeChange(() => order.push(n)));
    setTheme(lightTheme);
    for (const off of offs) off();
    expect(order).toEqual([1, 2, 3]);
  });

  it("stops notifying after unsubscribe, and unsubscribing twice is safe", () => {
    const listener = vi.fn();
    const off = onThemeChange(listener);
    setTheme(lightTheme);
    off();
    off();
    setTheme(darkTheme);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing listener from its peers and from the caller", () => {
    const before = vi.fn();
    const after = vi.fn();
    const offs = [
      onThemeChange(before),
      onThemeChange(() => {
        throw new Error("subscriber exploded");
      }),
      onThemeChange(after),
    ];
    expect(() => setTheme(lightTheme)).not.toThrow();
    for (const off of offs) off();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(getTheme()).toBe(lightTheme);
  });

  it("dispatches to a snapshot, so (un)subscribing mid-dispatch waits its turn", () => {
    const late = vi.fn();
    let offLate: (() => void) | undefined;
    const offSelf = onThemeChange(() => {
      offLate ??= onThemeChange(late);
    });
    setTheme(lightTheme);
    expect(late).not.toHaveBeenCalled();
    setTheme(darkTheme);
    expect(late).toHaveBeenCalledTimes(1);
    offSelf();
    offLate?.();
  });

  it("reports derived themes too", () => {
    const derived = createTheme("arcturn-custom", {}, darkTheme);
    const listener = vi.fn();
    const off = onThemeChange(listener);
    setTheme(derived);
    off();
    expect(listener).toHaveBeenCalledWith(derived);
  });
});
