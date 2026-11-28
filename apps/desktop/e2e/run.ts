/**
 * Windows end-to-end check of the real installer (F-09). It installs Astrolabe-Setup silently,
 * starts the installed app, looks at its window through the Chrome DevTools protocol (Playwright),
 * starts the bundled .mcpb extension the way Claude Desktop does and drives the local MCP endpoint
 * through it, including a calculation with the real Path of Building. Screenshots and logs go to
 * the output folder; the exit code is 1 when any step failed.
 *
 *   node --experimental-strip-types e2e/run.ts <installer.exe> <out dir>
 *
 * Environment: EXPECT_DATA_RELEASE_ID (e.g. poe2-0.5.5.10+r15): the release the installer bundles.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { McpStdioClient, resolveLaunch, type McpbManifest } from "./mcpb.ts";
import {
  replay,
  ReplayRetry,
  type Recording,
  type ReplayStep,
  type SubmitOutcome,
} from "./recording.ts";

const DEBUG_PORT = 9333;
const SERVER_PORT = 47615;
const SERVER = `http://127.0.0.1:${SERVER_PORT}`;

const installerArg = process.argv[2];
const outDir = resolve(process.argv[3] ?? "e2e-out");
if (installerArg === undefined) throw new Error("usage: run.ts <installer.exe> <out dir>");
const installer: string = installerArg;
if (process.platform !== "win32") throw new Error("this check runs the Windows installer");
mkdirSync(outDir, { recursive: true });

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`environment variable ${name} is not set`);
  return value;
};
/** The app must end this soon after its window closed, whatever is still connected. */
const QUIT_LIMIT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { step: string; ok: boolean; seconds: number; error?: string }[] = [];
let page: Page | undefined;
let browser: Browser | undefined;
let app: ChildProcess | undefined;
let mcp: McpStdioClient | undefined;

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  console.log(`::group::${name}`);
  try {
    const value = await fn();
    results.push({ step: name, ok: true, seconds: (Date.now() - started) / 1000 });
    console.log("ok");
    return value;
  } catch (error) {
    const message = error instanceof Error ? `${error.message}` : String(error);
    results.push({ step: name, ok: false, seconds: (Date.now() - started) / 1000, error: message });
    console.error(`FAILED: ${message}`);
    throw error;
  } finally {
    console.log("::endgroup::");
  }
}

function needPage(): Page {
  if (page === undefined) throw new Error("the app window is not connected yet");
  return page;
}
function needMcp(): McpStdioClient {
  if (mcp === undefined) throw new Error("the extension is not started yet");
  return mcp;
}

async function shot(name: string): Promise<void> {
  if (page === undefined || page.isClosed()) return;
  try {
    await page.screenshot({ path: join(outDir, `${name}.png`) });
  } catch (error) {
    console.error(`screenshot ${name} failed:`, error);
  }
}

async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last = "no answer yet";
  while (Date.now() < end) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what} (last: ${last})`);
}

function killTree(child: ChildProcess | undefined): void {
  if (child?.pid === undefined) return;
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
}

interface Status {
  appVersion: string;
  server: { state: string; calcEngine?: string; dataReleaseId?: string; message?: string };
  update: { state: string; reason?: string; message?: string };
  data: { state: string };
}

async function api(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${init.method ?? "GET"} ${path} → ${response.status}: ${text}`);
  return JSON.parse(text) as unknown;
}

async function main(): Promise<void> {
  const expectedRelease = env("EXPECT_DATA_RELEASE_ID");
  const localAppData = env("LOCALAPPDATA");
  const appData = env("APPDATA");

  const installDir = await step("Install silently", async () => {
    const run = spawnSync(resolve(installer), ["/S"], { stdio: "inherit", timeout: 300_000 });
    if (run.status !== 0) throw new Error(`installer exited with ${run.status ?? run.error}`);
    // Per-user install: %LOCALAPPDATA%\\Programs\\<name>; the folder name comes from the builder,
    // so look for the exe instead of assuming the name.
    const programs = join(localAppData, "Programs");
    const dir = await until("Astrolabe.exe after the installer", 120_000, async () => {
      if (!existsSync(programs)) return undefined;
      return readdirSync(programs)
        .map((name) => join(programs, name))
        .find((candidate) => existsSync(join(candidate, "Astrolabe.exe")));
    }).catch((error: unknown) => {
      const listing = existsSync(programs)
        ? readdirSync(programs).join(", ")
        : "(no Programs folder)";
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ${programs} holds: ${listing}`,
      );
    });
    console.log(`installed to ${dir}`);
    return dir;
  });
  const resources = join(installDir, "resources");

  await step("Installed files are complete", async () => {
    const needed = [
      "astrolabe.mcpb",
      "app-update.yml",
      join("pob", "PathOfBuilding-PoE2", "runtime", "luajit.exe"),
      join("pob", "PathOfBuilding-PoE2", "src", "HeadlessWrapper.lua"),
      join("calc-lua", "worker.lua"),
      join("config", "crafting", "sim.json"),
      join("data-release", "manifest.json"),
      join("web", "index.html"),
    ];
    const missing = needed.filter((rel) => !existsSync(join(resources, rel)));
    if (missing.length > 0) throw new Error(`missing in the installation: ${missing.join(", ")}`);
    const bundled = JSON.parse(
      readFileSync(join(resources, "data-release", "manifest.json"), "utf8"),
    ) as { release?: { id?: string } };
    if (bundled.release?.id !== expectedRelease) {
      throw new Error(
        `bundled data release is ${bundled.release?.id}, expected ${expectedRelease}`,
      );
    }
    const update = readFileSync(join(resources, "app-update.yml"), "utf8");
    if (!/provider: github/.test(update)) throw new Error(`app-update.yml: ${update}`);
  });

  await step("Start the installed app", async () => {
    const log = createWriteStream(join(outDir, "app.log"));
    app = spawn(join(installDir, "Astrolabe.exe"), [`--remote-debugging-port=${DEBUG_PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    app.stdout?.pipe(log);
    app.stderr?.pipe(log);
    app.on("exit", (code) => console.log(`Astrolabe.exe exited with ${code}`));
  });

  const tokenFile = join(appData, "Astrolabe", "access-token");
  const token = await step("Local server answers with the access token", async () => {
    const value = await until("the token file", 120_000, async () =>
      existsSync(tokenFile) ? (await readFile(tokenFile, "utf8")).trim() : undefined,
    );
    await until("the health check", 300_000, async () => {
      if (app?.exitCode !== null) throw new Error(`app exited with ${app?.exitCode}`);
      return (await api(value, "/api/health").catch(() => undefined)) as unknown;
    });
    return value;
  });

  const status = await step("Window shows a running server with PoB", async () => {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
    page = await until("the app window", 60_000, async () =>
      browser
        ?.contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().startsWith("astrolabe://")),
    );
    page.on("pageerror", (error) => console.error("page error:", error));
    page.on("console", (m) => m.type() === "error" && console.error("page console:", m.text()));
    await page.waitForLoadState("load");
    const read = () => needPage().evaluate("window.astrolabe.getStatus()") as Promise<Status>;
    const ready = await until("server state ready", 300_000, async () => {
      const s = await read();
      if (s.server.state === "failed") throw new Error(`server failed: ${s.server.message}`);
      return s.server.state === "ready" ? s : undefined;
    });
    await sleep(2000);
    await shot("01-start");
    if (ready.server.calcEngine !== "pob") {
      throw new Error(`calc engine is ${ready.server.calcEngine}, expected the real PoB`);
    }
    if (ready.server.dataReleaseId !== expectedRelease) {
      throw new Error(`app runs ${ready.server.dataReleaseId}, expected ${expectedRelease}`);
    }
    if (ready.update.state === "disabled") {
      throw new Error(`auto-update is off in the installed app: ${ready.update.reason}`);
    }
    return ready;
  });
  console.log(`app ${status.appVersion}, data ${status.server.dataReleaseId}`);

  await step("Install Claude extension copies the file", async () => {
    const result = (await needPage().evaluate("window.astrolabe.installClaudeExtension()")) as {
      ok: boolean;
      message: string;
    };
    if (!result.ok) throw new Error(result.message);
    const target = /The file is at (.+?\.mcpb)/.exec(result.message)?.[1];
    if (target === undefined || !existsSync(target)) throw new Error(result.message);
    if (statSync(target).size !== statSync(join(resources, "astrolabe.mcpb")).size) {
      throw new Error(`${target} differs from the bundled extension`);
    }
  });

  const extensionDir = await mkdtemp(join(tmpdir(), "astrolabe-mcpb-"));
  const manifest = await step("Unpack the extension and read its manifest", async () => {
    // Windows' own bsdtar; the GNU tar of Git for Windows reads "C:" as a remote host.
    const tar = join(env("SystemRoot"), "System32", "tar.exe");
    const run = spawnSync(tar, ["-xf", join(resources, "astrolabe.mcpb"), "-C", extensionDir], {
      encoding: "utf8",
    });
    if (run.status !== 0) throw new Error(`cannot unpack astrolabe.mcpb: ${run.stderr}`);
    return JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8")) as McpbManifest;
  });

  await step("Extension starts and lists the tools", async () => {
    mcp = McpStdioClient.start(resolveLaunch(manifest, extensionDir, process.execPath));
    await mcp.initialize();
    const listed = (await mcp.request("tools/list", {})) as { tools: { name: string }[] };
    const names = new Set(listed.tools.map((t) => t.name));
    const missing = (manifest.tools ?? []).map((t) => t.name).filter((n) => !names.has(n));
    if (missing.length > 0)
      throw new Error(`manifest tools the server lacks: ${missing.join(", ")}`);
  });

  const classId = await step("Catalog search through the extension", async () => {
    const found = await needMcp().callTool("catalog_search", { kind: "characterClass", limit: 5 });
    if (found.isError) throw new Error(found.text);
    const results = (JSON.parse(found.text) as { results: { id: string }[] }).results;
    const first = results[0];
    if (first === undefined) throw new Error(`no character class in the catalog: ${found.text}`);
    return first.id;
  });

  const run = await step("Create a run and attach with the session code", async () => {
    const created = (await api(token, "/api/runs", {
      method: "POST",
      body: JSON.stringify({
        request: {
          dataReleaseId: expectedRelease,
          skillIdea: "End-to-end check of the installer",
          mode: { hardcore: false, ssf: false },
          budget: { leveling: "start", endgame: "endgame" },
          preferences: {
            playstyleTags: [],
            focus: "allround",
            pace: "balanced",
            complexityTolerance: "medium",
            defenceLayers: [],
          },
        },
      }),
    })) as { runId: string };
    const code = (await api(token, `/api/runs/${created.runId}/session-code`, {
      method: "POST",
      body: "{}",
    })) as { sessionCode: string };
    const attached = await needMcp().callTool("forge_attach", { code: code.sessionCode });
    if (attached.isError) throw new Error(`forge_attach: ${attached.text}`);
    await needPage().reload();
    await sleep(2000);
    await shot("02-run");
    return created.runId;
  });

  await step("Real PoB calculation through the extension", async () => {
    const state = { classId, level: 1, tree: { allocated: [] }, skills: [], items: [] };
    const answer = await needMcp().callTool("calc_evaluate", { state, runId: run });
    if (answer.isError) throw new Error(`calc_evaluate: ${answer.text}`);
    const body = JSON.parse(answer.text) as {
      status: string;
      results?: { status: string; engine?: string; stats?: Record<string, unknown> }[];
    };
    const first = body.results?.[0];
    if (body.status !== "calculated" || first?.status !== "ok" || first.engine !== "pob") {
      throw new Error(`no PoB result: ${answer.text.slice(0, 800)}`);
    }
    if (Object.keys(first.stats ?? {}).length === 0) throw new Error("PoB returned no stats");
  });

  await step("Task answer given as JSON string reaches the schema check", async () => {
    const next = await needMcp().callTool("forge_next", { runId: run });
    if (next.isError) throw new Error(`forge_next: ${next.text}`);
    const step = JSON.parse(next.text) as {
      kind: string;
      task?: { taskId: string; attempt: number };
    };
    if (step.kind !== "task" || step.task === undefined) {
      throw new Error(`expected a first task, got: ${next.text.slice(0, 400)}`);
    }
    // An empty answer is wrong on purpose: the app must reject it by the task's schema and say
    // so in findings, not fail while reading the argument ("expected object, received string").
    const submitted = await needMcp().callTool("forge_submit", {
      runId: run,
      taskId: step.task.taskId,
      attempt: step.task.attempt,
      payload: {},
    });
    if (submitted.isError) throw new Error(`forge_submit: ${submitted.text.slice(0, 800)}`);
    const body = JSON.parse(submitted.text) as { result?: string; findings?: unknown[] };
    if (body.result !== "rejected" || (body.findings ?? []).length === 0) {
      throw new Error(`expected a rejection with findings, got: ${submitted.text.slice(0, 800)}`);
    }
  });

  const recordingFile = join(import.meta.dirname, "fixtures", "run-recording.json");
  // The replay runs the real tree search and takes hours (nightly or by hand: E2E_FULL_RUN=1).
  if (existsSync(recordingFile) && process.env["E2E_FULL_RUN"] !== "1") {
    console.log(
      "::notice::the whole-run replay runs nightly and on request (E2E_FULL_RUN=1), not in this check",
    );
    results.push({
      step: "Replay a whole recorded run S0 to S11 (nightly)",
      ok: true,
      seconds: 0,
      error: "skipped",
    });
  } else if (existsSync(recordingFile)) {
    const recording = JSON.parse(readFileSync(recordingFile, "utf8")) as Recording;
    if (recording.request.dataReleaseId !== expectedRelease) {
      throw new Error(
        `run recording is for ${recording.request.dataReleaseId}, the installer bundles ${expectedRelease}; record a run on that release`,
      );
    }
    const replayedGuide = await step(
      "Replay a whole recorded run S0 to S11 with the real PoB",
      async () => {
        const created = (await api(token, "/api/runs", {
          method: "POST",
          body: JSON.stringify({ request: recording.request }),
        })) as { runId: string };
        const runId = created.runId;
        const longWait = { timeoutMs: 30 * 60_000 };
        const stepOf = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
          const answer = await needMcp().callTool(name, args, longWait);
          if (answer.isError) throw new Error(`${name}: ${answer.text.slice(0, 1500)}`);
          return JSON.parse(answer.text) as unknown;
        };
        const code = (await api(token, `/api/runs/${runId}/session-code`, {
          method: "POST",
          body: "{}",
        })) as {
          sessionCode: string;
        };
        await stepOf("forge_attach", { code: code.sessionCode });
        const result = await replay(
          {
            next: async () => (await stepOf("forge_next", { runId })) as ReplayStep,
            submit: async (task, payload) =>
              (await stepOf("forge_submit", {
                runId,
                taskId: task.taskId,
                attempt: task.attempt,
                payload,
              })) as SubmitOutcome,
            intervene: async (intervention) => {
              const view = (await api(token, `/api/runs/${runId}`)) as {
                asks: { askId: string; answer?: string }[];
              };
              const open = view.asks.find((a) => a.answer === undefined);
              const body =
                intervention["kind"] === "answer" && open !== undefined
                  ? { ...intervention, askId: open.askId }
                  : intervention;
              try {
                await api(token, `/api/runs/${runId}/interventions`, {
                  method: "POST",
                  body: JSON.stringify(body),
                });
              } catch (error) {
                // 409 invalid_intervention: the app is not ready for this action yet (the
                // candidates are still being measured); the replay asks again later.
                const message = error instanceof Error ? error.message : String(error);
                if (!message.includes("→ 409") || !message.includes("invalid_intervention")) {
                  throw error;
                }
                console.log(`player action not accepted yet: ${message.slice(0, 200)}`);
                await sleep(5000);
                throw new ReplayRetry(message, { cause: error });
              }
            },
          },
          recording,
          { log: (line) => console.log(line) },
        );
        console.log(
          `replayed ${result.submitted} answers and ${result.interventions} player actions`,
        );
        return result.guideId;
      },
    );
    await step("Open the guide of the replayed run and save its .build", async () => {
      await needPage().evaluate(`window.location.hash = "#/guide/${replayedGuide}"`);
      await needPage().waitForLoadState("networkidle");
      await sleep(5000);
      await needPage().screenshot({ path: join(outDir, "05-replayed-guide.png"), fullPage: true });
      const build = await api(token, `/api/guides/${replayedGuide}/build-file`);
      const text = JSON.stringify(build, null, 2);
      if (text.length < 1000) throw new Error(`the .build file looks empty: ${text.slice(0, 300)}`);
      await writeFile(join(outDir, "replayed.build"), text);
    });
  } else {
    console.log(
      "::warning::e2e/fixtures/run-recording.json does not exist: the whole-run replay is skipped (see e2e/record.ts)",
    );
    results.push({
      step: "Replay a whole recorded run S0 to S11 (no recording yet)",
      ok: true,
      seconds: 0,
      error: "skipped",
    });
  }

  // A recorded guide (a real run's result, see fixtures/guide-file.json) on the data release it
  // was made with: import, open the guide page, export the .build file. The app is restarted on
  // that release (ASTROLABE_DATA_RELEASE), because a guide opens only on its own release.
  const guideFile = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "guide-file.json"), "utf8"),
  ) as {
    guide: { metadata: { guideId: string; dataReleaseId: string } };
  };
  const guideRelease = guideFile.guide.metadata.dataReleaseId;
  const guideId = guideFile.guide.metadata.guideId;
  await step(`Restart on ${guideRelease}, the release of the recorded guide`, async () => {
    mcp?.close();
    mcp = undefined;
    await browser?.close().catch(() => undefined);
    browser = undefined;
    page = undefined;
    killTree(app);
    await sleep(3000);
    const dir = env("E2E_GUIDE_DATA_DIR");
    if (!existsSync(join(dir, "manifest.json"))) throw new Error(`no data release in ${dir}`);
    app = spawn(join(installDir, "Astrolabe.exe"), [`--remote-debugging-port=${DEBUG_PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ASTROLABE_DATA_RELEASE: dir },
    });
    const guideLog = createWriteStream(join(outDir, "app-guide.log"));
    app.stdout?.pipe(guideLog);
    app.stderr?.pipe(guideLog);
    await until("the health check", 300_000, async () => {
      const health = (await api(token, "/api/health").catch(() => undefined)) as
        { dataReleaseId?: string } | undefined;
      return health?.dataReleaseId === guideRelease ? health : undefined;
    });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
    page = await until("the app window", 60_000, async () =>
      browser
        ?.contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().startsWith("astrolabe://")),
    );
    await page.waitForLoadState("load");
  });

  await step("Import the recorded guide and open its page", async () => {
    const imported = (await api(token, "/api/guides/import", {
      method: "POST",
      body: readFileSync(join(import.meta.dirname, "fixtures", "guide-file.json"), "utf8"),
    })) as { guideId: string };
    if (imported.guideId !== guideId)
      throw new Error(`imported ${imported.guideId}, expected ${guideId}`);
    await needPage().evaluate(`window.location.hash = "#/guide/${guideId}"`);
    await needPage().waitForLoadState("networkidle");
    await sleep(5000);
    const text = await needPage().innerText("body");
    if (/could not|failed|error/i.test(text.slice(0, 2000))) {
      await shot("04-guide-error");
      throw new Error(`the guide page shows a problem: ${text.slice(0, 500)}`);
    }
    // A tree that cannot be drawn shows a message instead of throwing, so look
    // at the canvas state itself: at least one tree drawn, none failed.
    const treeState = await until("the passive tree to be drawn", 60_000, async () => {
      const states = await needPage().$$eval(".ef-tree-canvas", (nodes) =>
        nodes.map((n) => ({
          status: n.getAttribute("data-status"),
          text: n.querySelector(".ef-tree-canvas__status")?.textContent ?? "",
        })),
      );
      const failedTree = states.find((s) => s.status === "error");
      if (failedTree !== undefined) throw new Error(`the passive tree failed: ${failedTree.text}`);
      return states.some((s) => s.status === "ready") ? states : undefined;
    });
    console.log(`passive tree canvases: ${treeState.length}`);
    await needPage().screenshot({ path: join(outDir, "04-guide.png"), fullPage: true });
  });

  await step("Save the guide as a .build file", async () => {
    const build = await api(token, `/api/guides/${guideId}/build-file`);
    const text = JSON.stringify(build, null, 2);
    if (typeof build !== "object" || build === null || text.length < 1000) {
      throw new Error(`the .build file looks empty: ${text.slice(0, 300)}`);
    }
    await writeFile(join(outDir, "guide.build"), text);
  });

  await step(
    "Quitting with a client connected ends the app in time, the next start works",
    async () => {
      // A person closes the window while Claude (or the page) still holds a connection to the local
      // server. Windows asks the window to close, like the installer does before it relaunches the
      // app. The process must end quickly: a process that lingers keeps the single-instance lock and
      // every later start only talks to it.
      const first = app;
      if (first?.pid === undefined) throw new Error("the app is not running");
      const gone = new Promise<void>((done) => first.once("exit", () => done()));
      const stream = new AbortController();
      const held = await fetch(`${SERVER}/api/runs/${run}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: stream.signal,
      });
      if (!held.ok) throw new Error(`the event stream answered ${held.status}`);
      void held.body
        ?.getReader()
        .read()
        .catch(() => undefined);
      await browser?.close().catch(() => undefined);
      browser = undefined;
      page = undefined;
      const closedAt = Date.now();
      spawnSync("taskkill", ["/PID", String(first.pid)], { stdio: "ignore" });
      const starts: ChildProcess[] = [];
      for (const waitMs of [500, 2000]) {
        await sleep(waitMs);
        starts.push(spawn(join(installDir, "Astrolabe.exe"), [], { stdio: "ignore" }));
      }
      await Promise.race([gone, sleep(QUIT_LIMIT_MS)]);
      stream.abort();
      const took = (Date.now() - closedAt) / 1000;
      if (first.exitCode === null) {
        throw new Error(
          `the app did not quit within ${QUIT_LIMIT_MS / 1000} seconds after the window closed`,
        );
      }
      console.log(`the app quit ${took.toFixed(1)} seconds after the window closed`);
      await sleep(3000);
      for (const start of starts) killTree(start);
      const crashed = ["app.log", "app-guide.log"].filter((name) => {
        const file = join(outDir, name);
        return (
          existsSync(file) &&
          /uncaught exception|Object has been destroyed/i.test(readFileSync(file, "utf8"))
        );
      });
      if (crashed.length > 0) throw new Error(`the app logged a crash in ${crashed.join(", ")}`);
      // The next start must get the single-instance lock and answer.
      await sleep(2000);
      app = spawn(join(installDir, "Astrolabe.exe"), [`--remote-debugging-port=${DEBUG_PORT}`], {
        stdio: "ignore",
      });
      await until("the health check after the restart", 180_000, async () => {
        if (app?.exitCode !== null) throw new Error(`app exited with ${app?.exitCode}`);
        return (await api(token, "/api/health").catch(() => undefined)) as unknown;
      });
    },
  );

  await shot("03-end");
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(error);
  await shot("failure");
} finally {
  mcp?.close();
  await browser?.close().catch(() => undefined);
  killTree(app);
  await writeFile(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  if (mcp !== undefined) await writeFile(join(outDir, "extension.log"), mcp.log);
  console.log(
    results
      .map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.step} (${r.seconds.toFixed(1)}s)`)
      .join("\n"),
  );
}
process.exit(failed ? 1 : 0);
