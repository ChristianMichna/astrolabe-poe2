import { z } from "zod";
import { ResearchSection } from "@astrolabe/contracts/guide";

/** Settings of the research step (config/agents/research.json, ADR-0006). */
export const ResearchConfig = z
  .object({
    version: z.string().min(1),
    /** Off: guides are written without research, as before. */
    enabled: z.boolean(),
    /** Sections that get a research task; the guide sections S9 writes. */
    sections: z.array(ResearchSection).min(1),
    findings: z
      .object({ min: z.int().nonnegative(), max: z.int().positive() })
      .refine((f) => f.min <= f.max, { message: "findings.min is above findings.max" }),
    /** A source link must point to one of these hosts or a subdomain of one. */
    hostAllowlist: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).min(1),
  })
  .refine((c) => new Set(c.sections).size === c.sections.length, {
    message: "research sections are not unique",
    path: ["sections"],
  });
export type ResearchConfig = z.infer<typeof ResearchConfig>;

/** Whether a source link may be used: https and a host on the allowlist (or below one). */
export function hostAllowed(url: string, allowlist: readonly string[]): boolean {
  const m = /^https:\/\/([^\s/@?#:]+)(?:[/?#]|$)/i.exec(url);
  if (m === null || m[1] === undefined) return false;
  const host = m[1].toLowerCase();
  return allowlist.some((h) => host === h || host.endsWith(`.${h}`));
}
