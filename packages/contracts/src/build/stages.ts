import { z } from "zod";
import {
  AscendancyId,
  BaseItemId,
  CharacterClassId,
  ClassificationId,
  CraftingActionId,
  EntityRef,
  GemId,
  ModId,
  PassiveNodeId,
  StatId,
  UniqueItemId,
} from "../common/ids.js";
import { DerivedSource, GamedataSource, MarketSource, measuredFrom } from "../common/sourced.js";
import { CalcId, CalcProfileId } from "../common/version.js";
import { BudgetTierId } from "./request.js";
import { BuildState, ItemSpec } from "./state.js";
import { Rationale, RichText } from "./text.js";

/*
 * Results of pipeline stages S1–S8. LLM-authored parts contain decisions and
 * RichText only; every number is either a calcId reference or a measured()
 * value with a source, filled in by the app.
 */

const key = z.string().min(1).max(64);

/** Price as amount of a currency item from the catalog. */
export const Price = z.object({
  amount: z.number().nonnegative(),
  currencyItemId: BaseItemId,
});
export type Price = z.infer<typeof Price>;

/** Prices come from the market or are derived (e.g. expected crafting cost). */
export const MeasuredPrice = measuredFrom(Price, [MarketSource, DerivedSource]);
/** Probabilities and attempt counts come from game data (mod weights) or are derived. */
export const MeasuredChance = measuredFrom(z.number().min(0).max(1), [
  GamedataSource,
  DerivedSource,
]);
export const MeasuredCount = measuredFrom(z.number().nonnegative(), [
  GamedataSource,
  DerivedSource,
]);
/** Ratios such as gain per cost are always derived. */
export const MeasuredRatio = measuredFrom(z.number(), [DerivedSource]);

/** Calculation of a state: a PoB result id, or an explicit failure. */
export const CalcOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), calcId: CalcId }),
  z.object({
    status: z.literal("failed"),
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
  }),
]);
export type CalcOutcome = z.infer<typeof CalcOutcome>;

/** S1: mechanics of the main skill (catalog-derived, enriched by the planner). */
export const SkillProfile = z.object({
  mainSkillId: GemId,
  tags: z.array(ClassificationId),
  scalingStats: z.array(StatId),
  supportCandidates: z.array(GemId),
  relevantUniques: z.array(UniqueItemId),
  relevantNodes: z.array(PassiveNodeId),
  ascendancyCandidates: z.array(AscendancyId),
  notes: z.array(Rationale).default([]),
});
export type SkillProfile = z.infer<typeof SkillProfile>;

/** S2: one archetype idea (LLM output). */
export const ArchetypeCandidate = z.object({
  key,
  title: z.string().min(1).max(120),
  classId: CharacterClassId,
  ascendancyId: AscendancyId,
  damageRoute: RichText,
  defenceConcept: RichText,
  keyEntities: z.array(EntityRef).min(1),
  hypothesis: RichText,
});
export type ArchetypeCandidate = z.infer<typeof ArchetypeCandidate>;

/** S3: skeleton build and PoB result per candidate (deterministic). */
export const ArchetypeEvaluation = z.object({
  candidateKey: key,
  skeleton: BuildState,
  calcs: z.record(CalcProfileId, CalcOutcome),
});
export type ArchetypeEvaluation = z.infer<typeof ArchetypeEvaluation>;

/** S5: validated endgame target. */
export const TargetBuild = z.object({
  candidateKey: key,
  state: BuildState,
  calcs: z.record(CalcProfileId, CalcOutcome),
  rationale: z.array(Rationale),
});
export type TargetBuild = z.infer<typeof TargetBuild>;

/** What the player does with a skill gem when entering a stage. */
export const StageGemChange = z.object({
  action: z.enum(["add", "swap", "remove", "keep"]),
  gem: EntityRef,
  /** The gem this one replaces (swap only). */
  replaces: EntityRef.optional(),
  reason: RichText,
});
export type StageGemChange = z.infer<typeof StageGemChange>;

/**
 * Prose for one progression stage (S9, written per stage): what the stage is about, why the tree
 * looks as it does, what changes in skills and gear and what to check before moving on. The
 * passive nodes and all numbers stay in the stage itself; this only explains them.
 */
export const StageGuide = z.object({
  intro: RichText,
  treeNotes: z.array(Rationale).default([]),
  gemChanges: z.array(StageGemChange).default([]),
  gearNotes: z.array(RichText).default([]),
  checklist: z.array(RichText).default([]),
  nextStep: RichText.optional(),
});
export type StageGuide = z.infer<typeof StageGuide>;

export const ProgressionStage = z
  .object({
    key,
    order: z.int().nonnegative(),
    label: z.string().min(1).max(120),
    /** Astrolabe's stage grouping; act numbers and level bands come from config. */
    kind: z.enum(["campaign", "endgame"]),
    act: z.int().positive().optional(),
    levelRange: z.tuple([z.int().positive(), z.int().positive()]),
    budgetTier: BudgetTierId.optional(),
    state: BuildState,
    /** Order in which this stage's new passives are allocated. */
    allocationOrder: z.array(PassiveNodeId),
    respecs: z.array(PassiveNodeId).default([]),
    /** Respec cost of this stage (G6); derived from game data and market. */
    respecCost: MeasuredPrice.optional(),
    tasks: z.array(RichText).min(1),
    dangers: z.array(RichText).default([]),
    rationale: z.array(Rationale).default([]),
    /** Detailed prose of the stage (S9); absent in guides written before it existed. */
    guide: StageGuide.optional(),
    calcs: z.record(CalcProfileId, CalcOutcome),
  })
  .refine((s) => s.levelRange[0] <= s.levelRange[1], {
    message: "levelRange must be ascending",
    path: ["levelRange"],
  });
export type ProgressionStage = z.infer<typeof ProgressionStage>;

/** S6: stages from first level to endgame. Minimum count comes from config (G7). */
export const ProgressionPlan = z.object({
  stages: z.array(ProgressionStage).min(1),
});
export type ProgressionPlan = z.infer<typeof ProgressionPlan>;

/** One stat the player looks for on a slot, most important first. */
export const StatPriority = z.object({
  modId: ModId,
  reason: RichText,
});
export type StatPriority = z.infer<typeof StatPriority>;

/** Prose for one gear slot (S9): why this item, what to look for, where to get it. */
export const SlotGuide = z.object({
  why: RichText,
  statPriorities: z.array(StatPriority).default([]),
  whereToGet: RichText,
  alternativesNotes: z.array(RichText).default([]),
  upgradeAdvice: RichText.optional(),
});
export type SlotGuide = z.infer<typeof SlotGuide>;

export const GearSlotPlan = z.object({
  slot: z.string().min(1),
  priority: z.enum(["core", "important", "nice"]),
  target: ItemSpec,
  minimum: ItemSpec.optional(),
  alternatives: z.array(ItemSpec).default([]),
  acquisition: z.enum(["drop", "vendor", "trade", "craft"]),
  craftingPlanKey: key.optional(),
  cost: MeasuredPrice,
  /** Detailed prose of the slot (S9); absent in guides written before it existed. */
  guide: SlotGuide.optional(),
});
export type GearSlotPlan = z.infer<typeof GearSlotPlan>;

/** S7: slot tables per budget tier with upgrade order. */
export const GearPlan = z.object({
  tiers: z
    .array(
      z.object({
        budgetTier: BudgetTierId,
        /** What this budget tier means and how its gear is obtained (S9). */
        description: RichText.optional(),
        slots: z.array(GearSlotPlan).min(1),
        upgradeOrder: z.array(z.object({ slot: z.string().min(1), gainPerCost: MeasuredRatio })),
        /**
         * The target build wearing this tier's gear, measured per calc profile. The gates read the
         * endgame numbers (resistances, EHP, damage) here, because the progression stages carry
         * no gear. Empty for plans written before this field existed.
         */
        calcs: z.record(CalcProfileId, CalcOutcome).default({}),
      }),
    )
    .min(1),
});
export type GearPlan = z.infer<typeof GearPlan>;

/** What happens when a crafting step does not reach its check. */
export const CraftOnFail = z.discriminatedUnion("action", [
  z.object({ action: z.literal("repeat") }),
  z.object({ action: z.literal("restart") }),
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("abort"), reason: RichText }),
  z.object({ action: z.literal("goto"), order: z.int().nonnegative() }),
]);
export type CraftOnFail = z.infer<typeof CraftOnFail>;

export const CraftStep = z.object({
  order: z.int().nonnegative(),
  /** Actions used together in this step (e.g. a currency plus modifiers). */
  actionIds: z.array(CraftingActionId).min(1),
  goal: RichText,
  successChance: MeasuredChance,
  expectedAttempts: MeasuredCount,
  expectedCost: MeasuredPrice,
  onFail: CraftOnFail,
});
export type CraftStep = z.infer<typeof CraftStep>;

/** Prose for one crafting plan (S9). */
export const CraftingGuide = z.object({
  overview: RichText,
  tips: z.array(RichText).default([]),
  pitfalls: z.array(RichText).default([]),
});
export type CraftingGuide = z.infer<typeof CraftingGuide>;

/** S8: recipe for one rare slot. */
export const CraftingPlan = z.object({
  key,
  /** Gear tier the rare belongs to (GearPlan tier id); each tier plans its own rares. */
  tier: z.string().min(1).optional(),
  slot: z.string().min(1),
  target: ItemSpec,
  start: z.object({
    baseItemId: BaseItemId,
    itemLevel: z.int().positive(),
    cost: MeasuredPrice,
  }),
  steps: z.array(CraftStep).min(1),
  expectedTotal: MeasuredPrice,
  /**
   * Chance that one attempt of the whole strategy reaches the goal mods (the simulator's
   * `successChance`). The step chances only say how often a step's own check passes, which is
   * `1` for a step without a check, so this is the number a player plans with. Absent in
   * guides written before it existed.
   */
  successChance: MeasuredChance.optional(),
  /** Attempts of the whole strategy until one success; absent in older guides. */
  expectedAttempts: MeasuredCount.optional(),
  fallback: RichText.optional(),
  /** Detailed prose of the craft (S9); absent in guides written before it existed. */
  guide: CraftingGuide.optional(),
});
export type CraftingPlan = z.infer<typeof CraftingPlan>;
