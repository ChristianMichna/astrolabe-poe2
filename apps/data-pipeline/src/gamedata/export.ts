import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { prepareOutDir } from "../out-dir.ts";
import { sha256 } from "../snapshot/snapshot.ts";
import type { GameDataConfig } from "./config.ts";
import type { PatchInfo } from "./patch.ts";

const execFileAsync = promisify(execFile);

export const GAME_DATA_FORMAT = "astrolabe-game-data/1";
const MANIFEST_FILE = "manifest.json";
/** Written first, so an interrupted export is still recognised as an earlier output; other stages also write a manifest.json. */
const MARKER_FILE = "game-data.marker";
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);

export const gameDataManifestSchema = z
  .object({
    format: z.literal(GAME_DATA_FORMAT),
    patch: z.object({ version: z.string().min(1), url: z.string().min(1) }).strict(),
    /** the program that read the game's data files, with the version used */
    tool: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
    /** table layouts come from this community schema; its hash pins what was used */
    schema: z.object({ url: z.string().min(1), sha256: SHA256 }).strict(),
    language: z.string().min(1),
    createdAt: z.iso.datetime(),
    tables: z.array(
      z
        .object({
          name: z.string().min(1),
          path: z.string().min(1),
          sha256: SHA256,
          count: z.number().int().positive(),
          columns: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
    /** optional tables this patch does not have */
    missing: z.array(z.object({ name: z.string().min(1), reason: z.string().min(1) }).strict()),
  })
  .strict();
export type GameDataManifest = z.infer<typeof gameDataManifestSchema>;

/** A row as exported: `_index` plus the configured columns. */
export type GameDataRow = Record<string, unknown> & { _index: number };

const rowsSchema = z.array(z.looseObject({ _index: z.number().int().nonnegative() })).min(1);

/** The tool reports a table that the patch's file index does not contain. */
export class TableMissingError extends Error {}

export interface TableJob {
  table: GameDataConfig["tables"][number];
  patch: string;
  language: string;
  /** reused across tables: holds the tool's bundle cache */
  workDir: string;
  timeoutMs: number;
}

/** Runs the dat tool for one table; the result is `<workDir>/tables/<language>/<name>.json`. */
export type TableRunner = (job: TableJob) => Promise<void>;

export interface DatTool {
  name: string;
  version: string;
  run: TableRunner;
}

export const TOOL_NAME = "pathofexile-dat";

/** Where the pinned dat tool (dependency) lives: its command line entry and version. */
export async function resolveDatCli(): Promise<{ cli: string; version: string }> {
  let entry: string;
  try {
    entry = import.meta.resolve(`${TOOL_NAME}/bundles.js`);
  } catch (cause) {
    throw new Error(`${TOOL_NAME} is not installed (pnpm install)`, { cause });
  }
  const cli = fileURLToPath(new URL("./cli/run.js", entry));
  const pkgPath = fileURLToPath(new URL("../package.json", entry));
  const pkg = z
    .object({ version: z.string().min(1) })
    .parse(JSON.parse(await readFile(pkgPath, "utf8")));
  return { cli, version: pkg.version };
}

/** The pinned dat tool (dependency), run as a child process with an argument array. */
export async function resolveDatTool(): Promise<DatTool> {
  const { cli, version } = await resolveDatCli();
  const run: TableRunner = async (job) => {
    await writeFile(
      join(job.workDir, "config.json"),
      JSON.stringify({
        patch: job.patch,
        translations: [job.language],
        tables: [{ name: job.table.name, columns: job.table.columns }],
      }),
    );
    try {
      await execFileAsync(process.execPath, [cli], {
        cwd: job.workDir,
        timeout: job.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (cause) {
      const e = cause as { stdout?: string; stderr?: string; killed?: boolean };
      const output = `${e.stderr ?? ""}\n${e.stdout ?? ""}`.trim();
      if (output.includes("NoFileInfoError"))
        throw new TableMissingError(`table ${job.table.name} is not in patch ${job.patch}`, {
          cause,
        });
      const tail = output.split("\n").slice(-8).join("\n");
      throw new Error(
        `${TOOL_NAME} failed on table ${job.table.name}${e.killed ? " (timed out)" : ""}:\n${tail}`,
        { cause },
      );
    }
  };
  return { name: TOOL_NAME, version, run };
}

export interface SchemaRecord {
  url: string;
  sha256: string;
}

/** Hash of the dat schema the tool will use (it reads the same url itself). */
export async function fetchSchemaRecord(url: string): Promise<SchemaRecord> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": "astrolabe-data-pipeline" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (cause) {
    throw new Error(`cannot fetch dat schema ${url}`, { cause });
  }
  if (!res.ok) throw new Error(`dat schema ${url} answered ${String(res.status)}`);
  return { url, sha256: sha256(Buffer.from(await res.arrayBuffer())) };
}

export interface ExportOptions {
  config: GameDataConfig;
  patch: PatchInfo;
  outDir: string;
  tool: DatTool;
  schema: SchemaRecord;
  now?: Date;
}

/**
 * Reads the configured tables of one patch and writes them to
 * `<out>/<Table>.json` plus `<out>/manifest.json`. A missing required table,
 * an unreadable table or rows that do not look like the configured columns
 * fail the export; an optional table that the patch lacks is listed under
 * `missing`.
 */
export async function exportGameData(opts: ExportOptions): Promise<GameDataManifest> {
  const { config, patch, tool } = opts;
  const out = resolve(opts.outDir);
  await prepareOutDir(out, [{ what: "the working directory", dir: process.cwd() }], MARKER_FILE);
  await writeFile(join(out, MARKER_FILE), `${GAME_DATA_FORMAT}\n`);
  const workDir = await mkdtemp(join(tmpdir(), "astrolabe-gamedata-"));
  const tables: GameDataManifest["tables"] = [];
  const missing: GameDataManifest["missing"] = [];
  try {
    for (const table of config.tables) {
      try {
        await tool.run({
          table,
          patch: patch.version,
          language: config.language,
          workDir,
          timeoutMs: config.toolTimeoutMs,
        });
      } catch (cause) {
        if (cause instanceof TableMissingError && !table.required) {
          missing.push({ name: table.name, reason: cause.message });
          continue;
        }
        throw cause;
      }
      const exported = join(workDir, "tables", config.language, `${table.name}.json`);
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(exported, "utf8"));
      } catch (cause) {
        throw new Error(`table ${table.name}: no readable export at ${exported}`, { cause });
      }
      const parsed = rowsSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error(
          `table ${table.name}: unexpected export: ${z.prettifyError(parsed.error)}`,
          {
            cause: parsed.error,
          },
        );
      const rows = parsed.data;
      rows.forEach((row, i) => {
        if (row._index !== i)
          throw new Error(`table ${table.name}: row ${String(i)} has _index ${String(row._index)}`);
      });
      // a schema that does not match the patch shows up as missing columns
      const first = rows[0] as Record<string, unknown>;
      for (const column of table.columns) {
        if (!(column in first))
          throw new Error(`table ${table.name}: exported rows have no column ${column}`);
      }
      const text = JSON.stringify(rows) + "\n";
      const path = `${table.name}.json`;
      await writeFile(join(out, path), text);
      tables.push({
        name: table.name,
        path,
        sha256: sha256(text),
        count: rows.length,
        columns: table.columns,
      });
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const manifest = gameDataManifestSchema.parse({
    format: GAME_DATA_FORMAT,
    patch: { version: patch.version, url: patch.url },
    tool: { name: tool.name, version: tool.version },
    schema: opts.schema,
    language: config.language,
    createdAt: (opts.now ?? new Date()).toISOString(),
    tables,
    missing,
  });
  await writeFile(join(out, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function readGameDataManifest(dir: string): Promise<GameDataManifest> {
  const path = join(dir, MANIFEST_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(`cannot read game-data manifest ${path}`, { cause });
  }
  const parsed = gameDataManifestSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`invalid game-data manifest ${path}: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  return parsed.data;
}

/** Reads one table, checking hash and row count against the manifest. */
export async function readGameDataTable(
  dir: string,
  manifest: GameDataManifest,
  name: string,
): Promise<GameDataRow[]> {
  const entry = manifest.tables.find((t) => t.name === name);
  if (!entry) {
    const gone = manifest.missing.find((m) => m.name === name);
    throw new Error(
      gone
        ? `game-data table ${name} is missing in patch ${manifest.patch.version}`
        : `game-data has no table ${name}`,
    );
  }
  const path = join(dir, entry.path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read game-data table ${path}`, { cause });
  }
  if (sha256(text) !== entry.sha256)
    throw new Error(`game-data table ${path} does not match its manifest hash`);
  const rows = rowsSchema.parse(JSON.parse(text)) as GameDataRow[];
  if (rows.length !== entry.count)
    throw new Error(
      `game-data table ${path} has ${String(rows.length)} rows, manifest says ${String(entry.count)}`,
    );
  return rows;
}
