import { describe, expect, it } from "vitest";
import { focusWindow, showWindow, type GuardedWindow } from "../src/main/window-guard.js";

/** Behaves like an Electron window: every call after destroy throws. */
function fakeWindow(): GuardedWindow & { destroy(): void; calls: string[] } {
  let destroyed = false;
  const calls: string[] = [];
  const live =
    <T>(name: string, value: T) =>
    (): T => {
      if (destroyed) throw new TypeError("Object has been destroyed");
      calls.push(name);
      return value;
    };
  return {
    calls,
    destroy: () => {
      destroyed = true;
    },
    isDestroyed: () => destroyed,
    isMinimized: live("isMinimized", true),
    restore: live("restore", undefined),
    focus: live("focus", undefined),
    show: live("show", undefined),
  };
}

describe("window guard", () => {
  it("brings a live window to the front", () => {
    const win = fakeWindow();
    expect(focusWindow(win)).toBe(true);
    expect(win.calls).toEqual(["isMinimized", "restore", "focus"]);
  });

  it("does not throw for a window that is already destroyed (second start during shutdown)", () => {
    const win = fakeWindow();
    win.destroy();
    expect(focusWindow(win)).toBe(false);
    expect(showWindow(win)).toBe(false);
  });

  it("does nothing without a window", () => {
    expect(focusWindow(undefined)).toBe(false);
  });
});
