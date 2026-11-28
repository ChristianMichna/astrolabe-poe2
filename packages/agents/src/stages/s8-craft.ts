import { z } from "zod";
import {
  type ArchetypeCandidate,
  CraftingPlan,
  type Finding,
  type GearPlan,
  type ItemSpec,
  Rationale,
  RichText,
} from "@astrolabe/contracts/build";
import {
  CraftStrategy,
  CraftStrategyStep,
  type CraftSimRequest,
  type CraftSimResult,
} from "@astrolabe/contracts";
import { type BaseItemId, ClassificationId, ModId } from "@astrolabe/contracts/common";
import type { JsonValue } from "@astrolabe/contracts/common";
import type { StageConfig } from "../config.js";
import { defineTask, type AnyTaskSpec, type PipelineContext, type PlanStep } from "../pipeline.js";
import { S8_CRAFT } from "../prompts.js";
import { requestContext } from "./context.js";
import { rejectedFindings } from "./s2-candidates.js";

export const S8_PLAN_KEY = "S8.plan";
export const S8_CRAFT_PREFIX = "S8.craft-";

type CraftedSpec = Extract<ItemSpec, { kind: "crafted" }>;
type PlanStepTier = GearPlan["tiers"][number];

/** A rare of one gear tier that is meant to be crafted. */
export interface CraftSlot {
  /** Budget tier of the gear plan the rare belongs to. */
  tier: string;
  slot: string;
  key: string;
  target: CraftedSpec;
}

/** Task type and result key part of a slot: lower case, digits and dashes. */
export function slotSlug(slot: string): string {
  return slot
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export const craftKey = (tier: string, slot: string): string =>
  `${S8_CRAFT_PREFIX}${slotSlug(tier)}-${slotSlug(slot)}`;

/** The slots to craft: the crafted rares of every gear tier that are acquired by crafting. */
export function craftSlotsOf(plan: GearPlan): CraftSlot[] | string {
  const slots = plan.tiers.flatMap((tier: PlanStepTier) =>
    tier.slots.flatMap((s) =>
      s.acquisition === "craft" && s.target.kind === "crafted"
        ? [
            {
              tier: tier.budgetTier as string,
              slot: s.slot,
              key: craftKey(tier.budgetTier, s.slot),
              target: s.target,
            },
          ]
        : [],
    ),
  );
  if (slots.some((s) => slotSlug(s.slot) === "" || slotSlug(s.tier) === "")) {
    return "A craft slot or tier id has no letters or digits, so it cannot name a task.";
  }
  const keys = new Set(slots.map((s) => s.key));
  return keys.size === slots.length
    ? slots
    : "Two craft slots have the same task name after normalising; the slot ids are ambiguous.";
}

/** What Claude plans per crafted slot: the start item and the strategy. */
export const CraftSubmission = z.object({
  startItemLevel: z.int().positive(),
  startRarity: ClassificationId,
  startModIds: z.array(ModId).default([]),
  steps: z.array(CraftStrategyStep.extend({ goal: RichText })).min(1),
  fallback: RichText.optional(),
  rationale: z.array(Rationale).min(1),
});
export type CraftSubmission = z.infer<typeof CraftSubmission>;

/** The goal is fixed by the target: its required mods, or all of them if none is marked. */
export function goalOf(target: CraftedSpec): CraftSimRequest["goal"] | undefined {
  const required = target.mods.filter((m) => m.required);
  const mods = required.length > 0 ? required : target.mods;
  return mods.length === 0 ? undefined : { clauses: mods.map((m) => ({ anyOfModIds: [m.modId] })) };
}

/** The simulator request of a submission; costs only when a currency is known. */
export function simRequest(
  ctx: PipelineContext,
  slot: CraftSlot,
  sub: CraftSubmission,
  costs?: { currencyItemId: BaseItemId; startCost: CraftSimRequest["startCost"] },
): CraftSimRequest | string {
  const goal = goalOf(slot.target);
  if (goal === undefined) return `The target item of slot ${slot.slot} has no mods to craft for.`;
  const strategy = CraftStrategy.safeParse({
    steps: sub.steps.map((step) => {
      const { goal, ...rest } = step;
      void goal;
      return rest;
    }),
  });
  if (!strategy.success) return `The strategy is not valid: ${strategy.error.message}`;
  return {
    dataReleaseId: ctx.run.request.dataReleaseId,
    start: {
      baseItemId: slot.target.baseItemId,
      itemLevel: sub.startItemLevel,
      rarity: sub.startRarity,
      modIds: sub.startModIds,
      flags: [],
    },
    strategy: strategy.data,
    goal,
    ...(ctx.run.request.league === undefined ? {} : { league: ctx.run.request.league }),
    ...(costs === undefined
      ? {}
      : {
          costCurrencyItemId: costs.currencyItemId,
          ...(costs.startCost === undefined ? {} : { startCost: costs.startCost }),
        }),
  } as CraftSimRequest;
}

/** S8 part 1: the craft strategy of one rare slot (Claude), simulated at once. */
export function craftTask(
  ctx: PipelineContext,
  config: StageConfig,
  slot: CraftSlot,
  chosen: ArchetypeCandidate,
): AnyTaskSpec {
  return defineTask<CraftSubmission>({
    key: slot.key,
    type: `S8.craft-${slotSlug(slot.tier)}-${slotSlug(slot.slot)}`,
    promptVersion: config.promptVersion,
    instructions: S8_CRAFT,
    context: {
      request: requestContext(ctx),
      chosen,
      tier: slot.tier,
      slot: slot.slot,
      target: JSON.parse(JSON.stringify(slot.target)) as JsonValue,
    },
    schema: CraftSubmission,
    allowedTools: ["catalog_search", "catalog_get", "craft_simulate"],
    entities: (c) => [
      ...c.startModIds.map((id, i) => ({
        path: `/startModIds/${i}`,
        ref: { kind: "mod" as const, id },
      })),
      ...c.steps.flatMap((st, i) => [
        ...st.actionIds.map((id, j) => ({
          path: `/steps/${i}/actionIds/${j}`,
          ref: { kind: "craftingAction" as const, id },
        })),
        ...(st.until?.clauses ?? []).flatMap((cl, j) =>
          cl.anyOfModIds.map((id, k) => ({
            path: `/steps/${i}/until/clauses/${j}/anyOfModIds/${k}`,
            ref: { kind: "mod" as const, id },
          })),
        ),
      ]),
      ...c.rationale.flatMap((r, i) =>
        r.subject === undefined ? [] : [{ path: `/rationale/${i}/subject`, ref: r.subject }],
      ),
    ],
    richText: (c) => [
      ...c.steps.map((st, i) => ({ path: `/steps/${i}/goal`, text: st.goal })),
      ...(c.fallback === undefined ? [] : [{ path: "/fallback", text: c.fallback }]),
      ...c.rationale.map((r, i) => ({ path: `/rationale/${i}/reason`, text: r.reason })),
    ],
    check: async (c, checkCtx) => {
      const findings: Finding[] = rejectedFindings(
        checkCtx,
        c.startModIds.map((id, i) => ({
          path: `/startModIds/${i}`,
          ref: { kind: "mod" as const, id },
        })),
      );
      const rarityIds = checkCtx.catalog.release?.rarities?.rarities.map((r) => r.id);
      if (rarityIds !== undefined && !rarityIds.includes(c.startRarity)) {
        findings.push({
          gate: "G1",
          severity: "error",
          code: "unknown_rarity",
          message: `Rarity ${c.startRarity} is not a rarity id of this release. Use one of: ${rarityIds.join(", ")}.`,
          path: "/startRarity",
        });
        return findings;
      }
      if (rarityIds === undefined) {
        findings.push({
          gate: "G1",
          severity: "warning",
          code: "rarity_unchecked",
          message: "The data release lists no rarities, so the start rarity could not be checked.",
          path: "/startRarity",
        });
      }
      const request = simRequest(checkCtx, slot, c);
      if (typeof request === "string") {
        findings.push({
          gate: "G3",
          severity: "error",
          code: "invalid_strategy",
          message: request,
          path: "/steps",
        });
        return findings;
      }
      if (checkCtx.craft === undefined) {
        throw new Error("S8 runs without the crafting simulator");
      }
      let result: CraftSimResult;
      try {
        result = await checkCtx.craft.simulate(request);
      } catch (cause) {
        findings.push({
          gate: "G3",
          severity: "error",
          code: "simulation_rejected",
          message: cause instanceof Error ? cause.message : String(cause),
          path: "/steps",
        });
        return findings;
      }
      if (result.successChance.status !== "ok") {
        findings.push({
          gate: "G3",
          severity: "warning",
          code: "simulation_uncalibrated",
          message:
            "The simulator could not evaluate this strategy (missing rules or spawn weights); the plan will show it as uncalibrated.",
          path: "/steps",
        });
      } else if (result.successChance.value === 0) {
        findings.push({
          gate: "G3",
          severity: "error",
          code: "goal_unreachable",
          message: "In the simulation no attempt reached the goal mods; change the strategy.",
          path: "/steps",
        });
      }
      return findings;
    },
  });
}

type Measured<T> = Extract<T, { status: "uncalibrated" }>;
const uncalibrated = <T extends { status: string }>(reason: string): Measured<T> =>
  ({ status: "uncalibrated", reason }) as unknown as Measured<T>;

/** S8 part 2: the validated plans, each strategy simulated again with prices. */
export function craftPlanJob(
  ctx: PipelineContext,
  slots: readonly CraftSlot[],
  chosen: ArchetypeCandidate,
): PlanStep {
  void chosen;
  return {
    kind: "job",
    key: S8_PLAN_KEY,
    type: "S8.plan",
    label: "simulating the crafting strategies with prices",
    run: async (runCtx) => {
      const craft = runCtx.craft;
      if (craft === undefined && slots.length > 0) {
        throw new Error("S8 runs without the crafting simulator");
      }
      const plans: CraftingPlan[] = [];
      for (const slot of slots) {
        const parsed = CraftSubmission.safeParse(runCtx.result(slot.key));
        if (!parsed.success || craft === undefined) {
          throw new Error(`The stored craft strategy of ${slot.slot} is unreadable`, {
            cause: parsed.success ? undefined : parsed.error,
          });
        }
        const sub = parsed.data;
        // The start item is the base: its market price (if any) is the start cost.
        let currencyItemId: BaseItemId | undefined;
        let startCost: CraftingPlan["start"]["cost"] = uncalibrated(
          "No economy service is configured.",
        );
        if (runCtx.economy !== undefined) {
          try {
            const answer = await runCtx.economy.price({
              ...(runCtx.run.request.league === undefined
                ? {}
                : { league: runCtx.run.request.league }),
              items: [{ kind: "baseItem", id: slot.target.baseItemId }],
            });
            currencyItemId = answer.inCurrencyItemId;
            const entry = answer.prices.find(
              (p) => p.item.kind === "baseItem" && p.item.id === slot.target.baseItemId,
            );
            const first = entry?.price;
            startCost =
              sub.startModIds.length > 0
                ? uncalibrated("There is no price feed for a start item with mods.")
                : first === undefined
                  ? uncalibrated("The economy service returned no price for the base item.")
                  : answer.freshness === "stale"
                    ? uncalibrated("The price refresh failed and only an older price book exists.")
                    : first;
          } catch (cause) {
            startCost = {
              status: "failed",
              error: {
                code: "price_fetch_failed",
                message: cause instanceof Error ? cause.message : String(cause),
              },
            };
          }
        }
        const request = simRequest(
          runCtx,
          slot,
          sub,
          currencyItemId === undefined ? undefined : { currencyItemId, startCost },
        );
        if (typeof request === "string") throw new Error(request);
        const result = await craft.simulate(request);
        const steps = sub.steps.map((step) => {
          const stat = result.steps.find((s) => s.order === step.order);
          const passed = stat?.passed;
          // The simulator reports no attempts per step; 1/passed holds only for "repeat" steps.
          const attempts: CraftingPlan["steps"][number]["expectedAttempts"] = uncalibrated(
            "The simulator does not report attempts per step.",
          );
          return {
            order: step.order,
            actionIds: step.actionIds,
            goal: step.goal,
            successChance:
              passed ??
              uncalibrated<CraftingPlan["steps"][number]["successChance"]>("No statistics."),
            expectedAttempts: attempts,
            expectedCost: uncalibrated<CraftingPlan["steps"][number]["expectedCost"]>(
              "The simulator prices the whole strategy, not single steps.",
            ),
            onFail: step.onFail,
          };
        });
        plans.push({
          key: slot.key,
          tier: slot.tier,
          slot: slot.slot,
          target: slot.target,
          start: {
            baseItemId: slot.target.baseItemId,
            itemLevel: sub.startItemLevel,
            cost: startCost,
          },
          steps,
          expectedTotal: result.expectedCost,
          successChance: result.successChance,
          expectedAttempts: result.expectedAttempts,
          ...(sub.fallback === undefined ? {} : { fallback: sub.fallback }),
        });
      }
      const parsedPlans = z.array(CraftingPlan).safeParse(plans);
      if (!parsedPlans.success) {
        throw new Error("The crafting plans are not valid", { cause: parsedPlans.error });
      }
      return JSON.parse(JSON.stringify({ plans: parsedPlans.data })) as JsonValue;
    },
  };
}
