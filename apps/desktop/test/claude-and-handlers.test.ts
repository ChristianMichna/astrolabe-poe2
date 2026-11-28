import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeCodeCommand,
  buildStartSentence,
  openClaudeDesktop,
} from "../src/main/claude.js";
import type { DesktopConfig } from "../src/main/config.js";
import { createHandlers, type HandlerDeps } from "../src/main/ipc-handlers.js";

const config: DesktopConfig = {
  version: "t",
  port: 47615,
  window: { width: 1, height: 1, minWidth: 1, minHeight: 1 },
  claude: {
    desktopUrl: "claude://",
    allowedSchemes: ["claude:"],
    startSentence: "Start session {code} now.",
  },
  economy: { enabled: true },
  citations: { allowedHosts: ["example.test"] },
  update: { enabled: true, firstCheckDelaySeconds: 1, checkIntervalHours: 1 },
  dataSync: {
    enabled: true,
    repo: "o/r",
    includePrereleases: true,
    firstCheckDelaySeconds: 1,
    checkIntervalHours: 1,
    listTimeoutSeconds: 1,
    installTimeoutMinutes: 1,
    allowedRedirectHosts: ["github.com"],
    maxDownloadMegabytes: 1,
    maxUnpackedMegabytes: 1,
    maxChecksumBytes: 1,
    maxDecompressionRatio: 1,
    maxEntries: 1,
    leftoverMinAgeMinutes: 1,
  },
};

describe("claude helpers", () => {
  it("fills the session code into the sentence", () => {
    expect(buildStartSentence(config.claude.startSentence, "AB12-CD")).toBe(
      "Start session AB12-CD now.",
    );
  });

  it("builds the Claude Code command with URL and token", () => {
    expect(buildClaudeCodeCommand("http://127.0.0.1:47615", "tok")).toBe(
      'claude mcp add --transport http astrolabe http://127.0.0.1:47615/mcp --header "Authorization: Bearer tok"',
    );
  });

  it("reports a failed open instead of hiding it", async () => {
    const outcome = await openClaudeDesktop(
      async () => {
        throw new Error("no handler");
      },
      "claude://",
      ["claude:"],
    );
    expect(outcome.opened).toBe(false);
    expect(outcome.reason).toContain("no handler");
  });

  it("does not open a URL outside the allowed schemes", async () => {
    const open = vi.fn(async () => undefined);
    const outcome = await openClaudeDesktop(open, "https://example.com", ["claude:"]);
    expect(outcome.opened).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

function deps(
  overrides: Partial<HandlerDeps> = {},
): HandlerDeps & { clipboard: string[]; revealed: string[] } {
  const clipboard: string[] = [];
  const revealed: string[] = [];
  return {
    config,
    getStatus: () => ({
      appVersion: "1",
      server: { state: "starting" },
      update: { state: "idle" },
      data: { state: "idle" },
    }),
    server: () => ({ url: "http://127.0.0.1:47615", token: "s3cr3t-value" }),
    fetch: async () =>
      new Response(JSON.stringify({ sessionCode: "AB12-CD", expiresAt: "2026-01-01T00:00:00Z" })),
    clipboardWrite: (t) => clipboard.push(t),
    clipboardRead: () => clipboard.at(-1) ?? "",
    openExternal: async () => undefined,
    revealPath: (path) => revealed.push(path),
    copyFile: async () => undefined,
    documentsDir: () => "docs",
    extensionPath: "x.mcpb",
    updates: () => undefined,
    ...overrides,
    clipboard,
    revealed,
  };
}

describe("ipc handlers", () => {
  it("issues a code, copies the sentence and opens Claude", async () => {
    const d = deps();
    const result = await createHandlers(d).openClaude("run-1");
    expect(result).toMatchObject({ sessionCode: "AB12-CD", claudeDesktopOpened: true });
    expect(d.clipboard).toEqual(["Start session AB12-CD now."]);
  });

  it("copies the sentence even when Claude Desktop does not open", async () => {
    const d = deps({
      openExternal: async () => {
        throw new Error("nope");
      },
    });
    const result = await createHandlers(d).openClaude("run-1");
    expect(result.claudeDesktopOpened).toBe(false);
    expect(result.notOpenedReason).toContain("nope");
    expect(d.clipboard).toHaveLength(1);
  });

  it("fails loudly when the server refuses the code", async () => {
    const d = deps({ fetch: async () => new Response("{}", { status: 404 }) });
    await expect(createHandlers(d).openClaude("run-1")).rejects.toThrow("HTTP 404");
  });

  it("rejects a bad run id and a missing server", async () => {
    await expect(createHandlers(deps()).openClaude(42)).rejects.toThrow();
    await expect(createHandlers(deps({ server: () => undefined })).openClaude("r")).rejects.toThrow(
      "not running",
    );
  });

  it("copies the Claude Code command without returning the token", () => {
    const d = deps();
    const result = createHandlers(d).copyClaudeCodeCommand();
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("s3cr3t-value");
    expect(d.clipboard[0]).toContain("Bearer s3cr3t-value");
  });

  it("copies the extension file to Documents, shows it and explains the installation", async () => {
    const d = deps();
    const result = await createHandlers(d).installClaudeExtension();
    expect(result.ok).toBe(true);
    expect(d.revealed).toEqual([join("docs", "Astrolabe", "astrolabe.mcpb")]);
    expect(result.message).toContain("Settings > Extensions");
    expect(result.message).toContain(join("docs", "Astrolabe", "astrolabe.mcpb"));
  });

  it("still names the file when the file manager cannot show it", async () => {
    const d = deps({
      revealPath: () => {
        throw new Error("no explorer");
      },
    });
    const result = await createHandlers(d).installClaudeExtension();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("astrolabe.mcpb");
    expect(result.message).not.toContain("shown in your file manager");
  });

  it("shows the bundled file when it cannot be copied", async () => {
    const d = deps({
      copyFile: async () => {
        throw new Error("disk full");
      },
    });
    const result = await createHandlers(d).installClaudeExtension();
    expect(result.ok).toBe(false);
    expect(d.revealed).toEqual(["x.mcpb"]);
    expect(result.message).toContain("Settings > Extensions");
  });

  it("refuses updates outside the installed app and installs only after a download", async () => {
    const h = createHandlers(deps());
    expect((await h.checkForUpdates()).ok).toBe(false);
    expect(h.installUpdate().ok).toBe(false);
  });
});

describe("game data handlers", () => {
  it("answers plainly when sync is off, after a check and when no data waits", async () => {
    expect((await createHandlers(deps()).checkForData()).ok).toBe(false);
    const sync = (result: "installed" | "up-to-date" | "busy" | "failed") => ({
      check: async () => ({ result, ...(result === "failed" ? { message: "offline" } : {}) }),
      stop: () => undefined,
    });
    const run = async (r: "installed" | "up-to-date" | "busy" | "failed") =>
      createHandlers(deps({ dataSync: () => sync(r) })).checkForData();
    expect(await run("installed")).toMatchObject({
      ok: true,
      message: expect.stringContaining("Restart"),
    });
    expect(await run("up-to-date")).toMatchObject({ ok: true });
    expect(await run("failed")).toMatchObject({
      ok: false,
      message: expect.stringContaining("offline"),
    });
    expect(createHandlers(deps()).restartForData().ok).toBe(false);
  });

  it("relaunches only when a downloaded release is ready", () => {
    let relaunched = 0;
    const ready = deps({
      relaunch: () => (relaunched += 1),
      getStatus: () => ({
        appVersion: "1",
        server: { state: "starting" },
        update: { state: "idle" },
        data: { state: "ready", releaseId: "poe2-1.0.0+r1" },
      }),
    });
    expect(createHandlers(ready).restartForData().ok).toBe(true);
    expect(relaunched).toBe(1);
  });
});
