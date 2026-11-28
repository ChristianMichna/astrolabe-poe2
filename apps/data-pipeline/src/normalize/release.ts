import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CATALOG_SCHEMA_VERSION,
  CatalogManifest,
  CatalogShard,
} from "@astrolabe/contracts/catalog";
import { z } from "zod";
import type { Json } from "../json.ts";
import { ITEM_ART_RELEASE_DIR, readItemArtIndex } from "../gamedata/item-art.ts";
import { prepareOutDir } from "../out-dir.ts";
import { readManifest, readShard, sha256 } from "../snapshot/snapshot.ts";
import {
  normalizeCatalog,
  type CatalogEntities,
  type Finding,
  type NormalizeConfig,
  type NormalizeSummary,
} from "./catalog.ts";
import { currencyBaseItems } from "./currency.ts";
import { currencyActions } from "./currency-actions.ts";
import { essenceActions } from "./essence.ts";
import { applyGameIds } from "./game-ids.ts";
import { buildReleaseFacts } from "./release-facts.ts";
import { StatMatcher } from "./stat-matcher.ts";
import { validateCatalog } from "./validate.ts";

/** Raw kinds the normalisation reads from a snapshot. */
const RAW_KINDS = [
  "itemBases",
  "mods",
  "uniques",
  "gems",
  "gemLevels",
  "skills",
  "passiveTree",
  "statDescriptions",
  "questRewards",
  "itemSlots",
  "essences",
] as const;

/** Written first, so a directory holding it is a previous catalog output. */
const FINDINGS_FILE = "findings.json";

export interface CatalogBuildResult {
  manifest: CatalogManifest;
  /** non-blocking: data PoB does not provide, dropped dangling references … */
  warnings: Finding[];
  summary: NormalizeSummary;
}

/** `<id>+r<n>` → n; the release id format is checked by the contract. */
export function pipelineRevisionOf(releaseId: string): number {
  const m = /\+r(\d+)$/.exec(releaseId);
  if (!m?.[1]) throw new Error(`release id ${releaseId} has no +r<revision> suffix`);
  return Number(m[1]);
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const res = schema.safeParse(value);
  if (!res.success)
    throw new Error(`${what} violates the contract: ${z.prettifyError(res.error)}`, {
      cause: res.error,
    });
  return res.data;
}

/**
 * Builds the catalog files of a data release from a raw snapshot:
 * `<out>/<kind>.json` (CatalogShard), `<out>/manifest.json` (CatalogManifest)
 * and `<out>/findings.json`. Any error (missing required source value,
 * contract violation, broken reference) aborts before a shard or manifest is
 * written; findings.json is written in every case.
 */
export async function buildCatalog(
  snapshotDir: string,
  outDir: string,
  cfg: { config: NormalizeConfig; sha256: string },
  now: Date = new Date(),
  extra: { gameDataDir?: string; itemArtDir?: string } = {},
): Promise<CatalogBuildResult> {
  const snap = await readManifest(snapshotDir);
  const pipelineRevision = pipelineRevisionOf(snap.releaseId);
  const raw: Record<string, Record<string, Json>> = {};
  for (const kind of RAW_KINDS) raw[kind] = await readShard(snapshotDir, snap, kind);
  const matcher = new StatMatcher(raw.statDescriptions ?? {});
  const norm = normalizeCatalog(raw, { mod: matcher, passiveNode: matcher }, cfg.config);
  const questRewards = raw.questRewards;
  if (!questRewards) throw new Error(`snapshot ${snap.releaseId} has no questRewards shard`);
  const itemSlots = raw.itemSlots;
  if (!itemSlots) throw new Error(`snapshot ${snap.releaseId} has no itemSlots shard`);
  const {
    facts,
    findings: factFindings,
    errors: factErrors,
  } = await buildReleaseFacts({
    config: cfg.config.releaseFacts,
    questRewards,
    itemSlots,
    known: {
      itemClasses: new Set(norm.entities.baseItem.map((b) => String(b.itemClass))),
      baseClassOf: new Map(norm.entities.baseItem.map((b) => [String(b.id), String(b.itemClass)])),
    },
    vocabulary: new Set(
      norm.entities.mod.flatMap((m) =>
        Array.isArray(m.tags) ? m.tags.map((t: unknown) => String(t)) : [],
      ),
    ),
    generationTypes: new Set(norm.entities.mod.map((m) => String(m.generationType))),
    ...(extra.gameDataDir === undefined ? {} : { gameDataDir: extra.gameDataDir }),
  });
  const currencyFindings: Finding[] = [];
  const currencyErrors: Finding[] = [];
  if (extra.gameDataDir !== undefined) {
    const cur = await currencyBaseItems(
      extra.gameDataDir,
      cfg.config.currency,
      new Set(norm.entities.baseItem.map((b) => String(b.id))),
    );
    norm.entities.baseItem.push(...(cur.baseItems as typeof norm.entities.baseItem));
    currencyFindings.push(...cur.findings);
    currencyErrors.push(...cur.errors);
  } else {
    currencyFindings.push({
      kind: "currency",
      id: "all",
      message: "no game data given, currency items are left out",
    });
  }
  const itemArtFindings: Finding[] = [];
  const artFiles: string[] = [];
  if (extra.itemArtDir === undefined) {
    itemArtFindings.push({
      kind: "itemArt",
      id: "all",
      message: "no item art given, base items have no icon",
    });
  } else {
    const art = await readItemArtIndex(extra.itemArtDir);
    norm.entities.baseItem = norm.entities.baseItem.map((b) => {
      const file = art.items[String(b.name)];
      if (file === undefined) return b;
      artFiles.push(file);
      return { ...b, icon: `${ITEM_ART_RELEASE_DIR}/${file}` };
    });
    const withIcon = artFiles.length;
    norm.entities.uniqueItem = norm.entities.uniqueItem.map((u) => {
      const file = art.uniques[String(u.name)];
      if (file === undefined) return u;
      artFiles.push(file);
      return { ...u, icon: `${ITEM_ART_RELEASE_DIR}/${file}` };
    });
    itemArtFindings.push({
      kind: "itemArt",
      id: "all",
      message: `${String(withIcon)} of ${String(norm.entities.baseItem.length)} base items and ${String(artFiles.length - withIcon)} of ${String(norm.entities.uniqueItem.length)} uniques have an icon (${String(art.failed.length)} listed in the item-art index)`,
    });
  }
  const essenceFindings: Finding[] = [];
  let currencyActionSummary: NormalizeSummary["currencyActions"];
  if (extra.gameDataDir === undefined)
    essenceFindings.push({
      kind: "essence",
      id: "all",
      message: "no game data given, essence crafting actions are left out",
    });
  else {
    const rawEssences = raw.essences;
    if (!rawEssences) throw new Error(`snapshot ${snap.releaseId} has no essences shard`);
    const res = essenceActions(
      rawEssences,
      {
        baseItemIds: new Set(norm.entities.baseItem.map((b) => String(b.id))),
        itemClasses: new Set(norm.entities.baseItem.map((b) => String(b.itemClass))),
        modIds: new Set(norm.entities.mod.map((m) => String(m.id))),
      },
      cfg.config.essence,
    );
    const rules = await currencyActions({
      gameDataDir: extra.gameDataDir,
      config: cfg.config.currencyActions,
      rarities: facts.rarities,
      baseItemIds: new Set(norm.entities.baseItem.map((b) => String(b.id))),
      modGenerationTypes: new Set(norm.entities.mod.map((m) => String(m.generationType))),
      modDomains: new Set(norm.entities.mod.flatMap((m) => (m.domains as string[]) ?? [])),
      essenceActions: res.actions,
    });
    norm.entities.craftingAction.push(...rules.essenceActions, ...rules.actions);
    essenceFindings.push(...res.findings, ...rules.findings);
    currencyActionSummary = rules.summary;
  }
  const gameIdFindings: Finding[] = [];
  const gameIdErrors: Finding[] = [];
  let gameIdSummary: NormalizeSummary["gameIds"];
  if (extra.gameDataDir === undefined) {
    gameIdFindings.push({
      kind: "gameId",
      id: "all",
      message: "no game data given, game ids of passives and slots are left out",
    });
  } else if (!facts.itemSlots) {
    gameIdErrors.push({
      kind: "gameId",
      id: "slots",
      message: "the release has no item slots, game ids cannot be set",
    });
  } else {
    const ids = await applyGameIds({
      gameDataDir: extra.gameDataDir,
      config: cfg.config.gameIds,
      passiveNodes: norm.entities.passiveNode as { name: string; pobNodeId?: number }[],
      slots: facts.itemSlots.slots,
    });
    norm.entities.passiveNode = norm.entities.passiveNode.map((n, i) => {
      const gameId = ids.passiveGameIds[i];
      return gameId === undefined ? n : { ...n, gameId };
    });
    facts.itemSlots = { ...facts.itemSlots, slots: ids.slots };
    facts.gameIds = { origin: "game-data" };
    gameIdFindings.push(...ids.findings);
    gameIdErrors.push(...ids.errors);
    gameIdSummary = ids.summary;
  }
  const validation = validateCatalog(norm.entities);
  const errors = [
    ...norm.errors,
    ...validation.errors,
    ...factErrors,
    ...currencyErrors,
    ...gameIdErrors,
  ];

  const out = resolve(outDir);
  await prepareOutDir(
    out,
    [
      { what: "the snapshot", dir: snapshotDir },
      { what: "the working directory", dir: process.cwd() },
    ],
    FINDINGS_FILE,
  );
  await writeFile(
    join(out, FINDINGS_FILE),
    JSON.stringify(
      {
        releaseId: snap.releaseId,
        summary: {
          ...norm.summary,
          ...(gameIdSummary ? { gameIds: gameIdSummary } : {}),
          ...(currencyActionSummary ? { currencyActions: currencyActionSummary } : {}),
        },
        errors,
        warnings: [
          ...norm.warnings,
          ...factFindings,
          ...currencyFindings,
          ...essenceFindings,
          ...gameIdFindings,
          ...itemArtFindings,
        ],
        unresolved: norm.unresolved,
        hiddenStatGroups: norm.hiddenStatGroups,
      },
      null,
      2,
    ) + "\n",
  );
  if (errors.length > 0) {
    const sample = errors
      .slice(0, 10)
      .map((e) => `  ${e.kind} ${e.id}: ${e.message}`)
      .join("\n");
    throw new Error(
      `catalog for ${snap.releaseId} has ${String(errors.length)} errors (see ${FINDINGS_FILE}):\n${sample}`,
    );
  }

  if (extra.itemArtDir !== undefined && artFiles.length > 0) {
    const dir = join(out, ITEM_ART_RELEASE_DIR);
    await mkdir(dir, { recursive: true });
    for (const file of new Set(artFiles))
      await copyFile(join(resolve(extra.itemArtDir), file), join(dir, file));
  }

  const shards: CatalogManifest["shards"] = [];
  for (const kind of Object.keys(validation.entities) as (keyof CatalogEntities)[]) {
    const shard = parseOrThrow(
      CatalogShard,
      {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        dataReleaseId: snap.releaseId,
        kind,
        entities: validation.entities[kind],
      },
      `shard ${kind}`,
    );
    const text = JSON.stringify(shard) + "\n";
    const path = `${kind}.json`;
    await writeFile(join(out, path), text);
    shards.push({ kind, path, sha256: sha256(text), count: shard.entities.length });
  }

  const sourceHashes: Record<string, string> = { ...snap.sourceHashes };
  for (const s of snap.shards) sourceHashes[`raw/${s.kind}`] = s.sha256;
  sourceHashes["normalize.json"] = cfg.sha256;

  const manifest = parseOrThrow(
    CatalogManifest,
    {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      release: {
        id: snap.releaseId,
        gameVersion: snap.gameVersion,
        pobVersion: snap.pobVersion,
        pipelineRevision,
        sourceHashes,
        ...facts,
        createdAt: now.toISOString(),
      },
      shards,
    },
    "catalog manifest",
  );
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return {
    manifest,
    warnings: [
      ...norm.warnings,
      ...factFindings,
      ...currencyFindings,
      ...essenceFindings,
      ...gameIdFindings,
      ...itemArtFindings,
    ],
    summary: {
      ...norm.summary,
      ...(gameIdSummary ? { gameIds: gameIdSummary } : {}),
      ...(currencyActionSummary ? { currencyActions: currencyActionSummary } : {}),
    },
  };
}
