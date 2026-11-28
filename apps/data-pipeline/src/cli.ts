#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadPobSources } from "./config.ts";
import { loadGameDataConfig } from "./gamedata/config.ts";
import {
  exportGameData,
  fetchSchemaRecord,
  readGameDataManifest,
  readGameDataTable,
  resolveDatTool,
} from "./gamedata/export.ts";
import { exportItemArt, resolveFileRunner } from "./gamedata/item-art.ts";
import { queryPatchServer } from "./gamedata/patch.ts";
import { summarizeCatalogDiff, writeCatalogDiff } from "./diff/catalog-diff.ts";
import { diffSnapshots, summarizeDiff } from "./diff/snapshot-diff.ts";
import { pobInstallFromHome } from "./pob/extract.ts";
import { loadNormalizeConfig } from "./normalize/catalog.ts";
import { resolveModStats } from "./normalize/mod-stats.ts";
import { buildCatalog } from "./normalize/release.ts";
import { StatMatcher } from "./normalize/stat-matcher.ts";
import {
  decide,
  exitCodeFor,
  readPinnedCommit,
  renderReport,
  watchConfigSchema,
} from "./watch/watch.ts";
import { latestPobRelease, listDataGameVersions } from "./watch/github.ts";
import { buildSnapshot } from "./snapshot/build.ts";
import { readManifest, readShard } from "./snapshot/snapshot.ts";

const USAGE = `astrolabe-data <command>

  snapshot --game-version <x.y[.z.w]> --revision <n> --out <dir>
           [--pob-home .pob] [--sources config/data-pipeline/pob-sources.json]
      Extract the pinned PoB's game data into <dir>/raw and write <dir>/manifest.json.

  stat-coverage <snapshotDir> [--scope stat_descriptions] [--out <file>]
      Map every mod's display lines to stat ids and report what stays unresolved.

  catalog <snapshotDir> --out <dir> [--config config/data-pipeline/normalize.json]
          [--game-data <dir>] [--item-art <dir>]
      Normalise a snapshot to the catalog contract, validate it and write the
      release files (manifest.json, one shard per kind, findings.json).

  item-art <snapshot-dir> --game-data <dir> --out <dir>
           [--config config/data-pipeline/game-data.json]
      Read the inventory image of each base item of the snapshot from the patch the
      game-data step read (CI only); writes <out>/index.json and the PNG files.
  gamedata --out <dir> [--config config/data-pipeline/game-data.json]
      Read the configured game-data tables (currencies, essences, omens) of the
      current patch from the update servers and write them with a manifest.
      Needs network access; meant for CI.

  patch-watch --repo <owner/name> [--config config/data-pipeline/watch.json]
              [--game-config config/data-pipeline/game-data.json] [--out <report.md>]
      Compare the game patch the update server announces with the published data
      releases and the latest PoB-PoE2 release with the pinned one. Prints a report;
      exits 3 (EXIT_SOMETHING_TO_DO) when there is something to do (new patch or new PoB release). Needs network.

  catalog-diff <fromCatalogDir> <toCatalogDir>
      Compare two built catalogs; writes diff.json into <toCatalogDir> and records it
      (previousReleaseId, diffPath) in that catalog's manifest.json.
  diff <fromDir> <toDir> [--out <dir>]
      Compare two snapshots; writes diff.json and diff.md to --out (default: <toDir>).
`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "snapshot") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "game-version": { type: "string" },
        revision: { type: "string" },
        out: { type: "string" },
        "pob-home": { type: "string", default: ".pob" },
        sources: { type: "string", default: "config/data-pipeline/pob-sources.json" },
      },
      strict: true,
    });
    const gameVersion = values["game-version"] ?? fail("--game-version is required");
    const revisionText = values.revision ?? fail("--revision is required");
    const out = values.out ?? fail("--out is required");
    const revision = Number(revisionText);
    if (!Number.isInteger(revision) || revision < 0)
      fail(`--revision must be a whole number >= 0, got ${revisionText}`);
    const sourcesPath = resolve(values.sources);
    const manifest = await buildSnapshot({
      pob: pobInstallFromHome(values["pob-home"]),
      sources: await loadPobSources(sourcesPath),
      sourcesPath,
      outDir: out,
      gameVersion,
      revision,
    });
    console.warn(
      `snapshot ${manifest.releaseId} (PoB ${manifest.pobVersion}, tree ${manifest.treeVersion})`,
    );
    for (const s of manifest.shards) console.warn(`  ${s.kind}: ${String(s.count)}`);
    return;
  }
  if (command === "stat-coverage") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { scope: { type: "string", default: "stat_descriptions" }, out: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    const [dir] = positionals;
    if (!dir || positionals.length !== 1) fail(USAGE);
    const manifest = await readManifest(dir);
    const matcher = new StatMatcher(await readShard(dir, manifest, "statDescriptions"));
    const { results, summary } = resolveModStats(
      await readShard(dir, manifest, "mods"),
      matcher,
      values.scope,
    );
    const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`);
    console.warn(
      `${manifest.releaseId}: line groups resolved ${String(summary.lineGroupsResolved)}/${String(summary.lineGroups)} (${pct(summary.lineGroupsResolved, summary.lineGroups)}), ` +
        `mods fully resolved ${String(summary.modsFullyResolved)}/${String(summary.mods)} (${pct(summary.modsFullyResolved, summary.mods)})`,
    );
    if (values.out) {
      const unresolved = results
        .filter((r) => r.unresolved.length > 0)
        .map((r) => ({ modId: r.modId, unresolved: r.unresolved }));
      await writeFile(
        resolve(values.out),
        JSON.stringify({ releaseId: manifest.releaseId, summary, unresolved }, null, 2) + "\n",
      );
    }
    return;
  }
  if (command === "catalog") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        out: { type: "string" },
        config: { type: "string", default: "config/data-pipeline/normalize.json" },
        "game-data": { type: "string" },
        "item-art": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    const [dir] = positionals;
    if (!dir || positionals.length !== 1) fail(USAGE);
    const out = values.out ?? fail("--out is required");
    const gameData = values["game-data"];
    const itemArt = values["item-art"];
    const { manifest, warnings, summary } = await buildCatalog(
      dir,
      out,
      await loadNormalizeConfig(resolve(values.config)),
      new Date(),
      {
        ...(gameData === undefined ? {} : { gameDataDir: resolve(gameData) }),
        ...(itemArt === undefined ? {} : { itemArtDir: resolve(itemArt) }),
      },
    );
    console.warn(
      `catalog ${manifest.release.id}: 0 errors, ${String(warnings.length)} warnings (findings.json)`,
    );
    for (const [kind, byReason] of Object.entries(summary.unresolved)) {
      const parts = Object.entries(byReason).map(([r, n]) => `${String(n)} ${r}`);
      console.warn(`  unresolved ${kind} lines: ${parts.join(", ")}`);
    }
    for (const s of manifest.shards) console.warn(`  ${s.kind}: ${String(s.count)}`);
    return;
  }
  if (command === "gamedata") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        out: { type: "string" },
        config: { type: "string", default: "config/data-pipeline/game-data.json" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) fail(USAGE);
    const out = values.out ?? fail("--out is required");
    const config = await loadGameDataConfig(resolve(values.config));
    const [patch, tool, schema] = await Promise.all([
      queryPatchServer(config.patchServer),
      resolveDatTool(),
      fetchSchemaRecord(config.schemaUrl),
    ]);
    const manifest = await exportGameData({ config, patch, outDir: out, tool, schema });
    console.warn(`game data of patch ${manifest.patch.version} (${tool.name} ${tool.version})`);
    for (const t of manifest.tables) console.warn(`  ${t.name}: ${String(t.count)} rows`);
    for (const m of manifest.missing) console.warn(`  missing: ${m.name} (${m.reason})`);
    return;
  }
  if (command === "item-art") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "game-data": { type: "string" },
        out: { type: "string" },
        config: { type: "string", default: "config/data-pipeline/game-data.json" },
      },
      allowPositionals: true,
      strict: true,
    });
    const [dir] = positionals;
    if (!dir || positionals.length !== 1) fail(USAGE);
    const out = values.out ?? fail("--out is required");
    const gameDataDir = resolve(values["game-data"] ?? fail("--game-data is required"));
    const config = await loadGameDataConfig(resolve(values.config));
    if (config.itemArt === undefined) fail("the game-data config has no itemArt block");
    const snap = await readManifest(dir);
    const bases = await readShard(dir, snap, "itemBases");
    const wanted = new Set(
      Object.entries(bases).map(([id, b]) => {
        const name = (b as { name?: unknown } | null)?.name;
        return typeof name === "string" && name !== "" ? name : id;
      }),
    );
    const manifest = await readGameDataManifest(gameDataDir);
    const [baseItems, visuals, files] = await Promise.all([
      readGameDataTable(gameDataDir, manifest, "BaseItemTypes"),
      readGameDataTable(gameDataDir, manifest, "ItemVisualIdentity"),
      resolveFileRunner(),
    ]);
    const index = await exportItemArt({
      config: config.itemArt,
      patch: { version: manifest.patch.version, url: manifest.patch.url },
      tool: files,
      baseItems,
      visuals,
      wanted,
      outDir: out,
      timeoutMs: config.toolTimeoutMs,
    });
    const have = Object.keys(index.items).length;
    console.warn(
      `item art of patch ${index.patch.version}: ${String(have)} of ${String(wanted.size)} base items`,
    );
    for (const f of index.failed.slice(0, 20)) console.warn(`  no image: ${f.name} (${f.reason})`);
    if (index.failed.length > config.itemArt.maxFailedShare * wanted.size)
      fail(
        `${String(index.failed.length)} of ${String(wanted.size)} base items have no image, more than the allowed share ${String(config.itemArt.maxFailedShare)}`,
      );
    return;
  }
  if (command === "patch-watch") {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        config: { type: "string", default: "config/data-pipeline/watch.json" },
        "game-config": { type: "string", default: "config/data-pipeline/game-data.json" },
        out: { type: "string" },
      },
      strict: true,
    });
    const repo = values.repo ?? fail("--repo is required");
    const watch = watchConfigSchema.parse(
      JSON.parse(await readFile(resolve(values.config), "utf8")),
    );
    const gameConfig = await loadGameDataConfig(resolve(values["game-config"]));
    const token = process.env["GITHUB_TOKEN"];
    const [patch, versions, pob, pinText] = await Promise.all([
      queryPatchServer(gameConfig.patchServer),
      listDataGameVersions(fetch, repo, watch.requestTimeoutSeconds, token),
      latestPobRelease(fetch, watch.pobRepo, watch.requestTimeoutSeconds, token),
      readFile(resolve(watch.pinFile), "utf8"),
    ]);
    const report = decide({
      gamePatch: patch.version,
      dataGameVersions: versions,
      pob: {
        pinnedSha: readPinnedCommit(pinText, watch.pinPattern),
        latestTag: pob.tag,
        latestSha: pob.sha,
      },
    });
    const text = renderReport(report);
    process.stdout.write(`${text}\n`);
    if (values.out !== undefined) await writeFile(values.out, text);
    process.exitCode = exitCodeFor(report);
    return;
  }
  if (command === "catalog-diff") {
    const { positionals } = parseArgs({
      args: rest,
      options: {},
      allowPositionals: true,
      strict: true,
    });
    const [fromDir, toDir] = positionals;
    if (!fromDir || !toDir || positionals.length !== 2) fail(USAGE);
    const diff = await writeCatalogDiff(resolve(fromDir), resolve(toDir));
    console.warn(summarizeCatalogDiff(diff));
    return;
  }
  if (command === "diff") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { out: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    const [fromDir, toDir] = positionals;
    if (!fromDir || !toDir || positionals.length !== 2) fail(USAGE);
    const out = resolve(values.out ?? toDir);
    const diff = await diffSnapshots(fromDir, toDir);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "diff.json"), JSON.stringify(diff, null, 2) + "\n");
    const summary = summarizeDiff(diff);
    await writeFile(join(out, "diff.md"), summary);
    console.warn(summary);
    return;
  }
  fail(USAGE);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
