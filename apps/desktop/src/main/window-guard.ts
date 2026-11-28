/**
 * Window calls that must not throw when the window is already gone. Electron raises
 * "TypeError: Object has been destroyed" for any call on a closed window. A second start of the
 * app (double click, the installer's relaunch after an update) can arrive while the first
 * instance is still shutting down its server with the window already closed; an uncaught
 * exception in that handler shows the person a crash dialog.
 */
export interface GuardedWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  show(): void;
}

/** Brings the window to the front. Returns false when there is no live window to bring. */
export function focusWindow(win: GuardedWindow | undefined): boolean {
  if (win === undefined || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.focus();
  return true;
}

/** Shows the window once it is ready; does nothing when it was closed in between. */
export function showWindow(win: GuardedWindow): boolean {
  if (win.isDestroyed()) return false;
  win.show();
  return true;
}
