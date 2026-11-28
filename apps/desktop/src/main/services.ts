import { z } from "zod";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { pobInstallFromHome, startCalcPool } from "@astrolabe/calc";
import {
  createStderrLogger,
  defaultTokenFile,
  loadCatalogRelease,
  loadOrCreateAccessToken,
  startServer,
  type Logger,
} from "@astrolabe/server";

export const Health = z
  .object({
    calcEngine: z.enum(["fake", "pob", "none"]),
    /** Catalog-only mode: why there is no engine for this data release. */
    catalogOnlyReason: z.string().min(1).max(500).optional(),
    dataReleaseId: z.string().min(1),
  })
  .refine((h) => (h.calcEngine === "none") === (h.catalogOnlyReason !== undefined), {
    message: "catalogOnlyReason belongs to the engine kind none, and only to it",
  });

export interface Services {
  readonly url: string;
  readonly token: string;
  readonly port: number;
  readonly calcEngine: "fake" | "pob" | "none";
  readonly catalogOnlyReason?: string;
  readonly dataReleaseId: string;
  stop(): Promise<void>;
}

export interface StartServicesOptions {
  port: number;
  databasePath: string;
  catalogDir: string;
  forgeConfigPath: string;
  stagesConfigPath: string;
  /** Folder with installed data releases (one folder per release id); enables guide_revalidate. */
  releasesDir?: string;
  /** Folder of example guide files the server imports on start (see `StartOptions.exampleGuidesDir`). */
  exampleGuidesDir?: string;
  /** Crafting simulator settings; enables craft_simulate. */
  craftConfigPath?: string;
  /** Market prices (poe.ninja); enables economy_price and crafting costs. Absent = no prices. */
  economy?: NonNullable<Parameters<typeof startServer>[0]["economy"]>;
  logger?: Logger;
  /**
   * Where Path of Building and the calc service files are. The real engine starts when PoB is
   * installed there; without it the app runs on calc-fake and says so (`calcEngine`).
   */
  pob?: PobLocation;
}

export interface PobLocation {
  /** Holds `config/calc` and `config/calc-profiles`. */
  resourcesRoot: string;
  /** Holds PathOfBuilding-PoE2/ with src and runtime. */
  pobHome: string;
  workerLua: string;
  optimizerConfigPath: string;
  /** The installed app: a missing PoB is a broken installer, so the start fails. Development: calc-fake. */
  required: boolean;
  /** LuaJIT executable; set for the installed app so no environment variable can replace it. */
  luajit?: string;
}

type StartCalc = Parameters<typeof startServer>[0]["calc"];

async function installed(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Cannot inspect ${path}`, { cause: error });
  }
}

/**
 * The real calc engine when PoB is installed, calc-fake when it is not there at all. A PoB that
 * is installed but does not start is an error, never a silent fallback to fake numbers.
 */
export async function chooseCalc(
  pob: PobLocation | undefined,
  catalogDir: string,
  logger: Logger,
): Promise<StartCalc> {
  if (pob === undefined) return "fake";
  const wrapper = join(pob.pobHome, "PathOfBuilding-PoE2", "src", "HeadlessWrapper.lua");
  if (!(await installed(wrapper))) {
    if (pob.required) {
      throw new Error(
        `Path of Building is missing from this installation (${wrapper}). Reinstall Astrolabe.`,
      );
    }
    logger.info("Path of Building is not installed; the app runs on calc-fake", {
      pobHome: pob.pobHome,
    });
    return "fake";
  }
  const { dataReleaseId } = await loadCatalogRelease(catalogDir);
  const pool = await startCalcPool({
    root: pob.resourcesRoot,
    install: {
      ...pobInstallFromHome(pob.pobHome),
      workerLua: pob.workerLua,
      ...(pob.luajit === undefined ? {} : { luajit: pob.luajit }),
    },
    dataReleaseId,
    onEvent: (event) => {
      const problem = "error" in event ? { error: event.error } : {};
      const level =
        event.type === "release-failed" ||
        event.type === "slot-disabled" ||
        event.type === "worker-start-failed"
          ? "error"
          : "info";
      logger[level]("calc pool", {
        event: event.type,
        slot: "slot" in event ? event.slot : undefined,
        ...problem,
      });
    },
  });
  return {
    engine: "pob",
    pool,
    optimizerConfigPath: pob.optimizerConfigPath,
    pobVersion: pool.meta.pobVersion,
  };
}

/**
 * Starts the local server in-process on 127.0.0.1. The access token lives in
 * the same file the .mcpb bridge reads, so Claude Desktop finds it.
 *
 * The calc engine is the PoB worker pool (apps/calc) when PoB is installed next to the app,
 * otherwise calc-fake. `calcEngine` in the result tells the UI honestly which one is running.
 */
export async function startServices(options: StartServicesOptions): Promise<Services> {
  const logger = options.logger ?? createStderrLogger("server");
  const tokenFile = defaultTokenFile();
  let started: Awaited<ReturnType<typeof startServer>>;
  const calc = await chooseCalc(options.pob, options.catalogDir, logger);
  try {
    started = await startServer({
      port: options.port,
      databasePath: options.databasePath,
      catalogDir: options.catalogDir,
      configPath: options.forgeConfigPath,
      stagesConfigPath: options.stagesConfigPath,
      calc,
      ...(options.pob === undefined
        ? {}
        : { pobRoot: join(options.pob.pobHome, "PathOfBuilding-PoE2") }),
      ...(options.releasesDir === undefined ? {} : { releasesDir: options.releasesDir }),
      ...(options.exampleGuidesDir === undefined
        ? {}
        : { exampleGuidesDir: options.exampleGuidesDir }),
      ...(options.craftConfigPath === undefined
        ? {}
        : { craftConfigPath: options.craftConfigPath }),
      ...(options.economy === undefined ? {} : { economy: options.economy }),
      allowedOrigins: [],
      tokenFile,
      logger,
    });
  } catch (error) {
    // The server closes the pool itself when it does not start.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        `Port ${options.port} is already in use. Close the other program or Astrolabe window that uses it.`,
        { cause: error },
      );
    }
    throw error;
  }
  const token = await loadOrCreateAccessToken(tokenFile);
  let health: z.infer<typeof Health>;
  try {
    const response = await fetch(`${started.url}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health = Health.parse(await response.json());
  } catch (error) {
    await started.app.close();
    throw new Error("The local server started but did not answer its health check.", {
      cause: error,
    });
  }
  return {
    url: started.url,
    token,
    port: options.port,
    calcEngine: health.calcEngine,
    ...(health.catalogOnlyReason === undefined
      ? {}
      : { catalogOnlyReason: health.catalogOnlyReason }),
    dataReleaseId: health.dataReleaseId,
    stop: () => started.app.close(),
  };
}
