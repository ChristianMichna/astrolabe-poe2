import { z } from "zod";
import {
  type ArchetypeCandidate,
  type BuildState,
  type CraftingPlan,
  CraftingPlan as CraftingPlanSchema,
  Finding,
  GateResult,
  GearPlan,
  ProgressionPlan,
  type TargetBuild,
  TaskType,
} from "@astrolabe/contracts/build";
import { Ascendancy, CharacterClass, Gem, PassiveNode } from "@astrolabe/contracts/catalog";
import type { StatMap } from "@astrolabe/contracts/calc";
import { GuideDocument, ResearchSection } from "@astrolabe/contracts/guide";
import type { CalcId, EntityRef, JsonValue } from "@astrolabe/contracts/common";
import type { StageConfig } from "../config.js";
import { type AnyTaskSpec, defineTask, type PipelineContext, type PlanStep } from "../pipeline.js";
import { S10_CRITIC } from "../prompts.js";
import { requestContext } from "./context.js";
import { type QualityRubric, RUBRIC_SECTIONS } from "../quality/rubric.js";
import { judgedFindings, QualityVerdict, qualityKey, rubricFindings } from "./s10-quality.js";
import { craftKey, S8_PLAN_KEY } from "./s8-craft.js";
import { S6_PLAN_KEY } from "./s6-progression.js";
import { type S6Row, stageTableOf } from "./s6-table.js";
import { S7_PLAN_KEY } from "./s7-plan.js";
import { itemEntities } from "./s7-gear.js";
import {
  craftDetailKey,
  slotDetailKey,
  stageDetailKey,
  tierDetailKey,
  withDetails,
} from "./s9-detail.js";
import { type S9Section, sectionKey, sectionSchemas, walkSection } from "./s9-guide.js";
import { allFindings, researchAnswer } from "./s9-research.js";

export const S10_REPORT_KEY = "S10.report";
export const S10_CRITIC_KEY = "S10.critic";

/** What the critic reads: the written sections of the guide. */
export const CRITIC_SECTIONS = [
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
export type CriticSection = (typeof CRITIC_SECTIONS)[number];

export const CriticVerdict = z.object({
  reviewed: z
    .array(z.enum(CRITIC_SECTIONS))
    .min(1)
    .refine((r) => new Set(r).size === r.length, { message: "duplicate section" })
    .refine((r) => CRITIC_SECTIONS.every((s) => r.includes(s)), {
      message: "name every section in `reviewed` after reading all of them",
    }),
  issues: z
    .array(
      z.object({
        section: z.enum(CRITIC_SECTIONS),
        /**
         * Where in the section the problem is, when the context names it: a progression stage key,
         * "<tier>/<slot>" or a tier id of the gear plan, or a crafting plan key. It lets a prose
         * problem go back to the one detail task that wrote the text.
         */
        part: z.string().min(1).max(200).optional(),
        message: z
          .string()
          .min(1)
          .max(1000)
          .regex(/^\D*$/, { message: "no digits: numbers come from the engine" }),
      }),
    )
    .max(200),
});
export type CriticVerdict = z.infer<typeof CriticVerdict>;

/** G8 task (Claude as critic): consistency of text and data over the whole draft. */
export function criticTask(
  ctx: PipelineContext,
  config: StageConfig,
  inputs: S10Inputs,
): AnyTaskSpec | string {
  let draft: GuideDraft;
  try {
    draft = assembleDraft(ctx, inputs);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  return defineTask<CriticVerdict>({
    key: S10_CRITIC_KEY,
    type: "S10.critic",
    promptVersion: config.promptVersion,
    instructions: S10_CRITIC,
    context: {
      request: requestContext(ctx),
      draft: JSON.parse(JSON.stringify(draft)) as JsonValue,
    },
    schema: CriticVerdict,
    allowedTools: ["catalog_get"],
  });
}

/**
 * The S9 detail task that wrote the text an issue is about, when the issue names its part and that
 * task has a stored result (so the detail pass ran); otherwise the issue goes to the plan's stage.
 */
function detailCause(
  ctx: PipelineContext,
  issue: { section: CriticSection; part?: string | undefined },
): string | undefined {
  const { part } = issue;
  if (part === undefined) return undefined;
  const candidates =
    issue.section === "progression"
      ? [stageDetailKey(part)]
      : issue.section === "crafting"
        ? [craftDetailKey(part)]
        : issue.section === "gear"
          ? [
              ...(part.includes("/")
                ? [slotDetailKey(part.split("/")[0] ?? "", part.split("/").slice(1).join("/"))]
                : []),
              tierDetailKey(part),
            ]
          : [];
  return candidates.find((key) => ctx.result(key) !== undefined);
}

/** G7 quality: the rubric's measured rules and the judge's verdicts (none without a rubric). */
function qualityFindings(
  ctx: PipelineContext,
  draft: GuideDraft,
  rubric: QualityRubric | undefined,
): Finding[] {
  if (rubric === undefined) return [];
  const verdictOf = (section: (typeof RUBRIC_SECTIONS)[number]): QualityVerdict | undefined => {
    const v = ctx.result(qualityKey(section));
    return v === undefined ? undefined : stored(QualityVerdict, v, `quality verdict (${section})`);
  };
  return [
    ...rubricFindings(draft, rubric),
    ...judgedFindings(
      rubric,
      verdictOf,
      (section, part) => detailCause(ctx, { section, part }),
      causeOf,
    ),
  ].map((f) => Finding.parse(f));
}

/** The stage that wrote a section of the guide, for returning findings to it. */
function causeOf(section: CriticSection): string {
  switch (section) {
    case "progression":
      return "S6";
    case "gear":
      return "S7";
    case "crafting":
      return "S8";
    default:
      return `S9.${section}`;
  }
}

/** The stored critic verdict; an unreadable one names itself and keeps the cause. */
function readCritic(value: unknown): CriticVerdict {
  return stored(CriticVerdict, value, "critic verdict (S10.critic)");
}

/** The stored quality verdicts, by section, as the report keeps them. */
function qualitiesOf(ctx: Pick<PipelineContext, "result">): Record<string, JsonValue> {
  return Object.fromEntries(
    RUBRIC_SECTIONS.flatMap((s) => {
      const v = ctx.result(qualityKey(s));
      return v === undefined ? [] : [[s, v] as const];
    }),
  );
}

/** Whether the stored report was made with the critic verdict and quality verdicts stored now. */
export function reportIsCurrent(ctx: PipelineContext): boolean {
  const report = ctx.result(S10_REPORT_KEY);
  if (report === undefined) return false;
  const stored = report as { critic?: unknown; quality?: unknown } | null;
  const usedCritic = stored?.critic ?? null;
  const nowCritic = ctx.result(S10_CRITIC_KEY) ?? null;
  return (
    JSON.stringify(usedCritic) === JSON.stringify(nowCritic) &&
    JSON.stringify(stored?.quality ?? {}) === JSON.stringify(qualitiesOf(ctx))
  );
}

/** G8 from the critic's verdict: passes only if every part was read and nothing was found. */
function criticGate(verdict: CriticVerdict | undefined, ctx: PipelineContext): Finding[] {
  if (verdict === undefined) {
    return [finding("G8", "check_not_built", "The critic has not reviewed the guide.")];
  }
  const missed = CRITIC_SECTIONS.filter((s) => !verdict.reviewed.includes(s));
  return [
    ...missed.map((s) => finding("G8", "section_not_reviewed", `The critic did not read ${s}.`)),
    ...verdict.issues.map((i) =>
      finding(
        "G8",
        "inconsistency",
        `${i.section}: ${i.message}`,
        undefined,
        detailCause(ctx, i) ?? causeOf(i.section),
      ),
    ),
  ];
}

/** The guide as assembled by the app; metadata and the final report are added at publishing (S11). */
export const GuideDraft = GuideDocument.omit({ metadata: true, validation: true });
export type GuideDraft = z.infer<typeof GuideDraft>;

export interface S10Inputs {
  /** The configured S6 stage table, if any; without it the table comes from the release, as in S6. */
  stageTable?: readonly S6Row[];
  chosen: ArchetypeCandidate;
  target: TargetBuild;
  /** The skill the run settled on: the player's pick or the S0 choice. */
  mainSkillId: string;
  /** Whether S9 ran its detail pass; its results are merged into the plans. */
  detailPass?: boolean;
  /** The quality rubric (measured rules and judged questions); absent means no quality gate. */
  rubric?: QualityRubric;
}

/** Parses a stored result; the error names the part and keeps the schema error as cause. */
export function stored<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`The stored ${what} is unreadable. Redo the stage that wrote it.`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Puts the stored plans and the written sections together; throws with the cause if a part is unreadable. */
export function assembleDraft(ctx: PipelineContext, inputs: S10Inputs): GuideDraft {
  const part = <K extends S9Section>(
    k: K,
    schema: z.ZodType<z.infer<(typeof sectionSchemas)[K]>>,
  ) => stored(schema, ctx.result(sectionKey(k)), `${k} section (S9)`);
  const progression = stored(ProgressionPlan, ctx.result(S6_PLAN_KEY), "progression plan (S6)");
  const gear = stored(GearPlan, ctx.result(S7_PLAN_KEY), "gear plan (S7)");
  const crafting = stored(
    z.object({ plans: z.array(CraftingPlanSchema) }),
    ctx.result(S8_PLAN_KEY),
    "crafting plans (S8)",
  ).plans;
  const request = ctx.run.request;
  const planned = new Set(crafting.map((c) => c.key));
  const detailed = withDetails(ctx, inputs.detailPass === true, { progression, gear, crafting });
  // The gear plan points to the crafting plan of each crafted rare that has one.
  const linked: GearPlan = {
    tiers: detailed.gear.tiers.map((t) => ({
      ...t,
      slots: t.slots.map((sl) =>
        sl.acquisition === "craft" &&
        sl.target.kind === "crafted" &&
        planned.has(craftKey(t.budgetTier, sl.slot))
          ? { ...sl, craftingPlanKey: craftKey(t.budgetTier, sl.slot) }
          : sl,
      ),
    })),
  };
  return stored(
    GuideDraft,
    {
      request,
      summary: {
        ...part("summary", sectionSchemas.summary),
        classId: inputs.chosen.classId,
        ascendancyId: inputs.chosen.ascendancyId,
        mainSkillId: inputs.mainSkillId,
        budgetRange: { from: request.budget.leveling, to: request.budget.endgame },
      },
      mechanics: part("mechanics", sectionSchemas.mechanics),
      progression: detailed.progression,
      gear: linked,
      crafting: detailed.crafting,
      playstyle: part("playstyle", sectionSchemas.playstyle),
      atlas: part("atlas", sectionSchemas.atlas),
      variants: part("variants", sectionSchemas.variants).variants,
      faq: part("faq", sectionSchemas.faq).faq,
      research: allFindings(ctx),
    },
    "guide draft",
  );
}

type Found = { path: string; ref: EntityRef };

const ref = (kind: EntityRef["kind"], id: string, path: string): Found => ({
  path,
  ref: { kind, id } as EntityRef,
});

function stateEntities(state: BuildState, base: string): Found[] {
  return [
    ref("characterClass", state.classId, `${base}/classId`),
    ...(state.ascendancyId === undefined
      ? []
      : [ref("ascendancy", state.ascendancyId, `${base}/ascendancyId`)]),
    ...state.tree.allocated.map((n, i) =>
      ref("passiveNode", n.nodeId, `${base}/tree/allocated/${i}/nodeId`),
    ),
    ...state.tree.ascendancy.map((n, i) => ref("passiveNode", n, `${base}/tree/ascendancy/${i}`)),
    ...state.skills.flatMap((sk, i) => [
      ref("gem", sk.gem.gemId, `${base}/skills/${i}/gem/gemId`),
      ...sk.supports.map((g, j) => ref("gem", g.gemId, `${base}/skills/${i}/supports/${j}/gemId`)),
    ]),
    ...state.items.flatMap((it, i) =>
      itemEntities(it.item).map((e) => ({ path: `${base}/items/${i}/item${e.path}`, ref: e.ref })),
    ),
  ];
}

/** Currency items named by prices anywhere in a value (`currencyItemId` fields). */
function currencyEntities(value: unknown, path: string): Found[] {
  if (Array.isArray(value)) return value.flatMap((x, i) => currencyEntities(x, `${path}/${i}`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, x]) =>
    k === "currencyItemId" && typeof x === "string"
      ? [ref("baseItem", x, `${path}/${k}`)]
      : currencyEntities(x, `${path}/${k}`),
  );
}

const prefixed = (found: Found[], base: string): Found[] =>
  found.map((e) => ({ path: `${base}${e.path}`, ref: e.ref }));

/** Every catalog reference in the draft, with a JSON pointer. */
export function draftEntities(draft: GuideDraft): Found[] {
  const out: Found[] = [
    ...(draft.request.mainSkillId === undefined
      ? []
      : [ref("gem", draft.request.mainSkillId, "/request/mainSkillId")]),
    ...draft.request.exclusions.map((x, i) => ({ path: `/request/exclusions/${i}`, ref: x })),
    ref("characterClass", draft.summary.classId, "/summary/classId"),
    ref("ascendancy", draft.summary.ascendancyId, "/summary/ascendancyId"),
    ref("gem", draft.summary.mainSkillId, "/summary/mainSkillId"),
  ];
  draft.progression.stages.forEach((st, i) => {
    const base = `/progression/stages/${i}`;
    out.push(
      ...stateEntities(st.state, `${base}/state`),
      ...st.allocationOrder.map((n, j) => ref("passiveNode", n, `${base}/allocationOrder/${j}`)),
      ...st.respecs.map((n, j) => ref("passiveNode", n, `${base}/respecs/${j}`)),
      ...prefixed(
        walkSection({
          tasks: st.tasks,
          dangers: st.dangers,
          rationale: st.rationale,
          guide: st.guide,
        }).entities,
        base,
      ),
    );
  });
  draft.gear.tiers.forEach((t, i) =>
    out.push(...prefixed(walkSection({ description: t.description }).entities, `/gear/tiers/${i}`)),
  );
  draft.gear.tiers.forEach((t, i) =>
    t.slots.forEach((sl, j) => {
      out.push(
        ...prefixed(walkSection({ guide: sl.guide }).entities, `/gear/tiers/${i}/slots/${j}`),
      );
      for (const item of [sl.target, sl.minimum, ...sl.alternatives]) {
        if (item === undefined) continue;
        for (const e of itemEntities(item)) {
          out.push({ path: `/gear/tiers/${i}/slots/${j}${e.path}`, ref: e.ref });
        }
      }
    }),
  );
  draft.crafting.forEach((c, i) => {
    const base = `/crafting/${i}`;
    out.push(
      ...prefixed(itemEntities(c.target), `${base}/target`),
      ref("baseItem", c.start.baseItemId, `${base}/start/baseItemId`),
      ...c.steps.flatMap((st, j) =>
        st.actionIds.map((id, k) => ref("craftingAction", id, `${base}/steps/${j}/actionIds/${k}`)),
      ),
      ...prefixed(
        walkSection({ steps: c.steps, fallback: c.fallback, guide: c.guide }).entities,
        base,
      ),
    );
  });
  out.push(
    ...currencyEntities(draft.progression, "/progression"),
    ...currencyEntities(draft.gear, "/gear"),
    ...currencyEntities(draft.crafting, "/crafting"),
    ...walkSection({
      mechanics: draft.mechanics,
      playstyle: draft.playstyle,
      atlas: draft.atlas,
      variants: draft.variants,
      faq: draft.faq,
      summary: {
        introduction: draft.summary.introduction,
        closing: draft.summary.closing,
        scalingAxes: draft.summary.scalingAxes,
        playstyle: draft.summary.playstyle,
        strengths: draft.summary.strengths,
        weaknesses: draft.summary.weaknesses,
      },
    }).entities,
  );
  return out;
}

const finding = (
  gate: Finding["gate"],
  code: string,
  message: string,
  path?: string,
  returnTo?: string,
  severity: Finding["severity"] = "error",
): Finding =>
  Finding.parse({
    gate,
    severity,
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(returnTo === undefined ? {} : { returnTo }),
  });

/** A section written without research is shown as such, never as one where nothing was found. */
function researchFindings(ctx: PipelineContext): Finding[] {
  return ResearchSection.options.flatMap((section) => {
    const answer = researchAnswer(ctx, section);
    return answer !== undefined && !answer.webAccess
      ? [
          finding(
            "G7",
            "research_unavailable",
            `The ${section} section was written without research: the client had no web access.`,
            `/research`,
            undefined,
            "warning",
          ),
        ]
      : [];
  });
}

type S10Config = NonNullable<StageConfig["s10"]>;

/** One thing the gates measure: a progression stage, or for the endgame stage the geared build. */
interface Subject {
  stage: GuideDraft["progression"]["stages"][number];
  /** JSON pointer of the calculations that were read. */
  path: string;
  /** The stage or part that fixes a finding about this subject. */
  returnTo: TaskType;
  stats?: StatMap;
  /**
   * Campaign stages only: the stage measured wearing the first gear tier. Attribute requirements
   * are checked against it, because the stage wears at most the placeholder weapon (the gear of the early
   * tiers may grant the attributes the passive tree does not).
   */
  gearedStats?: StatMap;
  /** True when the measurement with gear was made but gave no result for the profile. */
  gearedFailed?: boolean;
  /** The gear part that fixes an attribute gap of the geared measurement. */
  gearReturnTo?: TaskType;
  /** Mods PoB read but does not calculate, from the same result as `stats`. */
  unsupportedMods?: readonly string[];
}

/**
 * The PoB outputs the gates read for the configured calc profile. Progression stages carry no
 * gear, so for endgame stages the numbers come from the last gear tier (the target build wearing
 * that tier's items); a campaign stage is measured as it is.
 */
async function stageStats(
  ctx: PipelineContext,
  draft: GuideDraft,
  profile: string,
): Promise<Subject[]> {
  const read = async (outcome: { status: string; calcId?: string } | undefined) => {
    const loaded =
      outcome?.status === "ok" && outcome.calcId !== undefined
        ? await ctx.calc.getResult(outcome.calcId as CalcId)
        : undefined;
    return loaded?.calcProfile === profile ? loaded : undefined;
  };
  const lastTier = draft.gear.tiers.length - 1;
  // Redoing only the last tier's part is cheaper and is the part whose items decide the numbers.
  const lastBudgetTier = draft.gear.tiers[lastTier]?.budgetTier;
  const part = lastBudgetTier === undefined ? "" : `S7.gear-${lastBudgetTier}`;
  const gearPart = TaskType.safeParse(part).success ? part : "S7";
  const out: Subject[] = [];
  for (const [index, stage] of draft.progression.stages.entries()) {
    const geared = stage.kind === "endgame";
    const loaded = await read(
      geared ? draft.gear.tiers[lastTier]?.calcs[profile] : stage.calcs[profile],
    );
    let gearedStats: StatMap | undefined;
    let gearedFailed = false;
    const firstTier = draft.gear.tiers[0];
    if (!geared && firstTier !== undefined) {
      const outcomes = await ctx.calc.calculate({
        state: {
          ...stage.state,
          items: firstTier.slots.map((slot) => ({ slot: slot.slot, item: slot.target })),
        },
        profiles: [profile],
        overrides: ctx.run.request.calcOverrides,
      });
      gearedStats = (await read(outcomes[profile]))?.stats;
      gearedFailed = gearedStats === undefined;
    }
    const firstPart = TaskType.safeParse(`S7.gear-${firstTier?.budgetTier ?? ""}`);
    out.push({
      stage,
      ...(gearedStats === undefined ? {} : { gearedStats }),
      ...(gearedFailed ? { gearedFailed } : {}),
      ...(firstPart.success ? { gearReturnTo: firstPart.data } : {}),
      path: geared
        ? `/gear/tiers/${String(lastTier)}/calcs`
        : `/progression/stages/${String(index)}/calcs`,
      returnTo: geared ? gearPart : "S6",
      ...(loaded === undefined
        ? {}
        : { stats: loaded.stats, unsupportedMods: loaded.unsupportedMods }),
    });
  }
  return out;
}

/**
 * The allocated nodes that no path of allocated nodes joins to `start`: the tree must be one
 * connected piece, as PoB and the game only let a node be allocated next to an allocated one.
 */
function unreachable(
  ctx: PipelineContext,
  start: string,
  allocated: readonly string[],
): string[] | undefined {
  const wanted = new Set([start, ...allocated]);
  const adjacent = new Map<string, Set<string>>();
  for (const id of wanted) {
    const entry = ctx.catalog.get({ kind: "passiveNode", id });
    if (entry === undefined) {
      if (id === start) return undefined;
      continue; // unknown ids are reported by G1
    }
    adjacent.set(id, adjacent.get(id) ?? new Set());
    // connections may be listed on one side only: record both directions
    for (const other of PassiveNode.pick({ connections: true }).parse(entry.entity).connections) {
      if (!wanted.has(other)) continue;
      adjacent.get(id)?.add(other);
      adjacent.set(other, (adjacent.get(other) ?? new Set()).add(id));
    }
  }
  const reached = new Set<string>([start]);
  const queue = [start];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const id of adjacent.get(next) ?? []) {
      if (!reached.has(id)) {
        reached.add(id);
        queue.push(id);
      }
    }
  }
  return allocated.filter((id) => !reached.has(id) && adjacent.has(id));
}

/** G3 tree connectivity of one stage: the main tree from the class start, ascendancy nodes from theirs. */
function connectivity(
  ctx: PipelineContext,
  label: string,
  state: BuildState,
  path: string,
  returnTo: TaskType,
): Finding[] {
  const out: Finding[] = [];
  const cls = ctx.catalog.get({ kind: "characterClass", id: state.classId });
  const asc =
    state.ascendancyId === undefined
      ? undefined
      : ctx.catalog.get({ kind: "ascendancy", id: state.ascendancyId });
  const allocated = state.tree.allocated;
  // A weapon set's nodes join through nodes of the main tree or of their own set (not of the other
  // set), so each set is searched with the main-tree nodes; without sets this is one search.
  const sets = [...new Set(allocated.map((a) => a.weaponSet).filter((n) => n > 0))];
  const searches = (sets.length === 0 ? [0] : sets).map((n) => [
    ...new Set(
      allocated.filter((a) => a.weaponSet === 0 || a.weaponSet === n).map((a) => a.nodeId),
    ),
  ]);
  const parts: { what: string; start: string | undefined; searches: string[][] }[] = [
    {
      what: "class",
      start:
        cls === undefined
          ? undefined
          : CharacterClass.pick({ startNodeId: true }).parse(cls.entity).startNodeId,
      searches,
    },
    {
      what: "ascendancy",
      start:
        asc === undefined
          ? undefined
          : Ascendancy.pick({ startNodeId: true }).parse(asc.entity).startNodeId,
      searches: [[...state.tree.ascendancy]],
    },
  ];
  for (const { what, start, searches: lists } of parts) {
    if (lists.every((l) => l.length === 0)) continue;
    if (start === undefined) {
      out.push(
        finding(
          "G3",
          "tree_start_unknown",
          `${label}: the catalog has no start node for the ${what} tree, so its connection was not checked.`,
          path,
        ),
      );
      continue;
    }
    const found = lists.map((nodes) => unreachable(ctx, start, nodes));
    if (found.some((f) => f === undefined)) {
      out.push(
        finding(
          "G3",
          "tree_start_unknown",
          `${label}: the start node of the ${what} tree is not a passive node of the catalog, so its connection was not checked.`,
          path,
        ),
      );
      continue;
    }
    // A foreign ascendancy's node reached over a cross-ascendancy edge counts as connected here;
    // which nodes an ascendancy owns is checked with its points, not in this gate.
    const ids = [...new Set(found.flatMap((f) => f ?? []))];
    if (ids.length > 0) {
      out.push(
        finding(
          "G3",
          "tree_node_unconnected",
          `${label}: ${ids.join(", ")} of the ${what} tree are not joined to its start by allocated nodes.`,
          path,
          returnTo,
        ),
      );
    }
  }
  return out;
}

/** G3 (spirit), G4 (resistances, EHP) and G5 (damage) from PoB outputs and the configured thresholds. */
async function measuredGates(
  ctx: PipelineContext,
  draft: GuideDraft,
  cfg: S10Config,
  stageTable?: readonly S6Row[],
  targetBuild?: TargetBuild,
): Promise<{
  g2: Finding[];
  g3: Finding[];
  g4: Finding[];
  g5: Finding[];
  thresholdsSet: { ehp: boolean; dps: boolean; ascendancy: boolean };
}> {
  const g2: Finding[] = [];
  const g3: Finding[] = [];
  const g4: Finding[] = [];
  const g5: Finding[] = [];
  /** The minimum that applies at a level: the highest fromLevel at or below it that sets the field. */
  const limit = (level: number, field: "minEhp" | "minDps"): number | undefined =>
    cfg.thresholds
      .filter((t) => t.fromLevel <= level && t[field] !== undefined)
      .sort((a, b) => b.fromLevel - a.fromLevel)[0]?.[field];
  const derived = cfg.derived;
  const ehpSet = derived !== undefined || cfg.thresholds.some((t) => t.minEhp !== undefined);
  const dpsSet = derived !== undefined || cfg.thresholds.some((t) => t.minDps !== undefined);
  /** Derived thresholds: the best measured value of each stat so far in progression order. */
  const peak: { minEhp?: number; minDps?: number } = {};
  let lastLevel: number | undefined;
  const table = stageTableOf(stageTable, ctx.catalog.release);
  if (typeof table === "string") g3.push(finding("G3", "points_unknown", table));
  // The target build carries the ascendancy nodes (S5); the stages only order the main tree.
  const target = targetBuild?.state;
  if (target !== undefined) {
    g3.push(...connectivity(ctx, "The target build", target, "/target/state/tree", "S5"));
  }
  const ascendancyLimit = ctx.catalog.release?.passivePoints?.ascendancy?.points;
  if (target !== undefined && ascendancyLimit !== undefined) {
    const start =
      target.ascendancyId === undefined
        ? undefined
        : Ascendancy.pick({ startNodeId: true }).parse(
            ctx.catalog.get({ kind: "ascendancy", id: target.ascendancyId })?.entity ?? {},
          ).startNodeId;
    const used = new Set(target.tree.ascendancy.filter((id) => id !== start)).size;
    if (used < ascendancyLimit) {
      g3.push(
        finding(
          "G3",
          "ascendancy_points_unspent",
          "The target build leaves ascendancy points of the release unspent.",
          "/target/state/tree/ascendancy",
          undefined,
          "warning",
        ),
      );
    }
    if (used > ascendancyLimit) {
      g3.push(
        finding(
          "G3",
          "ascendancy_points_overspent",
          "The target build allocates more ascendancy nodes than the release grants points.",
          "/target/state/tree/ascendancy",
          "S5",
        ),
      );
    }
  }
  for (const [
    index,
    { stage, path, returnTo, stats, unsupportedMods, gearedStats, gearedFailed, gearReturnTo },
  ] of (await stageStats(ctx, draft, cfg.calcProfile)).entries()) {
    for (const skill of stage.state.skills) {
      for (const ref of [skill.gem, ...skill.supports]) {
        const entry = ctx.catalog.get({ kind: "gem", id: ref.gemId });
        if (entry === undefined) continue; // G1 reports unknown entities
        const level = Gem.parse(entry.entity).levels.find((l) => l.level === ref.level);
        const stagePath = `/progression/stages/${String(index)}/state/skills`;
        if (level === undefined) {
          g3.push(
            finding(
              "G3",
              "gem_level_unknown",
              `Stage ${stage.key}: ${ref.gemId} has no level ${String(ref.level)} in the catalog.`,
              stagePath,
              "S6",
            ),
          );
        } else if ((level.requirements.level ?? 0) > stage.state.level) {
          g3.push(
            finding(
              "G3",
              "gem_level_requirement_unmet",
              `Stage ${stage.key}: ${ref.gemId} at level ${String(ref.level)} needs a higher character level than the stage has.`,
              stagePath,
              "S6",
            ),
          );
        }
      }
    }
    if (derived !== undefined) {
      // The derivation compares each stage with the ones before it, so they must be in level order.
      if (lastLevel !== undefined && stage.state.level <= lastLevel) {
        g3.push(
          finding(
            "G3",
            "stage_level_not_ascending",
            `Stage ${stage.key} does not have a higher character level than the stage before it.`,
            `/progression/stages/${String(index)}/state/level`,
            "S6",
          ),
        );
      }
      lastLevel = stage.state.level;
    }
    g3.push(
      ...connectivity(
        ctx,
        `Stage ${stage.key}`,
        stage.state,
        `/progression/stages/${String(index)}/state/tree`,
        "S6",
      ),
    );
    if (typeof table !== "string") {
      const row = table.find((r) => r.key === stage.key);
      // PoB counts a node once and takes off the smaller weapon set, as both sets draw on the same points.
      const inSet = (n: number) =>
        stage.state.tree.allocated.filter((a) => a.weaponSet === n).length;
      const used = stage.state.tree.allocated.length - Math.min(inSet(1), inSet(2));
      if (row === undefined) {
        g3.push(finding("G3", "points_unknown", `No passive point budget for stage ${stage.key}.`));
      } else if (used > row.passivePoints) {
        g3.push(
          finding(
            "G3",
            "points_overspent",
            `Stage ${stage.key} allocates more passives than its level grants.`,
            `/progression/stages/${String(index)}/state/tree`,
            "S6",
          ),
        );
      }
    }
    if (stats === undefined) {
      const msg = `Stage ${stage.key} has no readable result for profile ${cfg.calcProfile}.`;
      // Only the gear can be redone to fill in missing measurements of the endgame.
      const back = returnTo === "S6" ? undefined : returnTo;
      g3.push(finding("G3", "stats_unavailable", msg, path, back));
      g4.push(finding("G4", "stats_unavailable", msg, path, back));
      g5.push(finding("G5", "stats_unavailable", msg, path, back));
      continue;
    }
    const missing = (gate: Finding["gate"], name: string): Finding =>
      finding(gate, "stat_missing", `PoB gave no ${name} for stage ${stage.key}.`, path);
    const spare = stats[cfg.stats.spiritFree];
    if (spare === undefined) g3.push(missing("G3", cfg.stats.spiritFree));
    else if (spare < 0) {
      g3.push(
        finding(
          "G3",
          "spirit_overdrawn",
          `Stage ${stage.key} reserves more spirit than it has.`,
          path,
          returnTo,
        ),
      );
    }
    for (const mod of unsupportedMods ?? []) {
      if (cfg.acceptedUnsupportedModPatterns.some((p) => new RegExp(p).test(mod))) {
        // Accepted, but the guide must not pass it off as calculated: it stays in the report.
        g2.push(
          finding(
            "G2",
            "unsupported_mod_accepted",
            `Stage ${stage.key}: Path of Building does not calculate the accepted mod "${mod}"; no number may rely on it.`,
            path,
            undefined,
            "warning",
          ),
        );
        continue;
      }
      g2.push(
        finding(
          "G2",
          "unsupported_mod",
          `Stage ${stage.key}: Path of Building does not calculate the mod "${mod}", so the numbers ignore it.`,
          path,
          // S6 only orders the tree: it cannot change what a campaign stage wears or casts
          returnTo === "S6" ? undefined : returnTo,
        ),
      );
    }
    if (gearedFailed === true) {
      g3.push(
        finding(
          "G3",
          "calc_failed",
          `Stage ${stage.key}: the engine gave no result for the stage wearing the first gear tier, so its attributes were not checked.`,
          path,
          gearReturnTo,
        ),
      );
    }
    for (const { have, need } of gearedFailed === true ? [] : cfg.stats.attributes) {
      const attributes = gearedStats ?? stats;
      const owned = attributes[have];
      const required = attributes[need];
      // PoB sets the requirement stat only when some item or gem asks for more than zero of
      // the attribute (CalcPerform.lua, "Req"..attr), so no value means no requirement.
      if (owned === undefined) g3.push(missing("G3", have));
      else if (required !== undefined && required > owned) {
        g3.push(
          finding(
            "G3",
            "attribute_requirement_unmet",
            `Stage ${stage.key}: ${have} is below the requirement ${need}.`,
            path,
            // The tree search of S6 does not weigh attribute requirements, so a return to it
            // cannot fix a campaign stage (found in the first full run: five stages, all unfixed).
            gearedStats === undefined ? (returnTo === "S6" ? undefined : returnTo) : gearReturnTo,
          ),
        );
      }
    }
    if (cfg.resistanceCapStageKinds.includes(stage.kind)) {
      for (const name of cfg.stats.resistMissing) {
        const gap = stats[name];
        if (gap === undefined) g4.push(missing("G4", name));
        else if (gap > 0) {
          g4.push(
            finding(
              "G4",
              "resistance_below_cap",
              `Stage ${stage.key}: ${name} is above zero, the cap is not reached.`,
              path,
              returnTo,
            ),
          );
        }
      }
    }
    for (const [gate, list, statName, field, code] of [
      ["G4", g4, cfg.stats.ehp, "minEhp", "ehp_below_minimum"],
      ["G5", g5, cfg.stats.dps, "minDps", "dps_below_minimum"],
    ] as const) {
      if (field === "minEhp" ? !ehpSet : !dpsSet) continue;
      // A campaign stage carries at most the placeholder weapon: its EHP and damage count with the first gear tier worn
      // (an attack needs its weapon to deal damage at all), and that tier's part fixes a gap.
      // A failed measurement with gear is reported (G3 calc_failed); the ungeared numbers do not stand in.
      if (gearedFailed === true) continue;
      const value = (gearedStats ?? stats)[statName];
      const fixedBy = gearedStats === undefined ? returnTo : gearReturnTo;
      if (derived !== undefined) {
        // Measured, not configured: a stage has some, and keeps a share of the best one before it.
        if (value === undefined) {
          list.push(missing(gate, statName));
          continue;
        }
        // EHP is compared on the stage's own tree: the first gear tier is the same item set in every campaign
        // stage while the enemies of a stage scale with its level, so a geared EHP falls from stage to stage
        // (chance based defences most of all) however the tree grows. The geared value only has to be above zero.
        const compared = field === "minEhp" ? stats[statName] : value;
        if (compared === undefined) {
          list.push(missing(gate, statName));
          continue;
        }
        const best = peak[field];
        if (value <= 0 || (best !== undefined && compared < best * derived.minRatioToBest)) {
          list.push(
            finding(
              gate,
              code,
              value <= 0
                ? `Stage ${stage.key} has none of the measured ${statName}.`
                : `Stage ${stage.key} falls below the allowed share of the best ${statName} of the stages before it.`,
              path,
              fixedBy,
            ),
          );
        }
        peak[field] = Math.max(best ?? compared, compared);
        continue;
      }
      const min = limit(stage.state.level, field);
      if (min === undefined) {
        list.push(
          finding(
            gate,
            "threshold_missing",
            `No ${field} is configured for the level of stage ${stage.key}.`,
            path,
          ),
        );
        continue;
      }
      if (value === undefined) list.push(missing(gate, statName));
      else if (value < min) {
        list.push(
          finding(gate, code, `Stage ${stage.key} is below the configured minimum.`, path, fixedBy),
        );
      }
    }
  }
  if (derived !== undefined) {
    // Passing means "no stage collapses against the others", not "strong enough": say so.
    for (const [on, list, what] of [
      [ehpSet, g4, "EHP"],
      [dpsSet, g5, "damage"],
    ] as const) {
      if (!on) continue;
      list.push(
        finding(
          list === g4 ? "G4" : "G5",
          "thresholds_relative",
          `The ${what} minimums are derived from the stages of this guide (a share of the best stage before), a plausibility check and no absolute minimum.`,
          undefined,
          undefined,
          "warning",
        ),
      );
    }
  }
  if (derived === undefined && !cfg.thresholdsCalibrated) {
    // the numbers are starting values, not a product decision: the report must say so
    if (ehpSet) {
      g4.push(
        finding(
          "G4",
          "thresholds_uncalibrated",
          "The EHP minimums are uncalibrated starting values.",
          undefined,
          undefined,
          "warning",
        ),
      );
    }
    if (dpsSet) {
      g5.push(
        finding(
          "G5",
          "thresholds_uncalibrated",
          "The damage minimums are uncalibrated starting values.",
          undefined,
          undefined,
          "warning",
        ),
      );
    }
  }
  return {
    g2,
    g3,
    g4,
    g5,
    thresholdsSet: {
      ehp: ehpSet,
      dps: dpsSet,
      ascendancy: ascendancyLimit !== undefined && targetBuild !== undefined,
    },
  };
}

/** What a gate still does not check, given the config; undefined if nothing is missing. */
function gapOf(
  gate: Finding["gate"],
  cfg: S10Config | undefined,
  thresholds: { ehp: boolean; dps: boolean; ascendancy: boolean } | undefined,
): string | undefined {
  if (
    cfg === undefined &&
    (gate === "G2" || gate === "G3" || gate === "G4" || gate === "G5" || gate === "G7")
  ) {
    return `the whole gate (no "s10" block in config/agents/stages.json)`;
  }
  if (gate === "G3") {
    return thresholds?.ascendancy === true
      ? undefined
      : "ascendancy points (the data release has no passivePoints.ascendancy)";
  }
  if (gate === "G4") {
    return thresholds?.ehp === true ? undefined : "the EHP minimum (no threshold configured)";
  }
  if (gate === "G5") {
    return thresholds?.dps === true ? undefined : "the damage minimum (no threshold configured)";
  }
  return undefined;
}

/** Runs the deterministic gates over the draft; a gate passes only if everything it covers was checked. */
export async function runGates(
  ctx: PipelineContext,
  draft: GuideDraft,
  cfg?: S10Config,
  critic?: CriticVerdict,
  stageTable?: readonly S6Row[],
  targetBuild?: TargetBuild,
  rubric?: QualityRubric,
): Promise<GateResult[]> {
  const measured =
    cfg === undefined ? undefined : await measuredGates(ctx, draft, cfg, stageTable, targetBuild);
  const g1 = draftEntities(draft)
    .filter((e) => ctx.catalog.get(e.ref) === undefined)
    .map((e) =>
      finding(
        "G1",
        "unknown_entity",
        `${e.ref.kind} ${e.ref.id} is not in data release ${ctx.catalog.dataReleaseId}.`,
        e.path,
      ),
    );
  const requiredProfiles = cfg?.requiredCalcProfiles ?? [];
  const g2 = draft.progression.stages.flatMap((s, i) => {
    const path = `/progression/stages/${i}/calcs`;
    const outcomes = Object.entries(s.calcs);
    return [
      ...requiredProfiles
        .filter((profile) => outcomes.length > 0 && s.calcs[profile] === undefined)
        .map((profile) =>
          finding(
            "G2",
            "profile_missing",
            `Stage ${s.key} has no calculation for the required profile ${profile}.`,
            path,
          ),
        ),
      ...(outcomes.length === 0
        ? [finding("G2", "calc_missing", `Stage ${s.key} has no calculation.`, path, "S6")]
        : []),
      ...outcomes
        .filter(([, o]) => o.status !== "ok")
        .map(([profile]) =>
          finding(
            "G2",
            "calc_failed",
            `Stage ${s.key}: the calculation of ${profile} failed.`,
            path,
            "S6",
          ),
        ),
    ];
  });
  const g6 = draft.progression.stages.flatMap((s, i) => {
    const path = `/progression/stages/${String(i)}`;
    const out: Finding[] = [];
    if (s.respecs.length > 0 && s.respecCost?.status !== "ok") {
      out.push(
        finding(
          "G6",
          "respec_cost_not_measured",
          `Stage ${s.key} respecs passives but has no measured respec cost.`,
          `${path}/respecCost`,
          "S6",
        ),
      );
    }
    // Continuity: a skill of the previous stage carries on with its gem and at least its supports.
    const before = draft.progression.stages[i - 1];
    for (const old of before?.state.skills ?? []) {
      const now = s.state.skills.find((k) => k.key === old.key);
      let code: string | undefined;
      if (now === undefined) code = "skill_lost";
      else if (now.gem.gemId !== old.gem.gemId) code = "skill_gem_changed";
      else if (now.supports.length < old.supports.length) code = "supports_lost";
      if (code !== undefined) {
        out.push(
          finding(
            "G6",
            code,
            `Stage ${s.key}: skill ${old.key} of the stage before was lost, got another active gem or fewer supports.`,
            `${path}/state/skills`,
            // The skills come from the target build, S6 only orders the tree
            "S5",
          ),
        );
      }
    }
    return out;
  });
  const g7Counts = [
    ...(cfg !== undefined && draft.progression.stages.length < cfg.minProgressionStages
      ? [
          finding(
            "G7",
            "too_few_stages",
            "The progression has fewer stages than the configured minimum.",
            "/progression/stages",
          ),
        ]
      : []),
    ...(cfg !== undefined && draft.gear.tiers.length < cfg.minGearTiers
      ? [
          finding(
            "G7",
            "too_few_gear_tiers",
            "The gear plan has fewer tiers than the configured minimum.",
            "/gear/tiers",
          ),
        ]
      : []),
  ];
  const planned = new Set<string>(draft.crafting.map((c: CraftingPlan) => c.key));
  const g7 = draft.gear.tiers.flatMap((tier) =>
    tier.slots
      .filter((sl) => sl.acquisition === "craft" && sl.target.kind === "crafted")
      .filter((sl) => !planned.has(craftKey(tier.budgetTier, sl.slot)))
      .map((sl) =>
        finding(
          "G7",
          "craft_plan_missing",
          `Rare slot ${sl.slot} of tier ${tier.budgetTier} has no crafting plan.`,
          "/crafting",
          "S8",
        ),
      ),
  );
  const found: Partial<Record<Finding["gate"], Finding[]>> = {
    G3: measured?.g3 ?? [],
    G4: measured?.g4 ?? [],
    G5: measured?.g5 ?? [],
    G8: criticGate(critic, ctx),
    G1: g1,
    G2: [...g2, ...(measured?.g2 ?? [])],
    G6: g6,
    G7: [...g7Counts, ...g7, ...researchFindings(ctx), ...qualityFindings(ctx, draft, rubric)],
  };
  return (["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"] as const).map((gate) => {
    const findings = [...(found[gate] ?? [])];
    const gap = gapOf(gate, cfg, measured?.thresholdsSet);
    if (gap !== undefined) {
      findings.push(
        finding(
          gate,
          "check_not_built",
          `Not checked yet: ${gap}. The gate cannot count as passed.`,
        ),
      );
    }
    return GateResult.parse({
      gate,
      passed: findings.every((f) => f.severity !== "error"),
      findings,
    });
  });
}

/** S10: assembles the guide draft and runs the gates; the draft and report are stored even when gates fail. */
export function validateStep(inputs: S10Inputs, cfg?: S10Config): PlanStep {
  return {
    kind: "server",
    key: S10_REPORT_KEY,
    type: "S10",
    run: async (runCtx) => {
      const draft = assembleDraft(runCtx, inputs);
      const stored = runCtx.result(S10_CRITIC_KEY);
      const critic = stored === undefined ? undefined : readCritic(stored);
      const gates = await runGates(
        runCtx,
        draft,
        cfg,
        critic,
        inputs.stageTable,
        inputs.target,
        inputs.rubric,
      );
      return JSON.parse(
        JSON.stringify({
          passed: gates.every((g) => g.passed),
          gates,
          draft,
          critic: critic ?? null,
          quality: qualitiesOf(runCtx),
        }),
      ) as JsonValue;
    },
  };
}

const StoredReport = z.object({ passed: z.boolean(), gates: z.array(GateResult) });

/**
 * After the gates: findings that name the stage that caused them send that stage back (the
 * earliest one first, since later stages build on it); what no stage can fix stops the run.
 */
export function afterReport(ctx: PipelineContext, maxReturns: number): PlanStep | null {
  const parsed = StoredReport.safeParse(ctx.result(S10_REPORT_KEY));
  if (!parsed.success) {
    return {
      kind: "blocked",
      error: {
        code: "invalid_report",
        message: "The stored validation report is unreadable. Redo stage S10.",
      },
    };
  }
  const errors = parsed.data.gates.flatMap((g) => g.findings).filter((f) => f.severity === "error");
  if (errors.length === 0 && !parsed.data.passed) {
    return {
      kind: "blocked",
      error: {
        code: "validation_failed",
        message: "The validation report says the guide did not pass but lists no error finding.",
      },
    };
  }
  const order = (stage: string): number => Number(/^S(\d+)/.exec(stage)?.[1] ?? Infinity);
  const returnable = errors
    .filter((f) => f.returnTo !== undefined)
    .sort((a, b) => order(a.returnTo ?? "") - order(b.returnTo ?? ""));
  const first = returnable[0]?.returnTo;
  if (first !== undefined) {
    const group = returnable.filter(
      (f) => (f.returnTo ?? "").split(".")[0] === first.split(".")[0],
    );
    return {
      kind: "return",
      stage: first,
      findings: group,
      maxReturns,
      summary: `Open findings: ${errors.map((f) => f.code).join(", ")}.`,
    };
  }
  if (errors.length > 0) {
    return {
      kind: "blocked",
      error: {
        code: "validation_failed",
        message: `The guide did not pass validation and no stage can fix it by itself: ${[...new Set(errors.map((f) => `${f.gate}:${f.code}`))].join(", ")}.`,
      },
    };
  }
  return null;
}
