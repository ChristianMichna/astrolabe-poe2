import { describe, expect, it, vi } from "vitest";
import { stopWithin } from "../src/main/shutdown.js";

describe("stopWithin", () => {
  it("reports a stop that finishes", async () => {
    expect(
      await stopWithin(
        () => Promise.resolve(),
        1000,
        () => undefined,
      ),
    ).toBe("stopped");
  });

  it("gives up on a stop that never ends", async () => {
    vi.useFakeTimers();
    try {
      const outcome = stopWithin(
        () => new Promise<void>(() => undefined),
        5000,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(await outcome).toBe("timed-out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the error of a stop that fails", async () => {
    const seen: unknown[] = [];
    const error = new Error("close failed");
    const outcome = await stopWithin(
      () => Promise.reject(error),
      1000,
      (e) => seen.push(e),
    );
    expect(outcome).toBe("failed");
    expect(seen).toEqual([error]);
  });
});
