/**
 * Stops something (the local server and its calc pool) but gives up after a time limit. A stop
 * that never ends would keep the process, and with it the single-instance lock, alive without a
 * window: every later start of the app would only reach that leftover process.
 */
export type StopOutcome = "stopped" | "timed-out" | "failed";

export async function stopWithin(
  stop: () => Promise<void>,
  limitMs: number,
  onError: (error: unknown) => void,
): Promise<StopOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), limitMs);
  });
  try {
    return await Promise.race([stop().then(() => "stopped" as const), limit]);
  } catch (error) {
    onError(error);
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
