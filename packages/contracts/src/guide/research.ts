import { z } from "zod";
import { EntityRef } from "../common/ids.js";
import { IsoDateTime } from "../common/version.js";
import { ResearchFindingId, RichText } from "../build/text.js";

/*
 * Research findings (ADR-0006): what Claude found out about the build from outside the game data
 * (patch notes, wikis, community guides), kept with its source. A finding is a short paraphrase,
 * never copied text, and it never carries a game number: numbers in a claim are `calc` segments
 * like everywhere else, and where a finding contradicts a measurement the measurement wins.
 * Guide text cites a finding with a `source` segment.
 */

/** The part of the guide a finding is for. */
export const ResearchSection = z.enum([
  "summary",
  "mechanics",
  "progression",
  "gear",
  "crafting",
  "playstyle",
  "atlas",
  "variants",
  "faq",
]);
export type ResearchSection = z.infer<typeof ResearchSection>;

/**
 * https, a plain host name (no credentials, port or brackets), then an optional path, query or
 * fragment without whitespace, control characters or backslashes. `URL` is not available to this
 * package; the desktop shell re-checks every link with it before opening, against the host list.
 */
const HTTPS_LINK = /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?:[/?#][^\s\\]*)?$/i;

/** No C0 or C1 control characters (whitespace is already excluded by the pattern). */
const hasNoControlCharacters = (value: string): boolean =>
  [...value].every((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code > 0x1f && (code < 0x7f || code > 0x9f);
  });

export const ResearchSource = z.object({
  /** https only; the hosts that are allowed are set in config/agents/research.json. */
  url: z
    .string()
    .max(2048)
    .regex(HTTPS_LINK, "sources must be https links without credentials, port or backslashes")
    .refine(hasNoControlCharacters, "sources must not contain control characters"),
  title: z.string().min(1).max(200),
  retrievedAt: IsoDateTime,
});
export type ResearchSource = z.infer<typeof ResearchSource>;

export const ResearchFinding = z.object({
  id: ResearchFindingId,
  section: ResearchSection,
  /** What the finding is about, in a few words. */
  topic: z.string().min(3).max(120),
  /** The finding in the researcher's own words. */
  claim: RichText,
  source: ResearchSource,
  /** Catalog entities the claim is about; every one must exist in the data release (G1). */
  entities: z.array(EntityRef).default([]),
});
export type ResearchFinding = z.infer<typeof ResearchFinding>;

/** The findings of one guide: ids are unique, so a citation always means one finding. */
export const ResearchFindings = z
  .array(ResearchFinding)
  .refine((list) => new Set(list.map((f) => f.id)).size === list.length, {
    message: "research finding ids are not unique",
  });
