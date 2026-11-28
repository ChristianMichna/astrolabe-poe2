import { z } from "zod";
import type { Finding } from "@astrolabe/contracts/build";

/*
 * Quality rubric of a guide (gate G7, depth). The file lives in config/agents/guide-rubric.json,
 * derived from the structure and level of detail of two reference build guides: how much each part
 * says, whether decisions are justified, whether alternatives are named, whether advice is concrete.
 *
 * Two kinds of criteria:
 *  - rules: measured by the app on the assembled draft, no AI involved (counts and word counts at
 *    a JSON pointer, `*` stands for every element of an array);
 *  - questions: judged by Claude in one task per section after validation (S10.quality-<section>),
 *    for what cannot be counted: concreteness, reasons, fitness for the player's mode and budget.
 * Every criterion names the task that is sent back when it is not met.
 */

export const RUBRIC_SECTIONS = [
  "summary",
  "mechanics",
  "progression",
  "gear",
  "crafting",
  "playstyle",
  "atlas",
  "variants",
  "faq",
] as const;
export type RubricSection = (typeof RUBRIC_SECTIONS)[number];

/** A task type, or `detail:stage|tier|slot|craft` for the detail task of the element that failed. */
const ReturnTo = z.union([
  z.string().regex(/^S9\.(?:summary|mechanics|playstyle|atlas|variants|faq)$/),
  z.enum(["detail:stage", "detail:tier", "detail:slot", "detail:craft"]),
]);

/** The path a detail task writes, so a rule cannot send its finding to a task that cannot fix it. */
const DETAIL_PATH: Record<string, RegExp> = {
  "detail:stage": /^\/progression\/stages\/\*\/guide(?:\/|$)/,
  "detail:tier": /^\/gear\/tiers\/\*\/description(?:\/|$)/,
  "detail:slot": /^\/gear\/tiers\/\*\/slots\/\*\/guide(?:\/|$)/,
  "detail:craft": /^\/crafting\/\*\/guide(?:\/|$)/,
};
export type ReturnTo = z.infer<typeof ReturnTo>;

const id = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, { message: "lower case, digits and dashes" });

export const RubricRule = z
  .object({
    id,
    section: z.enum(RUBRIC_SECTIONS),
    description: z.string().min(1).max(300),
    /** JSON pointer into the guide draft; `*` matches every element of an array. */
    path: z.string().regex(/^\/[A-Za-z0-9_/*-]*$/),
    /** `count`: entries of a list; `words`: words of all text segments below the node. */
    measure: z.enum(["count", "words"]),
    min: z.int().positive(),
    returnTo: ReturnTo,
  })
  .refine((r) => DETAIL_PATH[r.returnTo]?.test(r.path) ?? true, {
    message: "a detail task can only be asked about the text it writes",
    path: ["returnTo"],
  });
export type RubricRule = z.infer<typeof RubricRule>;

export const RubricQuestion = z.object({
  id,
  section: z.enum(RUBRIC_SECTIONS),
  /** What the judge decides, as a yes/no question about the section. */
  question: z.string().min(1).max(400),
  returnTo: ReturnTo,
});
export type RubricQuestion = z.infer<typeof RubricQuestion>;

export const QualityRubric = z
  .object({
    version: z.string().min(1),
    rules: z.array(RubricRule).min(1),
    questions: z.array(RubricQuestion),
  })
  .refine(
    (r) => {
      const ids = [...r.rules.map((x) => x.id), ...r.questions.map((x) => x.id)];
      return new Set(ids).size === ids.length;
    },
    { message: "criterion ids must be unique" },
  );
export type QualityRubric = z.infer<typeof QualityRubric>;

interface Matched {
  value: unknown;
  pointer: string;
  /** The objects on the way down, outermost first. */
  ancestors: readonly unknown[];
}

/** Every node a pattern with `*` matches; a missing key matches as `undefined` (counts as nothing). */
export function matchPath(root: unknown, pattern: string): Matched[] {
  const parts = pattern.split("/").slice(1);
  let level: Matched[] = [{ value: root, pointer: "", ancestors: [] }];
  for (const part of parts) {
    const next: Matched[] = [];
    for (const m of level) {
      const ancestors = [...m.ancestors, m.value];
      if (part === "*") {
        if (Array.isArray(m.value)) {
          m.value.forEach((v, i) =>
            next.push({ value: v, pointer: `${m.pointer}/${i}`, ancestors }),
          );
        } else if (m.value !== undefined) {
          throw new Error(
            `Rubric path ${pattern}: * meets something that is not a list at ${m.pointer}.`,
          );
        }
      } else {
        const v =
          typeof m.value === "object" && m.value !== null
            ? (m.value as Record<string, unknown>)[part]
            : undefined;
        next.push({ value: v, pointer: `${m.pointer}/${part}`, ancestors });
      }
    }
    level = next;
  }
  return level;
}

/** Words of every text segment below a value. */
export function wordsOf(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + wordsOf(v), 0);
  if (typeof value !== "object" || value === null) return 0;
  const o = value as Record<string, unknown>;
  if (o.type === "text" && typeof o.text === "string") {
    return o.text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }
  return Object.values(o).reduce<number>((n, v) => n + wordsOf(v), 0);
}

const countOf = (value: unknown): number =>
  Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1;

/** The task that wrote the element a rule or question is about. */
export function returnTarget(
  returnTo: ReturnTo,
  ancestors: readonly unknown[],
  keys: {
    stage: (stage: string) => string;
    tier: (tier: string) => string;
    slot: (tier: string, slot: string) => string;
    craft: (plan: string) => string;
  },
): string | undefined {
  if (!returnTo.startsWith("detail:")) return returnTo;
  const objs = ancestors.filter(
    (a): a is Record<string, unknown> => typeof a === "object" && a !== null,
  );
  const str = (o: Record<string, unknown> | undefined, k: string): string | undefined =>
    typeof o?.[k] === "string" ? (o[k] as string) : undefined;
  const stage = objs.find((o) => "levelRange" in o);
  const tier = objs.find((o) => "budgetTier" in o && "slots" in o);
  const slot = objs.find((o) => "slot" in o && "acquisition" in o);
  const craft = objs.find((o) => "steps" in o && "start" in o);
  switch (returnTo) {
    case "detail:stage":
      return str(stage, "key") === undefined ? undefined : keys.stage(str(stage, "key") ?? "");
    case "detail:tier":
      return str(tier, "budgetTier") === undefined
        ? undefined
        : keys.tier(str(tier, "budgetTier") ?? "");
    case "detail:slot":
      return str(tier, "budgetTier") === undefined || str(slot, "slot") === undefined
        ? undefined
        : keys.slot(str(tier, "budgetTier") ?? "", str(slot, "slot") ?? "");
    case "detail:craft":
      return str(craft, "key") === undefined ? undefined : keys.craft(str(craft, "key") ?? "");
    default:
      return undefined;
  }
}

/**
 * The measured rules against a draft (or a part of one). `only` limits the rules to a path prefix,
 * so a task can hold its own answer to the rules for its part. Findings are gate G7.
 */
export function measureRubric(
  draft: unknown,
  rubric: QualityRubric,
  keys: Parameters<typeof returnTarget>[2],
  only?: (rule: RubricRule) => boolean,
): Finding[] {
  return rubric.rules
    .filter((r) => only === undefined || only(r))
    .flatMap((rule) =>
      matchPath(draft, rule.path).flatMap((m) => {
        const have = rule.measure === "count" ? countOf(m.value) : wordsOf(m.value);
        if (have >= rule.min) return [];
        const returnTo = returnTarget(rule.returnTo, m.ancestors, keys);
        const unit = rule.measure === "count" ? "entries" : "words";
        return [
          {
            gate: "G7" as const,
            severity: "error" as const,
            code: `rubric-${rule.id}`.slice(0, 64),
            message: `${rule.description} It has ${String(have)} ${unit}; the guide quality rubric asks for at least ${String(rule.min)}.`,
            path: m.pointer,
            ...(returnTo === undefined ? {} : { returnTo }),
          },
        ];
      }),
    );
}

const NO_KEYS = {
  stage: (k: string): string => k,
  tier: (k: string): string => k,
  slot: (t: string, s: string): string => `${t}/${s}`,
  craft: (k: string): string => k,
};

/**
 * The measured rules for one part of the guide, held against a task's own answer so a thin text is
 * sent back to the task that wrote it, with the rule's words, before it can reach the gates.
 * `draftPart` has the shape of the guide draft but holds only that part.
 */
export function partFindings(
  rubric: QualityRubric | undefined,
  draftPart: unknown,
  prefix: string,
): Finding[] {
  if (rubric === undefined) return [];
  return measureRubric(
    draftPart,
    rubric,
    NO_KEYS,
    (r) => r.path === prefix || r.path.startsWith(`${prefix}/`),
  ).map((f) => {
    const own: Finding = { ...f };
    delete own.returnTo;
    return own;
  });
}
