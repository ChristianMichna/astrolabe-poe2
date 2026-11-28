import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * config/data-pipeline/game-data.json: which tables of the game's data files
 * are read in CI, and from which update server. Data, not code: a table the
 * crafting data needs next patch is a config change.
 */
export const gameDataConfigSchema = z
  .object({
    $comment: z.string().optional(),
    patchServer: z
      .object({
        host: z.string().min(1),
        port: z.number().int().positive(),
        /** bytes sent to ask for the current patch */
        handshake: z.array(z.number().int().min(0).max(255)).min(1),
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
    schemaUrl: z.url(),
    /** translation to export, as named by the dat tool */
    language: z.string().min(1),
    toolTimeoutMs: z.number().int().positive(),
    /** Item art read next to the tables (F-30); absent: none. */
    itemArt: z
      .object({
        /** only images below this path of the bundles are taken */
        pathPrefix: z.string().min(1),
        /** the step fails when more than this share of the items has no image */
        maxFailedShare: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    tables: z
      .array(
        z
          .object({
            name: z.string().regex(/^\w+$/, "table name must be an identifier"),
            columns: z.array(z.string().min(1)).min(1),
            /** false: the table may be absent from a patch (recorded, never filled in) */
            required: z.boolean().default(true),
          })
          .strict(),
      )
      .min(1)
      .refine(
        (tables) => new Set(tables.map((t) => t.name)).size === tables.length,
        "table names must be unique",
      ),
  })
  .strict();

export type GameDataConfig = z.infer<typeof gameDataConfigSchema>;

export async function loadGameDataConfig(path: string): Promise<GameDataConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(`cannot read game-data config ${path}`, { cause });
  }
  const parsed = gameDataConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`invalid game-data config ${path}: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  return parsed.data;
}
