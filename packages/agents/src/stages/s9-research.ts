import { z } from "zod";
import { ResearchFinding, ResearchSection } from "@astrolabe/contracts/guide";
import type { ArchetypeCandidate, Finding, RichText } from "@astrolabe/contracts/build";
import type { EntityRef, JsonValue } from "@astrolabe/contracts/common";
import type { StageConfig } from "../config.js";
import { defineTask, type AnyTaskSpec, type PipelineContext } from "../pipeline.js";
import { S9_RESEARCH, S9_RESEARCH_FOCUS } from "../prompts.js";
import { hostAllowed, type ResearchConfig } from "../research-config.js";
import { requestContext } from "./context.js";

/*
 * S9 research (ADR-0006): before a section of the guide is written, one task per researched
 * section collects findings from outside sources. A finding is a short paraphrase with its link and
 * catalog entities; numbers in it go through the same linter as all other text, and the host of the
 * link must be on the allowlist. Claude researches with the web tools of the player's own client;
 * the app fetches nothing. Without web access the answer says so and the guide is written without
 * research, which the validation report shows.
 */

export const researchKey = (section: ResearchSection): string => `S9.research-${section}`;

export const ResearchAnswer = z.object({
  /** False when the client has no web tools; then there are no findings. */
  webAccess: z.boolean(),
  findings: z.array(ResearchFinding),
});
export type ResearchAnswer = z.infer<typeof ResearchAnswer>;

/** Sections that get a research task, in guide order; none when research is off. */
export function researchSections(config: StageConfig): ResearchSection[] {
  const research = config.s9?.research;
  if (research === undefined || !research.enabled) return [];
  return ResearchSection.options.filter((s) => research.sections.includes(s));
}

/** True when the section gets a research task. */
export function isResearched(
  config: StageConfig,
  section: ResearchSection,
): section is Exclude<ResearchSection, "progression" | "gear" | "crafting"> {
  return researchSections(config).includes(section);
}

/** The accepted answer of a section's research task, if it is done and readable. */
export function researchAnswer(
  ctx: PipelineContext,
  section: ResearchSection,
): ResearchAnswer | undefined {
  const parsed = ResearchAnswer.safeParse(ctx.result(researchKey(section)));
  return parsed.success ? parsed.data : undefined;
}

/** All findings accepted so far, in guide order. */
export function allFindings(ctx: PipelineContext): ResearchFinding[] {
  return ResearchSection.options.flatMap((s) => researchAnswer(ctx, s)?.findings ?? []);
}

/** What the writing task of a section gets to see; undefined when the section is not researched. */
export function researchContext(
  ctx: PipelineContext,
  section: ResearchSection,
): JsonValue | undefined {
  const answer = researchAnswer(ctx, section);
  if (answer === undefined) return undefined;
  return {
    available: answer.webAccess,
    findings: answer.findings.map((f) => ({
      id: f.id,
      topic: f.topic,
      claim: JSON.parse(JSON.stringify(f.claim)) as JsonValue,
      source: { title: f.source.title, url: f.source.url },
    })),
  };
}

const finding = (code: string, message: string, path?: string): Finding => ({
  gate: "G7",
  severity: "error",
  code,
  message,
  ...(path === undefined ? {} : { path }),
});

/** The checks of one research answer against the settings; a shortfall goes back to the same task. */
export function researchCheck(
  section: ResearchSection,
  research: ResearchConfig,
  taken: ReadonlySet<string>,
) {
  return (answer: ResearchAnswer): Finding[] => {
    if (!answer.webAccess) {
      return answer.findings.length === 0
        ? []
        : [
            finding(
              "research_without_web",
              "With webAccess false there are no findings; either you researched (webAccess true) or you did not.",
              "/findings",
            ),
          ];
    }
    const out: Finding[] = answer.findings.flatMap((f, i) =>
      /\d/.test(f.topic)
        ? [
            finding(
              "research_topic_number",
              `The topic of ${f.id} contains a digit; name the subject in words (numbers only by reference).`,
              `/findings/${String(i)}/topic`,
            ),
          ]
        : [],
    );
    const { min, max } = research.findings;
    if (answer.findings.length < min || answer.findings.length > max) {
      out.push(
        finding(
          "research_count",
          `Report between ${String(min)} and ${String(max)} findings for ${section}; this answer has ${String(answer.findings.length)}.`,
          "/findings",
        ),
      );
    }
    const seen = new Set(taken);
    answer.findings.forEach((f, i) => {
      if (f.section !== section) {
        out.push(
          finding(
            "research_section",
            `This task researches ${section}, not ${f.section}.`,
            `/findings/${String(i)}/section`,
          ),
        );
      }
      if (seen.has(f.id)) {
        out.push(
          finding(
            "research_duplicate_id",
            `The id ${f.id} is already used.`,
            `/findings/${String(i)}/id`,
          ),
        );
      }
      seen.add(f.id);
      if (!hostAllowed(f.source.url, research.hostAllowlist)) {
        out.push(
          finding(
            "research_host",
            `The host of ${f.source.url} is not allowed. Use one of: ${research.hostAllowlist.join(", ")}.`,
            `/findings/${String(i)}/source/url`,
          ),
        );
      }
    });
    return out;
  };
}

export interface ResearchInputs {
  chosen: ArchetypeCandidate;
  /** The plans the guide describes, as context for what to look for. */
  plans: Record<string, JsonValue>;
}

/** One research task (Claude, with its own web tools). */
export function researchTask(
  ctx: PipelineContext,
  config: StageConfig,
  research: ResearchConfig,
  section: Exclude<ResearchSection, "progression" | "gear" | "crafting">,
  inputs: ResearchInputs,
): AnyTaskSpec {
  const taken = new Set(
    ResearchSection.options
      .filter((s) => s !== section)
      .flatMap((s) => (researchAnswer(ctx, s)?.findings ?? []).map((f) => f.id)),
  );
  const check = researchCheck(section, research, taken);
  return defineTask<ResearchAnswer>({
    key: researchKey(section),
    type: researchKey(section),
    promptVersion: config.promptVersion,
    instructions: `${S9_RESEARCH} Section: ${section}. Look for: ${S9_RESEARCH_FOCUS[section]}`,
    context: {
      request: requestContext(ctx),
      chosen: JSON.parse(JSON.stringify(inputs.chosen)) as JsonValue,
      ...inputs.plans,
      allowedHosts: research.hostAllowlist,
      findingsPerSection: { min: research.findings.min, max: research.findings.max },
    },
    schema: ResearchAnswer,
    check: async (answer) => check(answer),
    allowedTools: ["catalog_search", "catalog_get", "calc_evaluate"],
    entities: (a): { path: string; ref: EntityRef }[] =>
      a.findings.flatMap((f, i) =>
        f.entities.map((ref, j) => ({ path: `/findings/${String(i)}/entities/${String(j)}`, ref })),
      ),
    richText: (a): { path: string; text: RichText }[] =>
      a.findings.map((f, i) => ({ path: `/findings/${String(i)}/claim`, text: f.claim })),
  });
}
