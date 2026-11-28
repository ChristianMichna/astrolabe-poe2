import { z } from "zod";
import { type ArchetypeCandidate, SkillProfile } from "@astrolabe/contracts/build";
import type { JsonValue } from "@astrolabe/contracts/common";
import type { UserIntervention } from "@astrolabe/contracts/forge";
import type { StageConfig } from "./config.js";
import type { Pipeline, PipelineContext, PlanStep } from "./pipeline.js";
import { S0_SKILL_KEY, SkillChoice, skillTask } from "./stages/s0-skill.js";
import { profileBase, profileTask, S1_BASE_KEY, S1_PROFILE_KEY } from "./stages/s1-profile.js";
import { candidatesOf, candidateTask } from "./stages/s2-candidates.js";
import { evaluationsJob, S3_KEY } from "./stages/s3-evaluate.js";
import { S4_KEY, selectionStep, selectionWait } from "./stages/s4-select.js";
import {
  chosenEvaluation,
  GemSetupSubmission,
  gemTask,
  S5_GEMS_KEY,
  type S5Config,
  S5_TARGET_KEY,
  S5_TREE_KEY,
  targetSize,
  targetStep,
  treeJob,
} from "./stages/s5-target.js";
import {
  notesTask,
  planStep,
  ProgressionNotes,
  S6_NOTES_KEY,
  S6_PLAN_KEY,
  type S6Config,
  S6_STAGES_KEY,
  StoredStages,
  stagesJob,
} from "./stages/s6-progression.js";
import { TargetBuild } from "@astrolabe/contracts/build";
import type { ProgressionStageTree } from "./ports.js";
import { stageTableOf } from "./stages/s6-table.js";
import { isMinionSkill, withMinionStats } from "./minion-stats.js";
import { withGuideSpec } from "./guide-spec.js";
import { S7_PLAN_KEY, planJob } from "./stages/s7-plan.js";
import { gearKey, gearTask, resolveS7, tiersOf } from "./stages/s7-gear.js";
import { CraftingPlan, GearPlan, ProgressionPlan } from "@astrolabe/contracts/build";
import { publishStep, S11_GUIDE_KEY } from "./stages/s11-publish.js";
import {
  afterReport,
  assembleDraft,
  criticTask,
  type GuideDraft,
  reportIsCurrent,
  S10_CRITIC_KEY,
  validateStep,
} from "./stages/s10-validate.js";
import { detailItems, detailTask } from "./stages/s9-detail.js";
import { judgedSections, qualityKey, qualityTask } from "./stages/s10-quality.js";
import { S9_SECTIONS, sectionKey, sectionTask } from "./stages/s9-guide.js";
import { S8_PLAN_KEY, craftPlanJob, craftSlotsOf, craftTask } from "./stages/s8-craft.js";
import {
  isResearched,
  researchAnswer,
  researchSections,
  researchTask,
} from "./stages/s9-research.js";

export const FORGE_PIPELINE_ID = "forge";

/**
 * The real pipeline, stage by stage as the stages get built. Today: S0
 * (main skill), S1 (mechanics), S2 (archetype candidates), S3 (skeleton
 * measurement as a background job), S4 (the player's choice). Everything after
 * needs packages that do not exist yet (optimizer, crafting simulator,
 * economy) and ends the run with an explicit "not implemented" error instead
 * of inventing results.
 */
export function createForgePipeline(config: StageConfig): Pipeline {
  const pipeline = createPlainPipeline(config);
  const spec = config.s9?.guideSpec;
  if (spec === undefined) return pipeline;
  // Every task gets the guide specification items that apply to it, and only those.
  return {
    ...pipeline,
    plan: (ctx) => {
      const step = pipeline.plan(ctx);
      if (step.kind !== "task") return step;
      return {
        ...step,
        spec: {
          ...step.spec,
          instructions: withGuideSpec(
            step.spec.instructions,
            step.spec.key,
            spec,
            config.s9?.rubric,
          ),
          promptVersion: `${step.spec.promptVersion}+${spec.version}`,
        },
      };
    },
  };
}

function createPlainPipeline(config: StageConfig): Pipeline {
  const mainSkillOf = (ctx: PipelineContext): string | undefined => {
    if (ctx.run.request.mainSkillId !== undefined) return ctx.run.request.mainSkillId;
    const chosen = ctx.result(S0_SKILL_KEY);
    return chosen === undefined ? undefined : SkillChoice.parse(chosen).mainSkillId;
  };

  return {
    id: FORGE_PIPELINE_ID,
    plannedTasks: (ctx) =>
      (ctx.run.request.mainSkillId === undefined ? 1 : 0) +
      1 +
      config.s2.candidateCount +
      (config.s5 === undefined ? 0 : 1) +
      (config.s6 === undefined ? 0 : 1) +
      (config.s7 === undefined ? 0 : (tiersOf(config.s7, ctx.run.request.budget)?.length ?? 0)) +
      craftTaskCount(ctx) +
      S9_SECTIONS.length +
      researchSections(config).length +
      detailTaskCount(ctx, config) +
      judgedSections(config.s9?.rubric).length +
      1,
    validateIntervention: (intervention: UserIntervention, ctx) => {
      if (intervention.kind !== "chooseVariant") return undefined;
      if (ctx.result(S3_KEY) === undefined) {
        return "The candidates are not measured yet; choose after the calculation is done";
      }
      if (ctx.result(S4_KEY) !== undefined) {
        return "A variant is already chosen; redo stage S4 to choose again";
      }
      const keys = candidatesOf(ctx, config.s2.candidateCount).map((c) => c.key);
      return keys.includes(intervention.candidateKey)
        ? undefined
        : `Unknown variant ${intervention.candidateKey}`;
    },
    plan: (ctx): PlanStep => {
      // A tier range the gear stage cannot plan would only show up after S6; stop at the start.
      if (config.s7 !== undefined && tiersOf(config.s7, ctx.run.request.budget) === undefined) {
        return {
          kind: "blocked",
          error: {
            code: "unknown_budget_tier",
            message: `The requested budget tiers ${ctx.run.request.budget.leveling} to ${ctx.run.request.budget.endgame} are not an ascending range of the configured tiers.`,
          },
        };
      }
      const mainSkillId = mainSkillOf(ctx);
      if (mainSkillId === undefined) return { kind: "task", spec: skillTask(ctx, config) };

      const base = ctx.result(S1_BASE_KEY);
      if (base === undefined) {
        const problem = presetSkillProblem(ctx, mainSkillId, config);
        if (problem !== undefined) {
          return { kind: "blocked", error: { code: "invalid_main_skill", message: problem } };
        }
        return {
          kind: "server",
          key: S1_BASE_KEY,
          type: "S1.base",
          run: async (runCtx) => profileBase(runCtx, mainSkillId),
        };
      }
      const profileExtension = ctx.result(S1_PROFILE_KEY);
      if (profileExtension === undefined) {
        return {
          kind: "task",
          spec: profileTask(ctx, config, base as { mainSkillId: string; tags: string[] }),
        };
      }
      const profile: JsonValue = {
        ...(base as Record<string, JsonValue>),
        ...(profileExtension as Record<string, JsonValue>),
      };

      const candidates = candidatesOf(ctx, config.s2.candidateCount);
      if (candidates.length < config.s2.candidateCount) {
        return {
          kind: "task",
          spec: candidateTask(ctx, config, candidates.length + 1, candidates, profile),
        };
      }
      const parsed = SkillProfile.safeParse(profile);
      if (!parsed.success) {
        return {
          kind: "blocked",
          error: {
            code: "invalid_profile",
            message: `The stored skill profile is not valid: ${parsed.error.message.slice(0, 500)}`,
          },
        };
      }
      if (ctx.result(S3_KEY) === undefined) return evaluationsJob(ctx, parsed.data, candidates);
      if (ctx.result(S4_KEY) === undefined) {
        const choice = ctx.latest("chooseVariant");
        if (choice === undefined) return selectionWait(candidates);
        return selectionStep(choice.candidateKey);
      }
      return planTarget(ctx, config, parsed.data, candidates);
    },
  };
}

/** S5: gem setup (Claude), endgame tree (PoB job), then the validated target. */
function planTarget(
  ctx: PipelineContext,
  config: StageConfig,
  profile: SkillProfile,
  candidates: readonly ArchetypeCandidate[],
): PlanStep {
  const s5Base = config.s5;
  if (s5Base === undefined) {
    return {
      kind: "blocked",
      error: {
        code: "s5_not_configured",
        message:
          "S5 needs the calc profiles and the tree objective of the target build (config/agents/stages.json, block s5). They have not been set yet. S0 to S4 are done; their results are stored with the run.",
      },
    };
  }
  const size = targetSize(ctx.catalog.release);
  if (typeof size === "string") {
    return { kind: "blocked", error: { code: "release_facts_missing", message: size } };
  }
  const s5: S5Config = { ...s5Base, ...size };
  const selected = z.object({ candidateKey: z.string() }).safeParse(ctx.result(S4_KEY));
  if (!selected.success) {
    return {
      kind: "blocked",
      error: {
        code: "invalid_selection",
        message: "The stored S4 choice is unreadable. Redo stage S4.",
      },
    };
  }
  const chosenKey = selected.data.candidateKey;
  const chosen = candidates.find((c) => c.key === chosenKey);
  const evaluation = chosenEvaluation(ctx, chosenKey);
  if (chosen === undefined || evaluation === undefined) {
    return {
      kind: "blocked",
      error: {
        code: "chosen_candidate_missing",
        message: `The chosen candidate ${chosenKey} has no stored S2 or S3 result. Redo stage S2.`,
      },
    };
  }
  const gems = ctx.result(S5_GEMS_KEY);
  if (gems === undefined) {
    return { kind: "task", spec: gemTask(ctx, config, s5, chosen, evaluation) };
  }
  const setupParsed = GemSetupSubmission.safeParse(gems);
  if (!setupParsed.success) {
    return {
      kind: "blocked",
      error: {
        code: "invalid_gem_setup",
        message: "The stored S5 gem setup is unreadable. Redo stage S5.",
      },
    };
  }
  const setup = setupParsed.data;
  const tree = ctx.result(S5_TREE_KEY);
  if (tree === undefined) return treeJob(ctx, s5, profile, chosen, evaluation, setup);
  const targetResult = ctx.result(S5_TARGET_KEY);
  if (targetResult === undefined) {
    return targetStep(chosen, tree as { state: unknown; calcs: unknown }, setup);
  }
  return planProgression(ctx, config, profile, chosen, targetResult);
}

/** S6: stage ordering (PoB job), texts (Claude), then the validated plan. */
function planProgression(
  ctx: PipelineContext,
  config: StageConfig,
  profile: SkillProfile,
  chosen: ArchetypeCandidate,
  targetResult: JsonValue,
): PlanStep {
  const s6Base = config.s6;
  if (s6Base === undefined) {
    return {
      kind: "blocked",
      error: {
        code: "s6_not_configured",
        message:
          "S6 needs the calc profiles and the tree objective of the progression (config/agents/stages.json, block s6). They have not been set yet. S0 to S5 are done; their results are stored with the run.",
      },
    };
  }
  const table = stageTableOf(s6Base.stages, ctx.catalog.release);
  if (typeof table === "string") {
    return { kind: "blocked", error: { code: "release_facts_missing", message: table } };
  }
  const s6: S6Config = { ...s6Base, stages: [...table] };
  const target = TargetBuild.safeParse(targetResult);
  if (!target.success) {
    return {
      kind: "blocked",
      error: {
        code: "invalid_target",
        message: "The stored S5 target is unreadable. Redo stage S5.",
      },
    };
  }
  const stored = ctx.result(S6_STAGES_KEY);
  if (stored === undefined) return stagesJob(ctx, s6, profile, chosen, target.data);
  const storedTrees = StoredStages.safeParse(stored);
  if (!storedTrees.success) {
    return {
      kind: "blocked",
      error: {
        code: "invalid_stages",
        message: "The stored S6 stages are unreadable. Redo stage S6.",
      },
    };
  }
  const trees = storedTrees.data as unknown as ProgressionStageTree[];
  const notes = ctx.result(S6_NOTES_KEY);
  if (notes === undefined) return { kind: "task", spec: notesTask(ctx, config, s6, trees) };
  const parsedNotes = ProgressionNotes.safeParse(notes);
  if (!parsedNotes.success) {
    return {
      kind: "blocked",
      error: {
        code: "invalid_notes",
        message: "The stored S6 texts are unreadable. Redo stage S6.",
      },
    };
  }
  if (ctx.result(S6_PLAN_KEY) === undefined) return planStep(s6, trees, parsedNotes.data);
  return planGear(ctx, config, chosen, target.data);
}

/** S7: the gear of each budget tier (Claude, checked with PoB); prices and upgrade order follow. */
function planGear(
  ctx: PipelineContext,
  baseConfig: StageConfig,
  chosen: ArchetypeCandidate,
  target: TargetBuild,
): PlanStep {
  // From S7 on, a minion build's gear objective and damage gate read PoB's minion stats.
  const config =
    baseConfig.minion !== undefined &&
    isMinionSkill(ctx.catalog, mainSkillOfRun(ctx), baseConfig.minion)
      ? withMinionStats(baseConfig, baseConfig.minion)
      : baseConfig;
  const s7Base = config.s7;
  if (s7Base === undefined) {
    return {
      kind: "blocked",
      error: {
        code: "s7_not_configured",
        message:
          "S7 needs the budget tiers and calc profiles of the gear stage (config/agents/stages.json, block s7). They have not been set yet. S0 to S6 are done; their results are stored with the run.",
      },
    };
  }
  const s7 = resolveS7(s7Base, ctx.catalog.release);
  if (typeof s7 === "string") {
    return { kind: "blocked", error: { code: "release_facts_missing", message: s7 } };
  }
  const tiers = tiersOf(s7, ctx.run.request.budget);
  if (tiers === undefined) {
    return {
      kind: "blocked",
      error: {
        code: "unknown_budget_tier",
        message: `The requested budget tiers ${ctx.run.request.budget.leveling} to ${ctx.run.request.budget.endgame} are not an ascending range of the configured tiers.`,
      },
    };
  }
  const open = tiers.find((t) => ctx.result(gearKey(t.id)) === undefined);
  if (open !== undefined) {
    const earlier = tiers
      .slice(0, tiers.indexOf(open))
      .map((t) => ({ tier: t.id, gear: ctx.result(gearKey(t.id)) as JsonValue }));
    return { kind: "task", spec: gearTask(ctx, config, s7, open, chosen, target, earlier) };
  }
  if (ctx.result(S7_PLAN_KEY) === undefined) return planJob(ctx, s7, tiers, chosen, target);
  return planCraft(ctx, config, chosen, target);
}

/** S8: a craft strategy per rare of the endgame gear (Claude, simulated at once), then the priced plans. */
function planCraft(
  ctx: PipelineContext,
  config: StageConfig,
  chosen: ArchetypeCandidate,
  target: TargetBuild,
): PlanStep {
  const gear = GearPlan.safeParse(ctx.result(S7_PLAN_KEY));
  if (!gear.success) {
    return {
      kind: "blocked",
      error: {
        code: "invalid_gear_plan",
        message: "The stored S7 gear plan is unreadable. Redo stage S7.",
      },
    };
  }
  const slots = craftSlotsOf(gear.data);
  if (typeof slots === "string") {
    return { kind: "blocked", error: { code: "invalid_gear_plan", message: slots } };
  }
  if (slots.length > 0 && ctx.craft === undefined) {
    return {
      kind: "blocked",
      error: {
        code: "craft_unavailable",
        message:
          "S8 needs the crafting simulator, which this server runs without. S0 to S7 are done; their results are stored with the run.",
      },
    };
  }
  const open = slots.find((s) => ctx.result(s.key) === undefined);
  if (open !== undefined) return { kind: "task", spec: craftTask(ctx, config, open, chosen) };
  if (ctx.result(S8_PLAN_KEY) === undefined) return craftPlanJob(ctx, slots, chosen);
  return planGuide(ctx, config, chosen, target);
}

/** S9: the prose sections of the guide, one task each (Claude); the document is assembled after validation. */
function planGuide(
  ctx: PipelineContext,
  config: StageConfig,
  chosen: ArchetypeCandidate,
  target: TargetBuild,
): PlanStep {
  const open = S9_SECTIONS.find((s) => ctx.result(sectionKey(s)) === undefined);
  const progression = ProgressionPlan.safeParse(ctx.result(S6_PLAN_KEY));
  const gear = GearPlan.safeParse(ctx.result(S7_PLAN_KEY));
  const crafting = z.object({ plans: z.array(CraftingPlan) }).safeParse(ctx.result(S8_PLAN_KEY));
  if (!progression.success || !gear.success || !crafting.success) {
    return {
      kind: "blocked",
      error: {
        code: "invalid_plans",
        message: "The stored plans of S6 to S8 are unreadable. Redo the stage that wrote them.",
      },
    };
  }
  if (open !== undefined) {
    const plans = {
      progression: JSON.parse(JSON.stringify(progression.data)) as JsonValue,
      gear: JSON.parse(JSON.stringify(gear.data)) as JsonValue,
      crafting: JSON.parse(JSON.stringify(crafting.data)) as JsonValue,
    };
    // Research comes just before the section it serves, so the writer sees its findings (ADR-0006).
    const research = config.s9?.research;
    if (
      research !== undefined &&
      isResearched(config, open) &&
      researchAnswer(ctx, open) === undefined
    ) {
      return { kind: "task", spec: researchTask(ctx, config, research, open, { chosen, plans }) };
    }
    return { kind: "task", spec: sectionTask(ctx, config, open, { chosen, target, plans }) };
  }
  // The detail pass: one small task per stage, gear tier, gear slot and crafting plan.
  if (config.s9 !== undefined) {
    const detailPlans = {
      progression: progression.data,
      gear: gear.data,
      crafting: crafting.data.plans,
    };
    const next = detailItems(detailPlans).find((i) => ctx.result(i.key) === undefined);
    if (next !== undefined) {
      return { kind: "task", spec: detailTask(ctx, config, next, { plans: detailPlans, target }) };
    }
  }
  if (ctx.result(S10_CRITIC_KEY) === undefined) {
    const critic = criticTask(ctx, config, {
      chosen,
      target,
      mainSkillId: mainSkillOfRun(ctx),
      detailPass: config.s9 !== undefined,
    });
    if (typeof critic === "string") {
      return { kind: "blocked", error: { code: "draft_unreadable", message: critic } };
    }
    return { kind: "task", spec: critic };
  }
  // The quality judge: one task per section the rubric asks questions about (G7).
  const rubric = config.s9?.rubric;
  const unjudged = judgedSections(rubric).find((sec) => ctx.result(qualityKey(sec)) === undefined);
  if (rubric !== undefined && unjudged !== undefined) {
    let draft: GuideDraft;
    try {
      draft = assembleDraft(ctx, {
        chosen,
        target,
        mainSkillId: mainSkillOfRun(ctx),
        detailPass: true,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { kind: "blocked", error: { code: "draft_unreadable", message } };
    }
    return { kind: "task", spec: qualityTask(ctx, config, rubric, unjudged, draft) };
  }
  if (!reportIsCurrent(ctx))
    return validateStep(
      {
        chosen,
        target,
        mainSkillId: mainSkillOfRun(ctx),
        detailPass: config.s9 !== undefined,
        ...(rubric === undefined ? {} : { rubric }),
        ...(config.s6?.stages === undefined ? {} : { stageTable: config.s6.stages }),
      },
      config.s10,
    );
  if (config.s10 === undefined) {
    return {
      kind: "blocked",
      error: {
        code: "s10_not_configured",
        message:
          "S10 needs the gate settings (config/agents/stages.json, block s10). S0 to S10 are done; their results are stored with the run.",
      },
    };
  }
  const after = afterReport(ctx, config.s10.maxReturnsPerStage);
  if (after !== null) return after;
  if (ctx.result(S11_GUIDE_KEY) !== undefined) return { kind: "done" };
  if (config.s11 === undefined) {
    return {
      kind: "blocked",
      error: {
        code: "s11_not_configured",
        message:
          "S11 needs the scoring settings (config/agents/stages.json, block s11). S0 to S10 are done and the guide passed validation; the results are stored with the run.",
      },
    };
  }
  return publishStep(ctx, config.s11, config.promptVersion);
}

/** The main skill of the run: the player's pick or the S0 choice; both exist once S1 has run. */
function mainSkillOfRun(ctx: PipelineContext): string {
  if (ctx.run.request.mainSkillId !== undefined) return ctx.run.request.mainSkillId;
  return SkillChoice.parse(ctx.result(S0_SKILL_KEY)).mainSkillId;
}

/** Craft tasks of S8, known once the gear plan is stored. */
function craftTaskCount(ctx: PipelineContext): number {
  const gear = GearPlan.safeParse(ctx.result(S7_PLAN_KEY));
  if (!gear.success) return 0;
  const slots = craftSlotsOf(gear.data);
  return typeof slots === "string" ? 0 : slots.length;
}

/** Detail tasks of S9, known once the plans of S6 to S8 are stored. */
function detailTaskCount(ctx: PipelineContext, config: StageConfig): number {
  if (config.s9 === undefined) return 0;
  const progression = ProgressionPlan.safeParse(ctx.result(S6_PLAN_KEY));
  const gear = GearPlan.safeParse(ctx.result(S7_PLAN_KEY));
  const crafting = z.object({ plans: z.array(CraftingPlan) }).safeParse(ctx.result(S8_PLAN_KEY));
  if (!progression.success || !gear.success || !crafting.success) return 0;
  return detailItems({
    progression: progression.data,
    gear: gear.data,
    crafting: crafting.data.plans,
  }).length;
}

/** The player's own pick skips S0, so it gets the same checks here. */
function presetSkillProblem(
  ctx: PipelineContext,
  mainSkillId: string,
  config: StageConfig,
): string | undefined {
  const gem = ctx.catalog.get({ kind: "gem", id: mainSkillId });
  if (gem === undefined) {
    return `Main skill ${mainSkillId} is not in data release ${ctx.catalog.dataReleaseId}.`;
  }
  const kind = (gem.entity as { kind?: string }).kind;
  if (kind !== undefined && config.supportGemKinds.includes(kind)) {
    return `Main skill ${mainSkillId} is a support gem and cannot be the main skill.`;
  }
  if (ctx.run.request.exclusions.some((x) => x.kind === "gem" && x.id === mainSkillId)) {
    return `Main skill ${mainSkillId} is on the player's exclusion list.`;
  }
  return undefined;
}
