import { z } from "zod";
import type { QualityRubric } from "./quality/rubric.js";

/*
 * The guide specification (config/agents/guide-spec.json): what a guide must be, in one versioned
 * place. A task gets only the items that apply to it (progressive disclosure), plus the measured
 * minimums of the rubric rules the items name, read from the rubric itself so counts never live
 * in two places.
 */

export const GuideSpecItem = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Task keys this item applies to; `*` matches any characters. */
  appliesTo: z.array(z.string().min(1)).min(1),
  text: z.string().min(1),
  /** Ids of rubric rules and questions this item explains; each must exist in the rubric. */
  rubric: z.array(z.string().min(1)).optional(),
});
export type GuideSpecItem = z.infer<typeof GuideSpecItem>;

export const GuideSpec = z
  .object({
    version: z.string().min(1),
    items: z.array(GuideSpecItem).min(1),
  })
  .refine((s) => new Set(s.items.map((i) => i.id)).size === s.items.length, {
    message: "guide spec item ids are not unique",
    path: ["items"],
  });
export type GuideSpec = z.infer<typeof GuideSpec>;

function matches(pattern: string, key: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(key);
}

/** The items for a task key. */
export function itemsFor(spec: GuideSpec, taskKey: string): GuideSpecItem[] {
  return spec.items.filter((i) => i.appliesTo.some((p) => matches(p, taskKey)));
}

/** Rubric ids named by the spec that the rubric does not have, and rubric ids no item names. */
export function specRubricGaps(
  spec: GuideSpec,
  rubric: QualityRubric,
): { unknown: string[]; unreferenced: string[] } {
  const known = new Set([...rubric.rules.map((r) => r.id), ...rubric.questions.map((q) => q.id)]);
  const named = new Set(spec.items.flatMap((i) => i.rubric ?? []));
  return {
    unknown: [...named].filter((id) => !known.has(id)),
    unreferenced: [...known].filter((id) => !named.has(id)),
  };
}

function measureText(rule: QualityRubric["rules"][number]): string {
  const unit = rule.measure === "words" ? "words" : "entries";
  return `${rule.description} (at least ${rule.min} ${unit})`;
}

/**
 * The instruction text for a task: the task's own instructions, then the guide spec items that
 * apply, then what the quality gate measures for them. Without a spec the text is unchanged.
 */
export function withGuideSpec(
  instructions: string,
  taskKey: string,
  spec: GuideSpec | undefined,
  rubric: QualityRubric | undefined,
): string {
  if (spec === undefined) return instructions;
  const items = itemsFor(spec, taskKey);
  if (items.length === 0) return instructions;
  const parts = items.map((item) => {
    const ids = new Set(item.rubric ?? []);
    const measured = (rubric?.rules ?? []).filter((r) => ids.has(r.id)).map(measureText);
    const judged = (rubric?.questions ?? []).filter((q) => ids.has(q.id)).map((q) => q.question);
    const lines = [`- ${item.title}: ${item.text}`];
    if (measured.length > 0) lines.push(`  Measured by the app: ${measured.join("; ")}.`);
    if (judged.length > 0) lines.push(`  Reviewed afterwards: ${judged.join(" ")}`);
    return lines.join("\n");
  });
  return `${instructions}\n\nGuide specification (${spec.version}) for this task:\n${parts.join("\n")}`;
}
