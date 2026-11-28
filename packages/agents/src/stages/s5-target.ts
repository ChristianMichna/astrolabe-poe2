import { z } from "zod";
import type { SkillProfile } from "@astrolabe/contracts/build";
import {
  type ArchetypeCandidate,
  ArchetypeEvaluation,
  type BuildState,
  type Finding,
  Rationale,
  SkillSetup,
  TargetBuild,
} from "@astrolabe/contracts/build";
import type { DataRelease, PassiveNode } from "@astrolabe/contracts/catalog";
import { PassiveNodeId, type JsonValue } from "@astrolabe/contracts/common";
import type { StageConfig } from "../config.js";
import { defineTask, type AnyTaskSpec, type PipelineContext, type PlanStep } from "../pipeline.js";
import { S5_GEMS, S5_STEER } from "../prompts.js";
import { requestContext } from "./context.js";
import { rejectedFindings } from "./s2-candidates.js";
import { S3_KEY } from "./s3-evaluate.js";

export const S5_GEMS_KEY = "S5.gems";
export const S5_STEER_KEY = "S5.steer";
export const S5_TREE_KEY = "S5.tree";
export const S5_TARGET_KEY = "S5.target";

/** Size of the endgame build, read from the data release. */
export interface TargetSize {
  level: number;
  passivePoints: number;
  /** Ascendancy points of the release (PoB's total limit); absent when the release lacks them. */
  ascendancyPoints?: number;
}

/** S5 settings (profiles, objective) with the size from the release. */
export type S5Config = NonNullable<StageConfig["s5"]> & TargetSize;

/**
 * Level and node budget of the endgame build from the release facts: the
 * main tree gets `perLevel` points per level from `fromLevel` to the maximum
 * level, quest weapon set points come on top (PoB counts both into the limit).
 * Missing facts are an error message, never a default.
 */
export function targetSize(release: DataRelease | undefined): TargetSize | string {
  const max = release?.maxCharacterLevel;
  const points = release?.passivePoints;
  if (release === undefined || max === undefined || points === undefined) {
    const missing = [
      ...(release === undefined ? ["the release record"] : []),
      ...(max === undefined ? ["maxCharacterLevel"] : []),
      ...(points === undefined ? ["passivePoints"] : []),
    ].join(" and ");
    return `Data release ${release?.id ?? "(unknown)"} lacks ${missing}; S5 cannot size the endgame build. A newer data release is needed.`;
  }
  if (points.mainTree.fromLevel > max.value) {
    return `Data release ${release.id} grants main tree points from level ${points.mainTree.fromLevel}, above its maximum level ${max.value}; the release facts are inconsistent.`;
  }
  const levels = max.value - points.mainTree.fromLevel + 1;
  const weaponSet = points.weaponSetByAct.acts.reduce((sum, a) => sum + a.points, 0);
  return {
    level: max.value,
    passivePoints: levels * points.mainTree.perLevel + weaponSet,
    ...(points.ascendancy === undefined ? {} : { ascendancyPoints: points.ascendancy.points }),
  };
}

export const GemSetupSubmission = z.object({
  skills: z.array(SkillSetup).min(1),
  rationale: z.array(Rationale).min(1),
});
export type GemSetupSubmission = z.infer<typeof GemSetupSubmission>;

/** The S3 skeleton of the chosen candidate: class, ascendancy and the measured starting point. */
export function chosenEvaluation(
  ctx: PipelineContext,
  candidateKey: string,
): ArchetypeEvaluation | undefined {
  const all = ctx.result(S3_KEY);
  if (!Array.isArray(all)) return undefined;
  for (const entry of all) {
    const parsed = ArchetypeEvaluation.safeParse(entry);
    if (parsed.success && parsed.data.candidateKey === candidateKey) return parsed.data;
  }
  return undefined;
}

/** The skeleton as the target starts: the candidate's class, the final skills, an empty tree. */
export function targetStart(
  skeleton: BuildState,
  setup: GemSetupSubmission,
  s5: S5Config,
): BuildState {
  return {
    ...skeleton,
    level: s5.level,
    tree: { allocated: [], ascendancy: [] },
    skills: setup.skills,
  };
}

/** S5 part 1: the skill gem setup, checked against the exclusions and measured with PoB. */
export function gemTask(
  ctx: PipelineContext,
  config: StageConfig,
  s5: S5Config,
  chosen: ArchetypeCandidate,
  evaluation: ArchetypeEvaluation,
): AnyTaskSpec {
  return defineTask<GemSetupSubmission>({
    key: S5_GEMS_KEY,
    type: "S5.gems",
    promptVersion: config.promptVersion,
    instructions: S5_GEMS(ctx.run.request.mainSkillId !== undefined),
    context: {
      request: requestContext(ctx),
      chosen,
      skeletonEvaluation: JSON.parse(JSON.stringify(evaluation)) as JsonValue,
    },
    schema: GemSetupSubmission,
    allowedTools: ["catalog_search", "catalog_get", "calc_evaluate"],
    entities: (s) => [
      ...s.skills.flatMap((setup, i) => [
        { path: `/skills/${i}/gem/gemId`, ref: { kind: "gem" as const, id: setup.gem.gemId } },
        ...setup.supports.map((g, j) => ({
          path: `/skills/${i}/supports/${j}/gemId`,
          ref: { kind: "gem" as const, id: g.gemId },
        })),
      ]),
      ...s.rationale.flatMap((r, i) =>
        r.subject === undefined ? [] : [{ path: `/rationale/${i}/subject`, ref: r.subject }],
      ),
    ],
    richText: (s) =>
      s.rationale.map((r, i) => ({ path: `/rationale/${i}/reason`, text: r.reason })),
    check: async (s, checkCtx) => {
      const findings: Finding[] = [];
      const mains = s.skills.filter((x) => x.role === "main");
      if (mains.length !== 1) {
        findings.push({
          gate: "G3",
          severity: "error",
          code: "main_skill_count",
          message: "Exactly one setup must have role main.",
          path: "/skills",
        });
      }
      const wanted = checkCtx.run.request.mainSkillId;
      const main = mains[0];
      if (wanted !== undefined && main !== undefined && main.gem.gemId !== wanted) {
        findings.push({
          gate: "G3",
          severity: "error",
          code: "main_skill_mismatch",
          message: "The main setup must use the player's main skill.",
          path: `/skills/${s.skills.indexOf(main)}/gem/gemId`,
          entity: { kind: "gem", id: wanted },
        });
      }
      findings.push(
        ...rejectedFindings(
          checkCtx,
          s.skills.flatMap((x, i) => [
            { path: `/skills/${i}/gem/gemId`, ref: { kind: "gem" as const, id: x.gem.gemId } },
            ...x.supports.map((g, j) => ({
              path: `/skills/${i}/supports/${j}/gemId`,
              ref: { kind: "gem" as const, id: g.gemId },
            })),
          ]),
        ),
      );
      if (findings.length > 0) return findings;
      const outcomes = await checkCtx.calc.calculate({
        state: targetStart(evaluation.skeleton, s, s5),
        profiles: s5.calcProfiles,
      });
      for (const [profile, outcome] of Object.entries(outcomes)) {
        if (outcome.status === "failed") {
          findings.push({
            gate: "G2",
            severity: "error",
            code: "calc_failed",
            message: `The engine could not calculate this setup (profile ${profile}): ${outcome.error.message}`,
            path: "/skills",
          });
        }
      }
      return findings;
    },
  });
}

/** What a player's comment on the tree turns into: constraints for the tree search. */
export const TreeSteer = z.object({
  requiredNodeIds: z.array(PassiveNodeId).max(30).default([]),
  forbiddenNodeIds: z.array(PassiveNodeId).max(60).default([]),
  priorityNodeIds: z.array(PassiveNodeId).max(60).default([]),
  rationale: z.array(Rationale).min(1),
});
export type TreeSteer = z.infer<typeof TreeSteer>;

/** S5 part 2a: only after a comment on the tree, Claude turns it into node constraints. */
export function steerTask(
  ctx: PipelineContext,
  config: StageConfig,
  chosen: ArchetypeCandidate,
  setup: GemSetupSubmission,
  playerComments: readonly string[],
): AnyTaskSpec {
  return defineTask<TreeSteer>({
    key: S5_STEER_KEY,
    type: "S5.steer",
    promptVersion: config.promptVersion,
    instructions: S5_STEER,
    context: {
      request: requestContext(ctx),
      chosen,
      skills: JSON.parse(JSON.stringify(setup.skills)) as JsonValue,
      // Every comment so far: the constraints stay when the gems are chosen again.
      playerComments: [...playerComments],
    },
    schema: TreeSteer,
    allowedTools: ["catalog_search", "catalog_get"],
    entities: (s) => [
      ...s.requiredNodeIds.map((id, i) => ({
        path: `/requiredNodeIds/${i}`,
        ref: { kind: "passiveNode" as const, id },
      })),
      ...s.forbiddenNodeIds.map((id, i) => ({
        path: `/forbiddenNodeIds/${i}`,
        ref: { kind: "passiveNode" as const, id },
      })),
      ...s.priorityNodeIds.map((id, i) => ({
        path: `/priorityNodeIds/${i}`,
        ref: { kind: "passiveNode" as const, id },
      })),
      ...s.rationale.flatMap((r, i) =>
        r.subject === undefined ? [] : [{ path: `/rationale/${i}/subject`, ref: r.subject }],
      ),
    ],
    richText: (s) =>
      s.rationale.map((r, i) => ({ path: `/rationale/${i}/reason`, text: r.reason })),
    check: (s, checkCtx) => {
      const findings: Finding[] = [];
      const forbidden = new Set<string>(s.forbiddenNodeIds);
      for (const [i, id] of s.requiredNodeIds.entries()) {
        if (forbidden.has(id)) {
          findings.push({
            gate: "G3",
            severity: "error",
            code: "steer_conflict",
            message: `Node ${id} is both required and forbidden.`,
            path: `/requiredNodeIds/${i}`,
            entity: { kind: "passiveNode", id },
          });
        }
      }
      const lists = [
        ["requiredNodeIds", s.requiredNodeIds],
        ["forbiddenNodeIds", s.forbiddenNodeIds],
        ["priorityNodeIds", s.priorityNodeIds],
      ] as const;
      for (const [name, ids] of lists) {
        for (const [i, id] of ids.entries()) {
          const entry = checkCtx.catalog.get({ kind: "passiveNode", id });
          const node = entry?.entity as PassiveNode | undefined;
          // Unknown ids are the catalog gate's finding; here only nodes outside the main tree.
          if (
            node !== undefined &&
            (node.ascendancyId !== undefined || node.classStartFor.length > 0)
          ) {
            findings.push({
              gate: "G3",
              severity: "error",
              code: "steer_not_main_tree",
              message: `Node ${id} is not a node of the main passive tree.`,
              path: `/${name}/${i}`,
              entity: { kind: "passiveNode", id },
            });
          }
        }
      }
      const excluded = new Set(
        checkCtx.run.request.exclusions.filter((e) => e.kind === "passiveNode").map((e) => e.id),
      );
      for (const [i, id] of s.requiredNodeIds.entries()) {
        if (excluded.has(id)) {
          findings.push({
            gate: "G3",
            severity: "error",
            code: "steer_excluded",
            message: `The player excluded node ${id}; it cannot be required.`,
            path: `/requiredNodeIds/${i}`,
            entity: { kind: "passiveNode", id },
          });
        }
      }
      const forbiddenSet = new Set<string>(s.forbiddenNodeIds);
      for (const [i, id] of s.priorityNodeIds.entries()) {
        if (forbiddenSet.has(id)) {
          findings.push({
            gate: "G3",
            severity: "error",
            code: "steer_conflict",
            message: `Node ${id} is both prioritised and forbidden.`,
            path: `/priorityNodeIds/${i}`,
            entity: { kind: "passiveNode", id },
          });
        }
      }
      findings.push(
        ...rejectedFindings(
          checkCtx,
          s.requiredNodeIds.map((id, i) => ({
            path: `/requiredNodeIds/${i}`,
            ref: { kind: "passiveNode" as const, id },
          })),
        ),
      );
      return Promise.resolve(findings);
    },
  });
}

/** S5 part 2: the endgame tree for the chosen skills, optimised by PoB as a background job. */
export function treeJob(
  ctx: PipelineContext,
  s5: S5Config,
  profile: SkillProfile,
  chosen: ArchetypeCandidate,
  evaluation: ArchetypeEvaluation,
  setup: GemSetupSubmission,
  steer?: TreeSteer,
): PlanStep {
  const target = ctx.target;
  if (target === undefined) {
    return {
      kind: "blocked",
      error: {
        code: "target_unavailable",
        message:
          "S5 optimises the endgame tree with Path of Building. This server runs without the PoB calculation service, so the target build cannot be built.",
      },
    };
  }
  return {
    kind: "job",
    key: S5_TREE_KEY,
    type: "S5.tree",
    label: "optimising the endgame passive tree with Path of Building",
    run: async (runCtx) => {
      const result = await target.optimizeTree({
        request: runCtx.run.request,
        profile,
        candidate: chosen,
        state: targetStart(evaluation.skeleton, setup, s5),
        passivePoints: s5.passivePoints,
        ...(s5.ascendancyPoints === undefined ? {} : { ascendancyPoints: s5.ascendancyPoints }),
        ...(steer === undefined
          ? {}
          : {
              steer: {
                required: steer.requiredNodeIds,
                forbidden: steer.forbiddenNodeIds,
                priority: steer.priorityNodeIds,
              },
            }),
      });
      return JSON.parse(JSON.stringify(result)) as JsonValue;
    },
  };
}

/** S5 part 3: the validated target, assembled from the measured tree and the gem rationale. */
export function targetStep(
  chosen: ArchetypeCandidate,
  tree: { state: unknown; calcs: unknown },
  setup: GemSetupSubmission,
  steer?: TreeSteer,
): PlanStep {
  return {
    kind: "server",
    key: S5_TARGET_KEY,
    type: "S5.target",
    run: async () => {
      const parsed = TargetBuild.safeParse({
        candidateKey: chosen.key,
        state: tree.state,
        calcs: tree.calcs,
        rationale: [...setup.rationale, ...(steer?.rationale ?? [])],
      });
      if (!parsed.success) {
        throw new Error("The stored S5 tree is not a valid target build", { cause: parsed.error });
      }
      return Promise.resolve(JSON.parse(JSON.stringify(parsed.data)) as JsonValue);
    },
  };
}
