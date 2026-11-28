import { treeIconSource } from "./tree-icons/source.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseOptimizerConfig } from "@astrolabe/optimizer";
import { createForgePipeline, StageConfig } from "@astrolabe/agents";
import { loadOrCreateAccessToken } from "./access-token.js";
import { CalcFake } from "./calc/calc-fake.js";
import { CalcNone, catalogOnlyReason, pobMismatch } from "./calc/calc-none.js";
import { ClassBaseBuilds, type BaseBuildSource } from "./calc/base-builds.js";
import { PersistedCalc } from "./calc/persisted-calc.js";
import { PobCalc, type CalcRequester } from "./calc/pob-calc.js";
import { createItemRenderer } from "./calc/item-text.js";
import { PobSkeleton } from "./calc/skeleton.js";
import { importExampleGuides } from "./guides/example-guides.js";
import { createCraft, createEconomy, type EconomySettings } from "./tools/craft-economy.js";
import type { CalcPort } from "./ports/calc.js";
import { loadCatalogRelease } from "./catalog/memory-catalog.js";
import { loadForgeConfig } from "./config/forge-config.js";
import { ForgeEngine } from "./engine/forge-engine.js";
import { createApp, LOOPBACK_HOST } from "./http/app.js";
import type { Logger } from "./logger.js";
import { createPocPipeline } from "./pipelines/poc-pipeline.js";
import { createGuideRevalidate } from "./tools/guide-revalidate.js";
import { GuideSweeper } from "./tools/guide-sweep.js";
import { RunStore } from "./store/run-store.js";

/** The PoB worker pool as the server uses it (`CalcPool` from apps/calc fits). */
export type PobPool = CalcRequester & BaseBuildSource & { close(): Promise<void> };

/** The part of a stored guide the sweep reads before deciding whether a check is needed. */
const BuiltWith = z.object({ metadata: z.object({ dataReleaseId: z.string() }) });

/** Default local port; the .mcpb bridge uses the same default. */
export const DEFAULT_PORT = 47615;

export interface StartOptions {
  port: number;
  /** SQLite file for runs and events. */
  databasePath: string;
  /** Directory of an unpacked data release (manifest.json + shards). */
  catalogDir: string;
  /** config/forge/forge.json */
  configPath: string;
  /** config/agents/stages.json (settings of the planning stages) */
  stagesConfigPath: string;
  /**
   * "fake" (calc-fake: fantasy values, only for logic tests) must be chosen
   * explicitly so such values never appear by accident. The real engine is
   * the PoB worker pool the caller starts (apps/calc `startCalcPool`); with it
   * the real pipeline "forge" is the default and S3 measures skeleton builds.
   */
  calc:
    | "fake"
    | "none"
    | { engine: "pob"; pool: PobPool; optimizerConfigPath: string; pobVersion: string };
  /** config/crafting/sim.json; enables the MCP tool craft_simulate. */
  craftConfigPath?: string;
  /** Market prices (poe.ninja); enables economy_price and crafting costs. Absent = no price tool. */
  economy?: EconomySettings;
  /** Directory with unpacked data releases (one folder per release id); enables guide_revalidate. */
  releasesDir?: string;
  /** The PathOfBuilding-PoE2 folder (holds `src/`); its passive tree sheets give the node icons (`/api/tree/icons.*`). */
  pobRoot?: string;
  /** Folder of guide files (`GuideFile`) imported on start when the store lacks them (example guides). */
  exampleGuidesDir?: string;
  allowedOrigins: readonly string[];
  /** File with the per-installation access token (created if missing). */
  tokenFile: string;
  logger: Logger;
}

/**
 * Loads config and catalog, opens the store and listens on 127.0.0.1. The
 * server owns the PoB pool it is given: it closes it on shutdown and when
 * startup fails.
 */
export async function startServer(
  options: StartOptions,
): Promise<{ app: FastifyInstance; store: RunStore; url: string }> {
  try {
    return await startServerOwningPool(options);
  } catch (error) {
    if (typeof options.calc === "object") {
      try {
        await options.calc.pool.close();
      } catch (closeError) {
        options.logger.error("could not close the calc pool after a failed start", {
          error: closeError,
        });
      }
    }
    throw error;
  }
}

async function startServerOwningPool(
  options: StartOptions,
): Promise<{ app: FastifyInstance; store: RunStore; url: string }> {
  const config = await loadForgeConfig(options.configPath);
  const stages = await loadStageConfig(options.stagesConfigPath);
  const catalog = await loadCatalogRelease(options.catalogDir);
  const accessToken = await loadOrCreateAccessToken(options.tokenFile);
  const store = new RunStore(options.databasePath, options.logger);
  if (options.exampleGuidesDir !== undefined) {
    await importExampleGuides(options.exampleGuidesDir, store, options.logger, () => new Date());
  }
  let calc: CalcPort;
  let pobCalc: PobCalc | undefined;
  let skeleton: PobSkeleton | undefined;
  // Catalog-only mode: no engine, or the installed PoB does not fit the data release.
  let catalogOnly: string | undefined;
  if (options.calc === "none") {
    catalogOnly = catalogOnlyReason({
      pobVersion: undefined,
      releasePobVersion: catalog.release?.pobVersion,
    });
  } else if (
    options.calc !== "fake" &&
    pobMismatch(options.calc.pobVersion, catalog.release?.pobVersion)
  ) {
    catalogOnly = catalogOnlyReason({
      pobVersion: options.calc.pobVersion,
      releasePobVersion: catalog.release?.pobVersion,
    });
  }
  if (catalogOnly !== undefined) {
    options.logger.info(catalogOnly, { dataReleaseId: catalog.dataReleaseId });
    // Stored results of earlier runs stay readable; only new calculations are refused.
    calc = new PersistedCalc(new CalcNone(catalogOnly), store);
  } else if (options.calc === "fake") {
    options.logger.info("calc engine is calc-fake: values are not from Path of Building", {
      dataReleaseId: catalog.dataReleaseId,
    });
    calc = new PersistedCalc(new CalcFake({ dataReleaseId: catalog.dataReleaseId }), store);
  } else {
    if (options.calc === "none") throw new Error("catalog-only mode always has a reason");
    const { pool, optimizerConfigPath } = options.calc;
    pobCalc = new PobCalc({
      pool,
      bases: new ClassBaseBuilds(pool),
      renderItem: createItemRenderer(catalog),
      logger: options.logger,
    });
    calc = new PersistedCalc(pobCalc, store);
    skeleton = new PobSkeleton({
      pob: pobCalc,
      pool,
      calc,
      catalog,
      optimizerConfig: await loadOptimizerConfig(optimizerConfigPath),
      settings: stages.s3,
      ...(stages.minion === undefined ? {} : { minion: stages.minion }),
      ...(stages.s5 === undefined
        ? {}
        : {
            target: {
              calcProfiles: stages.s5.calcProfiles,
              objective: stages.s5.objective,
              unsupportedMods: stages.s5.unsupportedMods,
              unsupportedMaxRounds: stages.s5.unsupportedMaxRounds,
            },
          }),
      ...(stages.s6 === undefined
        ? {}
        : {
            progression: { calcProfiles: stages.s6.calcProfiles, objective: stages.s6.objective },
          }),
      logger: options.logger,
    });
  }
  // The profiles numbers of a run may come from: the PoC's and, with PoB, the stages'.
  const stageProfiles =
    pobCalc === undefined
      ? []
      : [
          ...stages.s3.calcProfiles,
          ...(stages.s5?.calcProfiles ?? []),
          ...(stages.s6?.calcProfiles ?? []),
          ...(stages.s7?.calcProfiles ?? []),
        ];
  const knownProfiles = [...new Set([...config.pipelines.poc.calcProfiles, ...stageProfiles])];
  const economy =
    options.economy === undefined
      ? undefined
      : await createEconomy(options.economy, catalog, options.logger);
  const craft =
    options.craftConfigPath === undefined
      ? undefined
      : await createCraft(options.craftConfigPath, catalog, economy, options.logger);
  const engine = new ForgeEngine({
    ...(catalogOnly === undefined ? {} : { catalogOnlyReason: catalogOnly }),
    store,
    catalog,
    calc,
    config,
    logger: options.logger,
    ...(skeleton === undefined ? {} : { skeleton, target: skeleton, progression: skeleton }),
    ...(craft === undefined ? {} : { craft: { simulate: craft } }),
    ...(economy === undefined
      ? {}
      : {
          economy: {
            price: async (input) => {
              const answer = await economy.price(input);
              if (answer.freshness === "stale") {
                options.logger.error(
                  "prices come from an older price book because the refresh failed",
                  {
                    fetchedAt: answer.fetchedAt,
                    refreshError: answer.refreshError,
                  },
                );
              }
              return {
                league: answer.league,
                inCurrencyItemId: answer.inCurrencyItemId,
                freshness: answer.freshness,
                prices: answer.prices,
              };
            },
          },
        }),
    pipelines: [createPocPipeline(config.pipelines.poc), createForgePipeline(stages)],
    calcProfiles: knownProfiles,
  });
  const guideRevalidate =
    options.releasesDir === undefined
      ? undefined
      : createGuideRevalidate({
          findGuide: (id) => store.findGuide(id),
          releasesDir: options.releasesDir,
          now: () => new Date(),
          logger: options.logger,
        });
  const sweeper =
    guideRevalidate === undefined
      ? undefined
      : new GuideSweeper({
          listGuideIds: () => store.listGuideIds(),
          revalidate: guideRevalidate,
          builtWith: (id) => {
            const parsed = BuiltWith.safeParse(store.findGuide(id));
            return parsed.success ? parsed.data.metadata.dataReleaseId : undefined;
          },
          save: (guideId, to, outcome, at) => store.savePatchCheck(guideId, to, outcome, at),
          list: (to) => store.listPatchChecks(to),
          currentReleaseId: catalog.dataReleaseId,
          now: () => new Date(),
          logger: options.logger,
        });
  const app = createApp({
    ...(craft === undefined ? {} : { craft }),
    ...(economy === undefined ? {} : { economy: economy.price }),
    ...(guideRevalidate === undefined ? {} : { guideRevalidate }),
    ...(sweeper === undefined ? {} : { guideSweep: sweeper }),
    ...(options.pobRoot === undefined ? {} : { treeIcons: treeIconSource(options.pobRoot) }),
    findGuide: (id) => store.findGuide(id),
    findRunByGuide: (id) => store.findRunByGuideId(id),
    listGuideIds: () => store.listGuideIds(),
    guideOrigin: (id) => store.guideOrigin(id),
    importGuide: (file, at) => store.importGuide(file, at),
    engine,
    catalog,
    calc,
    calcProfiles: stageProfiles.length > 0 ? stageProfiles : config.pipelines.poc.calcProfiles,
    waitLongPollSeconds: config.waitLongPollSeconds,
    logger: options.logger,
    port: options.port,
    allowedOrigins: options.allowedOrigins,
    defaultPipelineId: pobCalc === undefined ? "poc" : "forge",
    ...(catalogOnly === undefined ? {} : { catalogOnlyReason: catalogOnly }),
    accessToken,
  });
  app.addHook("onClose", async () => {
    engine.stopJobs();
    try {
      await sweeper?.stop();
      await pobCalc?.close();
      if (typeof options.calc === "object") await options.calc.pool.close();
    } finally {
      store.close();
    }
  });
  try {
    await app.listen({ host: LOOPBACK_HOST, port: options.port });
  } catch (error) {
    store.close();
    throw error;
  }
  // Right after start: check the stored guides against the release the server runs with.
  if (sweeper !== undefined) {
    void sweeper.run().catch((error: unknown) => {
      options.logger.error("guide sweep crashed", { error });
    });
  }
  const url = `http://${LOOPBACK_HOST}:${options.port}`;
  options.logger.info("listening", { url, mcp: `${url}/mcp`, tokenFile: options.tokenFile });
  return { app, store, url };
}

async function loadStageConfig(path: string): Promise<StageConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read stage config ${path}`, { cause: error });
  }
  // The quality rubric is a file of its own next to the stage config; it is read into the config.
  const s9 = (
    raw as {
      s9?: {
        rubricFile?: unknown;
        rubric?: unknown;
        guideSpecFile?: unknown;
        guideSpec?: unknown;
        researchFile?: unknown;
        research?: unknown;
      };
    } | null
  )?.s9;
  if (s9 !== undefined && typeof s9.rubricFile === "string") {
    const rubricPath = join(dirname(path), s9.rubricFile);
    try {
      s9.rubric = JSON.parse(await readFile(rubricPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read guide rubric ${rubricPath}`, { cause: error });
    }
  }
  // The guide specification is a file of its own too; it is handed to Claude per task.
  if (s9 !== undefined && typeof s9.guideSpecFile === "string") {
    const specPath = join(dirname(path), s9.guideSpecFile);
    try {
      s9.guideSpec = JSON.parse(await readFile(specPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read guide specification ${specPath}`, { cause: error });
    }
  }
  // The research settings are a file of their own too.
  if (s9 !== undefined && typeof s9.researchFile === "string") {
    const researchPath = join(dirname(path), s9.researchFile);
    try {
      s9.research = JSON.parse(await readFile(researchPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read research settings ${researchPath}`, { cause: error });
    }
  }
  const parsed = StageConfig.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid stage config ${path}: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function loadOptimizerConfig(path: string): Promise<ReturnType<typeof parseOptimizerConfig>> {
  try {
    return parseOptimizerConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(`Cannot read optimizer config ${path}`, { cause: error });
  }
}
