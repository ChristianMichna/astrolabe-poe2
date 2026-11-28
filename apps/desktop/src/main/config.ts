import { readFile } from "node:fs/promises";
import { z } from "zod";

/** setInterval overflows beyond 2^31 ms (about 596 hours). */
const MAX_INTERVAL_HOURS = 500;

const Scheme = z.string().regex(/^[a-z][a-z0-9+.-]*:$/);

export const DesktopConfig = z.object({
  version: z.string().min(1),
  port: z.int().min(1024).max(65_535),
  window: z.object({
    width: z.int().positive(),
    height: z.int().positive(),
    minWidth: z.int().positive(),
    minHeight: z.int().positive(),
  }),
  claude: z
    .object({
      desktopUrl: z.string().min(1),
      allowedSchemes: z.array(Scheme).min(1),
      /** Contains `{code}` exactly once. */
      startSentence: z.string().refine((s) => s.split("{code}").length === 2, {
        message: "startSentence must contain {code} exactly once",
      }),
    })
    .refine((c) => URL.canParse(c.desktopUrl), { message: "desktopUrl is not a URL" })
    .refine((c) => c.allowedSchemes.includes(new URL(c.desktopUrl).protocol), {
      message: "desktopUrl uses a scheme that is not in allowedSchemes",
    }),
  update: z.object({
    enabled: z.boolean(),
    firstCheckDelaySeconds: z.int().nonnegative(),
    checkIntervalHours: z.number().positive().max(MAX_INTERVAL_HOURS),
  }),
  /** Market prices from poe.ninja for crafting costs and start costs (F-14). */
  economy: z.object({ enabled: z.boolean() }),
  /** Links in guide text (research citations, ADR-0006) open in the browser only for these hosts. */
  citations: z.object({ allowedHosts: z.array(z.string().min(1)).min(1) }),
  /** New game patches arrive as data releases from GitHub Releases (F-01). */
  dataSync: z.object({
    enabled: z.boolean(),
    /** "owner/name" that publishes the data releases. */
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    includePrereleases: z.boolean(),
    firstCheckDelaySeconds: z.int().nonnegative(),
    checkIntervalHours: z.number().positive().max(MAX_INTERVAL_HOURS),
    /** A hung request ends as an error after this long (list) or this long for a whole install. */
    listTimeoutSeconds: z.int().positive(),
    installTimeoutMinutes: z.int().positive(),
    /** Hosts a download may be redirected to (https only). */
    allowedRedirectHosts: z.array(z.string().min(1)).min(1),
    maxDownloadMegabytes: z.int().positive(),
    maxUnpackedMegabytes: z.int().positive(),
    maxChecksumBytes: z.int().positive(),
    maxDecompressionRatio: z.int().positive(),
    maxEntries: z.int().positive(),
    /** Temporary folders of interrupted installs older than this are removed at start. */
    leftoverMinAgeMinutes: z.int().nonnegative(),
  }),
});
export type DesktopConfig = z.infer<typeof DesktopConfig>;

export async function loadDesktopConfig(path: string): Promise<DesktopConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read desktop config ${path}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Desktop config ${path} is not valid JSON`, { cause: error });
  }
  const parsed = DesktopConfig.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Desktop config ${path} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
