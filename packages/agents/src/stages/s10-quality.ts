import { z } from "zod";
import type { Finding } from "@astrolabe/contracts/build";
import type { JsonValue } from "@astrolabe/contracts/common";
import type { StageConfig } from "../config.js";
import { defineTask, type AnyTaskSpec, type PipelineContext } from "../pipeline.js";
import { S10_QUALITY } from "../prompts.js";
import {
  measureRubric,
  returnTarget,
  RUBRIC_SECTIONS,
  type QualityRubric,
  type RubricQuestion,
  type RubricSection,
} from "../quality/rubric.js";
import { requestContext } from "./context.js";
import { craftDetailKey, slotDetailKey, stageDetailKey, tierDetailKey } from "./s9-detail.js";
import type { GuideDraft } from "./s10-validate.js";

/*
 * Quality gate of the guide (G7, depth): the measured rules of the rubric run inside the gates; the
 * questions that cannot be counted are judged by Claude, one task per section (S10.quality-<section>),
 * after the critic. A criterion that is not met sends the task that wrote the text back.
 */

export const qualityKey = (section: RubricSection): string => `S10.quality-${section}`;

export const DETAIL_KEYS = {
  stage: stageDetailKey,
  tier: tierDetailKey,
  slot: slotDetailKey,
  craft: craftDetailKey,
};

/** Sections the rubric asks questions about, in the order of the guide. */
export function judgedSections(rubric: QualityRubric | undefined): RubricSection[] {
  if (rubric === undefined) return [];
  return RUBRIC_SECTIONS.filter((s) => rubric.questions.some((q) => q.section === s));
}

export const QualityVerdict = z.object({
  verdicts: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        met: z.boolean(),
        /** Where in the section the problem is (stage key, "<tier>/<slot>", tier id, crafting plan key). */
        part: z.string().min(1).max(200).optional(),
        /** What the judge saw, in words; no digits: numbers come from the engine. */
        evidence: z
          .string()
          .min(1)
          .max(1000)
          .regex(/^\D*$/, { message: "no digits: numbers come from the engine" }),
      }),
    )
    .max(100),
});
export type QualityVerdict = z.infer<typeof QualityVerdict>;

/** The part of the draft a judge reads: prose and choices, without trees and calculation records. */
export function sectionView(draft: GuideDraft, section: RubricSection): JsonValue {
  const view = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue;
  switch (section) {
    case "progression":
      return view(
        draft.progression.stages.map((s) => ({
          key: s.key,
          label: s.label,
          levelRange: s.levelRange,
          skills: s.state.skills,
          tasks: s.tasks,
          dangers: s.dangers,
          rationale: s.rationale,
          guide: s.guide,
        })),
      );
    case "gear":
      return view(
        draft.gear.tiers.map((t) => ({
          tier: t.budgetTier,
          description: t.description,
          slots: t.slots.map((s) => ({
            slot: s.slot,
            priority: s.priority,
            acquisition: s.acquisition,
            alternatives: s.alternatives.length,
            guide: s.guide,
          })),
        })),
      );
    case "crafting":
      return view(draft.crafting.map((c) => ({ key: c.key, slot: c.slot, guide: c.guide })));
    case "variants":
      return view(draft.variants);
    case "faq":
      return view(draft.faq);
    default:
      return view(draft[section]);
  }
}

/** The judge's task for one section: the section's questions, each answered once. */
export function qualityTask(
  ctx: PipelineContext,
  config: StageConfig,
  rubric: QualityRubric,
  section: RubricSection,
  draft: GuideDraft,
): AnyTaskSpec {
  const questions = rubric.questions.filter((q) => q.section === section);
  const ids = questions.map((q) => q.id);
  const validParts = (v: { id: string }): ((part: string) => boolean) | undefined => {
    const wantsSlot = questions.find((q) => q.id === v.id)?.returnTo === "detail:slot";
    if (section === "progression") {
      const keys = new Set(draft.progression.stages.map((s) => s.key));
      return (p) => keys.has(p);
    }
    if (section === "crafting") {
      const keys = new Set(draft.crafting.map((c) => c.key));
      return (p) => keys.has(p);
    }
    if (section === "gear") {
      const slots = new Set(
        draft.gear.tiers.flatMap((t) => t.slots.map((s) => `${t.budgetTier}/${s.slot}`)),
      );
      const tiers = new Set(draft.gear.tiers.map((t) => t.budgetTier));
      return (p) => slots.has(p) || (!wantsSlot && tiers.has(p));
    }
    return undefined;
  };
  return defineTask<QualityVerdict>({
    key: qualityKey(section),
    type: qualityKey(section),
    promptVersion: config.promptVersion,
    instructions: `${S10_QUALITY} Section to judge: ${section}.`,
    context: {
      request: requestContext(ctx),
      section,
      content: sectionView(draft, section),
      questions: questions.map((q) => ({ id: q.id, question: q.question })),
    },
    schema: QualityVerdict,
    allowedTools: ["catalog_get"],
    check: (p: QualityVerdict): Promise<Finding[]> => {
      const seen = new Set<string>();
      const out: Finding[] = [];
      p.verdicts.forEach((v, i) => {
        if (!ids.includes(v.id) || seen.has(v.id)) {
          out.push({
            gate: "schema",
            severity: "error",
            code: "unknown_or_duplicate_question",
            message: `Question ${v.id} is unknown or answered twice. Answer each of: ${ids.join(", ")}.`,
            path: `/verdicts/${String(i)}/id`,
          });
        }
        seen.add(v.id);
      });
      p.verdicts.forEach((v, i) => {
        const needsPart = section === "progression" || section === "gear" || section === "crafting";
        if (needsPart && !v.met && v.part === undefined) {
          out.push({
            gate: "schema",
            severity: "error",
            code: "part_missing",
            message: `Name the stage, tier, slot or crafting plan the problem of ${v.id} is in, in part.`,
            path: `/verdicts/${String(i)}/part`,
          });
        }
      });
      p.verdicts.forEach((v, i) => {
        const valid = validParts(v);
        if (!v.met && v.part !== undefined && valid !== undefined && !valid(v.part)) {
          out.push({
            gate: "schema",
            severity: "error",
            code: "part_unknown",
            message: `Part ${v.part} does not exist in the ${section} section. Name a stage key, tier id, "<tier>/<slot>" or crafting plan key exactly as in the content.`,
            path: `/verdicts/${String(i)}/part`,
          });
        }
      });
      for (const id of ids) {
        if (!seen.has(id)) {
          out.push({
            gate: "schema",
            severity: "error",
            code: "missing_answer",
            message: `Question ${id} has no answer.`,
            path: "/verdicts",
          });
        }
      }
      return Promise.resolve(out);
    },
    richText: () => [],
    entities: () => [],
  });
}

/** Findings of the measured rules over the whole draft. */
export function rubricFindings(draft: GuideDraft, rubric: QualityRubric): Finding[] {
  return measureRubric(draft, rubric, DETAIL_KEYS);
}

/** Findings of the judged questions; a section nobody judged yet fails, as an unread critic does. */
export function judgedFindings(
  rubric: QualityRubric,
  verdictOf: (section: RubricSection) => QualityVerdict | undefined,
  detailCause: (section: RubricSection, part: string | undefined) => string | undefined,
  fallback: (section: RubricSection) => string,
): Finding[] {
  return judgedSections(rubric).flatMap((section) => {
    const verdict = verdictOf(section);
    if (verdict === undefined) {
      return [
        {
          gate: "G7" as const,
          severity: "error" as const,
          code: "quality_not_judged",
          message: `The quality of the ${section} section has not been judged yet.`,
        },
      ];
    }
    return rubric.questions
      .filter((q: RubricQuestion) => q.section === section)
      .flatMap((q) => {
        const v = verdict.verdicts.find((x) => x.id === q.id);
        if (v === undefined) {
          return [
            {
              gate: "G7" as const,
              severity: "error" as const,
              code: "quality_not_judged",
              message: `The judge gave no answer to ${q.id}.`,
            },
          ];
        }
        if (v.met) return [];
        const target =
          detailCause(section, v.part) ??
          returnTarget(q.returnTo, [], DETAIL_KEYS) ??
          fallback(section);
        return [
          {
            gate: "G7" as const,
            severity: "error" as const,
            code: `quality-${q.id}`.slice(0, 64),
            message: `${section}: ${q.question} Not met: ${v.evidence}`,
            returnTo: target,
          },
        ];
      });
  });
}
