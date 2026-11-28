import { z } from "zod";
import {
  CraftingGuide,
  type CraftingPlan,
  type Finding,
  type GearPlan,
  type ProgressionPlan,
  type ProgressionStage,
  RichText,
  SlotGuide,
  StageGuide,
  type TargetBuild,
} from "@astrolabe/contracts/build";
import type { JsonValue } from "@astrolabe/contracts/common";
import type { StageConfig } from "../config.js";
import { defineTask, type AnyTaskSpec, type PipelineContext } from "../pipeline.js";
import { S9_DETAIL } from "../prompts.js";
import { partFindings } from "../quality/rubric.js";
import { requestContext } from "./context.js";
import { slotSlug } from "./s8-craft.js";
import { citableCalcs, walkSection } from "./s9-guide.js";

/*
 * S9 detail pass: after the document-level sections, every progression stage, gear tier, gear slot
 * and crafting plan gets its own short task with its own schema (ADR-0003: no single-shot prompts).
 * The plans stay as S6 to S8 made them; these tasks only add prose to them.
 */

const TierDescription = z.object({ description: RichText });
export type TierDescription = z.infer<typeof TierDescription>;

export type DetailItem =
  | { kind: "stage"; key: string; stage: ProgressionStage }
  | { kind: "tier"; key: string; tier: string }
  | { kind: "slot"; key: string; tier: string; slot: string }
  | { kind: "craft"; key: string; plan: CraftingPlan };

export const stageDetailKey = (stage: string): string => `S9.stage-${slotSlug(stage)}`;
export const tierDetailKey = (tier: string): string => `S9.tier-${slotSlug(tier)}`;
export const slotDetailKey = (tier: string, slot: string): string =>
  `S9.slot-${slotSlug(tier)}-${slotSlug(slot)}`;
export const craftDetailKey = (planKey: string): string => `S9.craft-${slotSlug(planKey)}`;

export interface DetailPlans {
  progression: ProgressionPlan;
  gear: GearPlan;
  crafting: readonly CraftingPlan[];
}

/** All detail tasks of a guide, in the order they are asked. */
export function detailItems(plans: DetailPlans): DetailItem[] {
  return [
    ...plans.progression.stages.map((stage): DetailItem => ({
      kind: "stage",
      key: stageDetailKey(stage.key),
      stage,
    })),
    ...plans.gear.tiers.flatMap((t): DetailItem[] => [
      { kind: "tier", key: tierDetailKey(t.budgetTier), tier: t.budgetTier },
      ...t.slots.map((s): DetailItem => ({
        kind: "slot",
        key: slotDetailKey(t.budgetTier, s.slot),
        tier: t.budgetTier,
        slot: s.slot,
      })),
    ]),
    ...plans.crafting.map((plan): DetailItem => ({
      kind: "craft",
      key: craftDetailKey(plan.key),
      plan,
    })),
  ];
}

const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue;

const gemIdsOf = (stage: ProgressionStage | undefined): Set<string> =>
  new Set(
    (stage?.state.skills ?? []).flatMap((sk) => [sk.gem.gemId, ...sk.supports.map((g) => g.gemId)]),
  );

/** A stage's gem changes must name gems the plans really have (no inventing of setups). */
function stageCheck(plans: DetailPlans, stage: ProgressionStage, min: number) {
  const index = plans.progression.stages.findIndex((s) => s.key === stage.key);
  const now = gemIdsOf(stage);
  const before = gemIdsOf(plans.progression.stages[index - 1]);
  return (payload: StageGuide): Promise<Finding[]> => {
    const out: Finding[] = [];
    const fail = (code: string, message: string, path: string): void => {
      out.push({ gate: "schema", severity: "error", code, message, path });
    };
    payload.gemChanges.forEach((c, i) => {
      const path = `/gemChanges/${String(i)}`;
      if (c.gem.kind !== "gem") return fail("not_a_gem", "A gem change must name a gem.", path);
      const wanted = c.action === "remove" ? before : now;
      if (!wanted.has(c.gem.id)) {
        fail(
          "gem_not_in_stage",
          c.action === "remove"
            ? `Gem ${c.gem.id} is not in the stage before, so it cannot be removed.`
            : `Gem ${c.gem.id} is not in this stage's setup; only describe gems the stage has.`,
          `${path}/gem`,
        );
      }
      if (c.action === "swap" && (c.replaces === undefined || !before.has(c.replaces.id))) {
        fail(
          "swap_without_source",
          "A swap names the gem it replaces, and that gem must be in the stage before.",
          `${path}/replaces`,
        );
      }
    });
    if (payload.treeNotes.length < min) {
      fail(
        "too_few_tree_notes",
        `Explain at least ${String(min)} choices of the stage's passive tree in treeNotes.`,
        "/treeNotes",
      );
    }
    return Promise.resolve(out);
  };
}

/** One detail task (Claude); the stored result is merged into the plans when the draft is assembled. */
export function detailTask(
  ctx: PipelineContext,
  config: StageConfig,
  item: DetailItem,
  inputs: { plans: DetailPlans; target: TargetBuild },
): AnyTaskSpec {
  const depth = config.s9?.depth;
  const rubric = config.s9?.rubric;
  const base = {
    request: requestContext(ctx),
    calcs: citableCalcs(inputs.target),
  };
  const common = {
    key: item.key,
    type: item.key,
    promptVersion: config.promptVersion,
    allowedTools: ["catalog_search", "catalog_get", "calc_evaluate"],
  };
  switch (item.kind) {
    case "stage": {
      const { stage } = item;
      const index = inputs.plans.progression.stages.findIndex((s) => s.key === stage.key);
      const previous = inputs.plans.progression.stages[index - 1];
      return defineTask<StageGuide>({
        ...common,
        instructions: `${S9_DETAIL} Part to write: the guide of progression stage ${stage.key} (${stage.label}). Cover what this stage is for, why its passive nodes were taken (treeNotes, subject = a notable or keystone from the new nodes), which gems the player adds, swaps or removes compared with the stage before (gemChanges), what to do about gear, and a checklist to complete before moving on.`,
        context: json({
          ...base,
          stage: {
            key: stage.key,
            label: stage.label,
            kind: stage.kind,
            act: stage.act ?? null,
            levelRange: stage.levelRange,
            newNodes: stage.allocationOrder,
            respecs: stage.respecs,
            skills: stage.state.skills,
            tasks: stage.tasks,
            dangers: stage.dangers,
            rationale: stage.rationale,
            calcs: stage.calcs,
          },
          previousStage:
            previous === undefined
              ? null
              : { key: previous.key, label: previous.label, skills: previous.state.skills },
        }),
        schema: StageGuide,
        check: async (p: StageGuide): Promise<Finding[]> => [
          ...(await stageCheck(inputs.plans, stage, depth?.minTreeNotesPerStage ?? 0)(p)),
          ...partFindings(
            rubric,
            {
              progression: { stages: [{ key: stage.key, levelRange: stage.levelRange, guide: p }] },
            },
            "/progression/stages/*/guide",
          ),
        ],
        entities: (p) => walkSection(p).entities,
        richText: (p) => walkSection(p).texts,
      });
    }
    case "tier": {
      const tier = inputs.plans.gear.tiers.find((t) => t.budgetTier === item.tier);
      return defineTask<TierDescription>({
        ...common,
        instructions: `${S9_DETAIL} Part to write: a description of the gear tier ${item.tier}: what a player at this budget wears, how the slots are obtained and in which order the upgrades make sense.`,
        context: json({
          ...base,
          tier: item.tier,
          slots: tier?.slots.map((s) => ({
            slot: s.slot,
            priority: s.priority,
            acquisition: s.acquisition,
            target: s.target,
          })),
          upgradeOrder: tier?.upgradeOrder,
        }),
        schema: TierDescription,
        check: (p: TierDescription): Promise<Finding[]> =>
          Promise.resolve(
            partFindings(
              rubric,
              {
                gear: { tiers: [{ budgetTier: item.tier, slots: [], description: p.description }] },
              },
              "/gear/tiers/*/description",
            ),
          ),
        entities: (p) => walkSection(p).entities,
        richText: (p) => walkSection(p).texts,
      });
    }
    case "slot": {
      const tier = inputs.plans.gear.tiers.find((t) => t.budgetTier === item.tier);
      const slot = tier?.slots.find((s) => s.slot === item.slot);
      return defineTask<SlotGuide>({
        ...common,
        instructions: `${S9_DETAIL} Part to write: the guide of gear slot ${item.slot} in tier ${item.tier}. Explain why this item fits the build, which modifiers to look for in priority order (statPriorities, modId from the catalog), where to get it, and what to use instead (alternativesNotes).`,
        context: json({ ...base, tier: item.tier, slot }),
        schema: SlotGuide,
        check: (p: SlotGuide): Promise<Finding[]> =>
          Promise.resolve([
            ...partFindings(
              rubric,
              {
                gear: {
                  tiers: [
                    {
                      budgetTier: item.tier,
                      slots: [{ slot: item.slot, acquisition: "drop", guide: p }],
                    },
                  ],
                },
              },
              "/gear/tiers/*/slots/*/guide",
            ),
            ...(p.statPriorities.length < (depth?.minStatPrioritiesPerSlot ?? 0)
              ? [
                  {
                    gate: "schema" as const,
                    severity: "error" as const,
                    code: "too_few_stat_priorities",
                    message: `Name at least ${String(depth?.minStatPrioritiesPerSlot)} modifiers to look for in statPriorities.`,
                    path: "/statPriorities",
                  },
                ]
              : []),
          ]),
        entities: (p) => walkSection(p).entities,
        richText: (p) => walkSection(p).texts,
      });
    }
    case "craft":
      return defineTask<CraftingGuide>({
        ...common,
        instructions: `${S9_DETAIL} Part to write: the guide of the crafting plan for slot ${item.plan.slot}: an overview of the strategy, tips for doing it efficiently and the mistakes that waste currency.`,
        context: json({ ...base, plan: item.plan }),
        schema: CraftingGuide,
        check: (p: CraftingGuide): Promise<Finding[]> =>
          Promise.resolve(
            partFindings(
              rubric,
              { crafting: [{ key: item.plan.key, steps: [], start: {}, guide: p }] },
              "/crafting/*/guide",
            ),
          ),
        entities: (p) => walkSection(p).entities,
        richText: (p) => walkSection(p).texts,
      });
  }
}

/** Reads a stored detail result; an unreadable one names itself and keeps the cause. */
function readDetail<T>(schema: z.ZodType<T>, value: unknown, key: string): T {
  if (value === undefined) {
    throw new Error(`The guide detail ${key} (S9) has not been written yet.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`The stored guide detail ${key} (S9) is unreadable. Redo that task.`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** The plans with the detail prose merged in; unchanged plans when the detail pass is off. */
export function withDetails(
  ctx: PipelineContext,
  enabled: boolean,
  plans: DetailPlans,
): DetailPlans {
  if (!enabled) return plans;
  const get = <T>(schema: z.ZodType<T>, key: string): T => readDetail(schema, ctx.result(key), key);
  return {
    progression: {
      stages: plans.progression.stages.map((s) => ({
        ...s,
        guide: get(StageGuide, stageDetailKey(s.key)),
      })),
    },
    gear: {
      tiers: plans.gear.tiers.map((t) => ({
        ...t,
        description: get(TierDescription, tierDetailKey(t.budgetTier)).description,
        slots: t.slots.map((s) => ({
          ...s,
          guide: get(SlotGuide, slotDetailKey(t.budgetTier, s.slot)),
        })),
      })),
    },
    crafting: plans.crafting.map((c) => ({
      ...c,
      guide: get(CraftingGuide, craftDetailKey(c.key)),
    })),
  };
}
