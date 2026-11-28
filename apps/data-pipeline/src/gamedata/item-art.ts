import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { GameDataConfig } from "./config.ts";
import { TOOL_NAME, resolveDatCli, type GameDataRow } from "./export.ts";
import type { PatchInfo } from "./patch.ts";

/*
 * Item art (F-30): the inventory image of each base item the catalog knows, read in CI from the
 * patch's bundles with the same dat tool as the tables and written as PNG next to an index
 * (name -> file). The art belongs to Grinding Gear Games and is shown with that credit
 * (docs/adr/0007). A file that cannot be converted is listed under `failed`, never replaced.
 */

const execFileAsync = promisify(execFile);

export const ITEM_ART_FORMAT = "astrolabe-item-art/1";
/** Where the images sit inside a data release; `BaseItem.icon` is relative to the release root. */
export const ITEM_ART_RELEASE_DIR = "assets/items";
const INDEX_FILE = "index.json";
const FILES_PER_RUN = 40;

export const itemArtIndexSchema = z
  .object({
    format: z.literal(ITEM_ART_FORMAT),
    patch: z.object({ version: z.string().min(1) }).strict(),
    tool: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
    createdAt: z.iso.datetime(),
    /** base item name -> file path relative to the art directory */
    items: z.record(z.string().min(1), z.string().min(1)),
    /** unique item name -> file path relative to the art directory */
    uniques: z.record(z.string().min(1), z.string().min(1)),
    /** items whose art is not in the patch or could not be converted */
    failed: z.array(
      z
        .object({
          kind: z.enum(["baseItem", "uniqueItem"]),
          name: z.string().min(1),
          reason: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type ItemArtIndex = z.infer<typeof itemArtIndexSchema>;

export interface ArtJob {
  kind: "baseItem" | "uniqueItem";
  name: string;
  /** path of the image inside the bundles */
  source: string;
  /** file name in the output directory */
  file: string;
}

export interface ArtPlan {
  jobs: ArtJob[];
  /** wanted names without art */
  missing: { kind: ArtJob["kind"]; name: string; reason: string }[];
}

const NAME_COLUMN = "Name";
const VISUAL_COLUMN = "ItemVisualIdentity";
const IMAGE_COLUMN = "DDSFile";

function fileNameOf(source: string, prefix: string): string {
  const rest = source.startsWith(prefix) ? source.slice(prefix.length) : source;
  return rest.replace(/\.dds$/i, "").replace(/[^\w-]+/g, "_") + ".png";
}

/**
 * Which images to read: for each wanted base item name the `DDSFile` of its visual identity.
 * Names the tables do not hold, items without a visual identity and images outside the
 * configured path prefix go to `missing` with the reason.
 */
export function planItemArt(
  baseItems: readonly GameDataRow[],
  visuals: readonly GameDataRow[],
  wanted: ReadonlySet<string>,
  config: NonNullable<GameDataConfig["itemArt"]>,
): ArtPlan {
  const byName = new Map<string, GameDataRow>();
  for (const row of baseItems) {
    const name = row[NAME_COLUMN];
    if (typeof name === "string" && wanted.has(name) && !byName.has(name)) byName.set(name, row);
  }
  const jobs: ArtJob[] = [];
  const missing: ArtPlan["missing"] = [];
  for (const name of [...wanted].sort()) {
    const row = byName.get(name);
    if (!row) {
      missing.push({ kind: "baseItem", name, reason: "no such base item in the game data" });
      continue;
    }
    const ref = row[VISUAL_COLUMN];
    const visual = typeof ref === "number" ? visuals[ref] : undefined;
    const source = visual?.[IMAGE_COLUMN];
    if (typeof source !== "string" || source === "") {
      missing.push({
        kind: "baseItem",
        name,
        reason: "the base item has no image in the game data",
      });
      continue;
    }
    if (!source.startsWith(config.pathPrefix) || !source.toLowerCase().endsWith(".dds")) {
      missing.push({
        kind: "baseItem",
        name,
        reason: `image ${source} is outside ${config.pathPrefix}`,
      });
      continue;
    }
    jobs.push({ kind: "baseItem", name, source, file: fileNameOf(source, config.pathPrefix) });
  }
  return { jobs, missing };
}

export interface UniqueArtTables {
  /** `UniqueStashLayout`: a unique's name (`WordsKey`) and its image (`ItemVisualIdentityKey`) */
  layout: readonly GameDataRow[];
  /** `Words`: the names the layout refers to */
  words: readonly GameDataRow[];
  /** titles of the catalog's unique items */
  wanted: ReadonlySet<string>;
}

/**
 * The image of each wanted unique: the layout row whose name is the title, skipping the
 * alternate-art rows. The word table holds the name in `Text` or `Text2`; either may match.
 */
export function planUniqueArt(
  tables: UniqueArtTables,
  visuals: readonly GameDataRow[],
  config: NonNullable<GameDataConfig["itemArt"]>,
): ArtPlan {
  const rows = new Map<string, GameDataRow>();
  for (const row of tables.layout) {
    if (row["IsAlternateArt"] === true) continue;
    const word = typeof row["WordsKey"] === "number" ? tables.words[row["WordsKey"]] : undefined;
    for (const column of ["Text", "Text2"]) {
      const name = word?.[column];
      if (typeof name === "string" && tables.wanted.has(name) && !rows.has(name))
        rows.set(name, row);
    }
  }
  const jobs: ArtJob[] = [];
  const missing: ArtPlan["missing"] = [];
  for (const name of [...tables.wanted].sort()) {
    const row = rows.get(name);
    const ref = row?.["ItemVisualIdentityKey"];
    const source = typeof ref === "number" ? visuals[ref]?.[IMAGE_COLUMN] : undefined;
    if (row === undefined || typeof source !== "string" || source === "") {
      missing.push({
        kind: "uniqueItem",
        name,
        reason: "no image for this unique in the game data",
      });
    } else if (!source.startsWith(config.pathPrefix) || !source.toLowerCase().endsWith(".dds")) {
      missing.push({
        kind: "uniqueItem",
        name,
        reason: `image ${source} is outside ${config.pathPrefix}`,
      });
    } else {
      jobs.push({ kind: "uniqueItem", name, source, file: fileNameOf(source, config.pathPrefix) });
    }
  }
  return { jobs, missing };
}

/** The tool names an exported file after its path, with "/" as "@". */
export function toolOutputName(source: string): string {
  return source.replace(/\//g, "@").replace(/\.dds$/, ".png");
}

/** Runs the tool for a list of bundle paths; `<workDir>/files/<toolOutputName>` per path. */
export type FileRunner = (job: {
  patch: string;
  sources: readonly string[];
  workDir: string;
  timeoutMs: number;
}) => Promise<void>;

export async function resolveFileRunner(): Promise<{ run: FileRunner; version: string }> {
  const { cli, version } = await resolveDatCli();
  const run: FileRunner = async (job) => {
    await writeFile(
      join(job.workDir, "config.json"),
      JSON.stringify({ patch: job.patch, files: job.sources, translations: [], tables: [] }),
    );
    try {
      await execFileAsync(process.execPath, [cli], {
        cwd: job.workDir,
        timeout: job.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (cause) {
      const e = cause as { stdout?: string; stderr?: string; killed?: boolean };
      const tail = `${e.stderr ?? ""}\n${e.stdout ?? ""}`.trim().split("\n").slice(-4).join("\n");
      throw new Error(`${TOOL_NAME} failed on ${String(job.sources.length)} files: ${tail}`, {
        cause,
      });
    }
  };
  return { run, version };
}

export interface ItemArtOptions {
  config: NonNullable<GameDataConfig["itemArt"]>;
  patch: PatchInfo;
  tool: { version: string; run: FileRunner };
  baseItems: readonly GameDataRow[];
  visuals: readonly GameDataRow[];
  wanted: ReadonlySet<string>;
  uniques?: UniqueArtTables;
  outDir: string;
  timeoutMs: number;
  now?: Date;
}

/**
 * Reads the planned images in runs of a few dozen. The tool stops at the first file it cannot
 * convert, so a failing run is halved until the single files that fail are known; those are
 * reported, the rest is kept.
 */
async function readImages(
  sources: readonly string[],
  opts: ItemArtOptions,
  workDir: string,
  failed: Map<string, string>,
): Promise<void> {
  if (sources.length === 0) return;
  try {
    await opts.tool.run({
      patch: opts.patch.version,
      sources,
      workDir,
      timeoutMs: opts.timeoutMs,
    });
  } catch (cause) {
    if (sources.length === 1) {
      failed.set(sources[0] as string, cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const half = Math.ceil(sources.length / 2);
    await readImages(sources.slice(0, half), opts, workDir, failed);
    await readImages(sources.slice(half), opts, workDir, failed);
  }
}

export async function exportItemArt(opts: ItemArtOptions): Promise<ItemArtIndex> {
  const basePlan = planItemArt(opts.baseItems, opts.visuals, opts.wanted, opts.config);
  const uniquePlan: ArtPlan = opts.uniques
    ? planUniqueArt(opts.uniques, opts.visuals, opts.config)
    : { jobs: [], missing: [] };
  const plan: ArtPlan = {
    jobs: [...basePlan.jobs, ...uniquePlan.jobs],
    missing: [...basePlan.missing, ...uniquePlan.missing],
  };
  const out = resolve(opts.outDir);
  const sources = [...new Set(plan.jobs.map((j) => j.source))];
  const workDir = await mkdtemp(join(tmpdir(), "astrolabe-itemart-"));
  const failed = new Map<string, string>();
  const done = new Set<string>();
  try {
    await mkdir(out, { recursive: true });
    for (let i = 0; i < sources.length; i += FILES_PER_RUN) {
      const batch = sources.slice(i, i + FILES_PER_RUN);
      const before = new Set(failed.keys());
      await readImages(batch, opts, workDir, failed);
      for (const source of batch) {
        if (before.has(source) || failed.has(source)) continue;
        const file = (plan.jobs.find((j) => j.source === source) as ArtJob).file;
        try {
          await copyFile(join(workDir, "files", toolOutputName(source)), join(out, file));
        } catch (cause) {
          failed.set(source, `no converted image: ${(cause as Error).message}`);
          continue;
        }
        done.add(source);
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  const items: Record<string, string> = {};
  const uniques: Record<string, string> = {};
  const failures = [...plan.missing];
  for (const job of plan.jobs) {
    const reason = failed.get(job.source);
    if (reason !== undefined) failures.push({ kind: job.kind, name: job.name, reason });
    else if (done.has(job.source)) (job.kind === "baseItem" ? items : uniques)[job.name] = job.file;
  }
  const index = itemArtIndexSchema.parse({
    format: ITEM_ART_FORMAT,
    patch: { version: opts.patch.version },
    tool: { name: TOOL_NAME, version: opts.tool.version },
    createdAt: (opts.now ?? new Date()).toISOString(),
    items,
    uniques,
    failed: failures,
  });
  await writeFile(join(out, INDEX_FILE), JSON.stringify(index, null, 2) + "\n");
  return index;
}

export async function readItemArtIndex(dir: string): Promise<ItemArtIndex> {
  const path = join(dir, INDEX_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(`cannot read item-art index ${path}`, { cause });
  }
  const parsed = itemArtIndexSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`invalid item-art index ${path}: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  return parsed.data;
}
