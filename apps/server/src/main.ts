#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startCalcPool } from "@astrolabe/calc";
import { loadCatalogRelease } from "./catalog/memory-catalog.js";
import { defaultTokenFile } from "./access-token.js";
import { createStderrLogger } from "./logger.js";
import { DEFAULT_PORT, startServer } from "./start.js";

/*
 * Development entry point. In the packaged app, apps/desktop calls
 * startServer() directly with paths inside the user's app data folder.
 */
const { values } = parseArgs({
  options: {
    port: { type: "string", default: String(DEFAULT_PORT) },
    db: { type: "string", default: "astrolabe.sqlite" },
    catalog: { type: "string" },
    config: { type: "string", default: "config/forge/forge.json" },
    stages: { type: "string", default: "config/agents/stages.json" },
    calc: { type: "string" },
    "pob-root": { type: "string", default: "." },
    optimizer: { type: "string", default: "config/optimizer/tree.json" },
    "craft-config": { type: "string", default: "config/crafting/sim.json" },
    economy: { type: "string" },
    "releases-dir": { type: "string" },
    origin: { type: "string", multiple: true, default: [] },
    "token-file": { type: "string", default: defaultTokenFile() },
  },
});

const logger = createStderrLogger("server");
const port = Number(values.port);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  logger.error("invalid --port", { port: values.port });
  process.exit(2);
}
if (values.catalog === undefined) {
  logger.error("--catalog <data release dir> is required");
  process.exit(2);
}
if (values.calc !== "fake" && values.calc !== "pob" && values.calc !== "none") {
  logger.error(
    "--calc fake|pob|none is required (fake = calc-fake, pob = Path of Building worker pool, none = catalog only)",
  );
  process.exit(2);
}

const badOrigin = values.origin.find((o) => !isExactOrigin(o));
if (badOrigin !== undefined) {
  logger.error("--origin must be an exact origin like http://127.0.0.1:5173", {
    origin: badOrigin,
  });
  process.exit(2);
}

async function chooseCalc(catalogDir: string): Promise<Parameters<typeof startServer>[0]["calc"]> {
  if (values.calc === "fake") return "fake";
  if (values.calc === "none") return "none";
  // The pool stamps every result with the data release of the catalog the server uses.
  const { dataReleaseId } = await loadCatalogRelease(catalogDir);
  const pool = await startCalcPool({
    root: values["pob-root"],
    dataReleaseId,
    onEvent: (event) => {
      // Problems with workers are errors; the nested error would not survive logging as is.
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
    optimizerConfigPath: values.optimizer,
    pobVersion: pool.meta.pobVersion,
  };
}

const catalogDir = values.catalog;

chooseCalc(catalogDir)
  .then((calc) =>
    startServer({
      port,
      databasePath: values.db,
      catalogDir,
      configPath: values.config,
      stagesConfigPath: values.stages,
      calc,
      craftConfigPath: values["craft-config"],
      ...(values.economy === undefined
        ? {}
        : {
            economy: {
              configPath: "config/economy/economy.json",
              itemMapPath: "config/economy/item-map.json",
              cacheDir: values.economy,
              appVersion: "dev",
            },
          }),
      pobRoot: join(values["pob-root"], ".pob", "PathOfBuilding-PoE2"),
      ...(values["releases-dir"] === undefined ? {} : { releasesDir: values["releases-dir"] }),
      allowedOrigins: values.origin,
      tokenFile: values["token-file"],
      logger,
    }),
  )
  .then(({ app }) => {
    // Closing the app closes the PoB pool, so no worker processes are left behind.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        app.close().then(
          () => process.exit(0),
          (error: unknown) => {
            logger.error("shutdown failed", { error });
            process.exit(1);
          },
        );
      });
    }
  })
  .catch((error: unknown) => {
    logger.error("server failed to start", { error });
    process.exit(1);
  });

function isExactOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}
