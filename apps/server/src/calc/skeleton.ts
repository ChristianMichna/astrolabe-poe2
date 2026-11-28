import { isMinionSkill, minionMetricFloors, minionWeights } from "@astrolabe/agents";
import type {
  MinionStatsConfig,
  ProgressionPort,
  ProgressionRequest,
  ProgressionStageTree,
  SkeletonPort,
  SkeletonRequest,
  TargetPort,
  TargetRequest,
  TargetTree,
} from "@astrolabe/agents";
import {
  optimizeProgression,
  optimizeTree,
  TreeGraph,
  createPobTreeEvaluator,
  type CalcRequester as OptimizerPool,
  type OptimizerConfig,
  type TreeOptimizeResult,
} from "@astrolabe/optimizer";
import { ArchetypeEvaluation, BuildState, type EquippedItem } from "@astrolabe/contracts/build";
import type {
  Ascendancy,
  BaseItem,
  CharacterClass,
  PassiveNode,
} from "@astrolabe/contracts/catalog";
import type { AscendancyId, PassiveNodeId } from "@astrolabe/contracts/common";
import type { CalcProfileId } from "@astrolabe/contracts/common";
import type { CalcPort } from "../ports/calc.js";
import type { CatalogPort } from "../ports/catalog.js";
import type { Logger } from "../logger.js";
import { scaleGemLevels } from "./gem-levels.js";
import type { PobCalc } from "./pob-calc.js";

/** Settings of the skeleton build (config/agents/stages.json → s3). */
export interface SkeletonSettings {
  level: number;
  passivePoints: number;
  gemLevel: number;
  supportCount: number;
  calcProfiles: readonly CalcProfileId[];
  objective: { weights: Record<string, number>; floors: Record<string, number> };
  /** See `s3.placeholderWeapon` in config/agents/stages.json. */
  placeholderWeapon?: { slot: string; rarity: string } | undefined;
}

/** Settings of the progression (config/agents/stages.json → s6, without the stage table). */
export interface ProgressionSettings {
  calcProfiles: readonly CalcProfileId[];
  objective: {
    weights: Record<string, number>;
    floors: Record<string, number>;
    floorsFromMetrics?: Record<string, string>;
  };
}

/** Settings of the endgame target tree (config/agents/stages.json → s5, without level and points). */
/** Upper bound of ascendancy search rounds that ban nodes PoB does not calculate. */
const DEFAULT_UNSUPPORTED_ROUNDS = 4;

export interface TargetSettings {
  calcProfiles: readonly CalcProfileId[];
  objective: {
    weights: Record<string, number>;
    floors: Record<string, number>;
    floorsFromMetrics?: Record<string, string>;
  };
  /** See `s5.unsupportedMods` in config/agents/stages.json; `avoid` when absent. */
  unsupportedMods?: "avoid" | "accept";
  /** See `s5.unsupportedMaxRounds`; searches that may repeat after banning nodes. */
  unsupportedMaxRounds?: number;
}

export interface PobSkeletonOptions {
  pob: Pick<PobCalc, "withBuild">;
  /** The pool the optimizer measures with (same one PobCalc uses). */
  pool: OptimizerPool;
  /** Persisting calc port, so calc references of the evaluation stay valid. */
  calc: CalcPort;
  catalog: CatalogPort;
  optimizerConfig: OptimizerConfig;
  settings: SkeletonSettings;
  /** `minion` of config/agents/stages.json: minion builds measure their damage with PoB's minion stats. */
  minion?: MinionStatsConfig;
  /** Present when S5 is configured. */
  target?: TargetSettings;
  /** Present when S6 is configured. */
  progression?: ProgressionSettings;
  logger: Logger;
  /** Replaceable in tests. */
  optimize?: typeof optimizeTree;
  optimizeStages?: typeof optimizeProgression;
}

/**
 * S3 on Path of Building: main skill with the profile's first supports on the
 * candidate's class and ascendancy, then a short tree optimisation within
 * the configured point budget, then the full measurement per calc profile.
 * The skeleton wears at most a placeholder weapon (`s3.placeholderWeapon`); gear comes in later stages.
 */
export class PobSkeleton implements SkeletonPort, TargetPort, ProgressionPort {
  private readonly graphs = new Map<string, TreeGraph>();
  private readonly weapons = new Map<string, EquippedItem[]>();

  constructor(private readonly options: PobSkeletonOptions) {}

  /**
   * The objective of a build: for a minion skill the stats PoB measures its damage with
   * (`minion` in config/agents/stages.json), otherwise the configured one.
   */
  private objectiveFor<
    T extends {
      weights: Record<string, number>;
      floors: Record<string, number>;
      floorsFromMetrics?: Record<string, string> | undefined;
    },
  >(objective: T, mainSkillId: string): T {
    const { minion, catalog } = this.options;
    if (minion === undefined || !isMinionSkill(catalog, mainSkillId, minion)) return objective;
    return {
      ...objective,
      weights: minionWeights(minion, objective.weights),
      floors: minionWeights(minion, objective.floors),
      ...(objective.floorsFromMetrics === undefined
        ? {}
        : { floorsFromMetrics: minionMetricFloors(minion, objective.floorsFromMetrics) }),
    };
  }

  /**
   * The weapon the skeleton wears so that attack skills deal damage: of every weapon class the
   * slot accepts, the base with the lowest requirement; the one PoB measures best for the main
   * skill wins, but only if it beats the build without a weapon (spells and minions need none).
   */
  private async placeholderItems(
    base: BuildState,
    job: {
      request: SkeletonRequest["request"];
      profile: SkeletonRequest["profile"];
      calcProfile: CalcProfileId;
    },
  ): Promise<EquippedItem[]> {
    const wanted = this.options.settings.placeholderWeapon;
    if (wanted === undefined) return [];
    const key = `${wanted.slot}|${job.profile.mainSkillId}`;
    const known = this.weapons.get(key);
    if (known !== undefined) return known;
    const { catalog, logger } = this.options;
    const slot = catalog.release?.itemSlots?.slots.find((s) => s.id === wanted.slot);
    if (slot === undefined) {
      throw new Error(`The release has no item slot ${wanted.slot} for the placeholder weapon`);
    }
    const rarities = catalog.release?.rarities?.rarities ?? [];
    if (!rarities.some((r) => r.id === wanted.rarity)) {
      throw new Error(`The release has no rarity ${wanted.rarity} for the placeholder weapon`);
    }
    const weights = this.objectiveFor(
      this.options.settings.objective,
      job.profile.mainSkillId,
    ).weights;
    const score = async (items: EquippedItem[]): Promise<number> => {
      const state = BuildState.parse({ ...base, items });
      const outcomes = await this.options.calc.calculate({
        state,
        profiles: [job.calcProfile],
        overrides: job.request.calcOverrides,
      });
      const outcome = outcomes[job.calcProfile];
      if (outcome?.status !== "ok") {
        throw new Error(
          `The engine could not measure the placeholder weapon (profile ${job.calcProfile})`,
        );
      }
      const loaded = await this.options.calc.getResult(outcome.calcId);
      if (loaded === undefined)
        throw new Error(`The result ${outcome.calcId} of the placeholder weapon is gone`);
      return Object.entries(weights).reduce((sum, [stat, w]) => {
        const value = loaded.stats[stat];
        if (value === undefined) {
          throw new Error(`The engine reported no ${stat}, so no placeholder weapon can be chosen`);
        }
        return sum + w * value;
      }, 0);
    };
    const bases = catalog.list("baseItem").map((e) => e.entity as BaseItem);
    let best: { score: number; items: EquippedItem[] } = { score: await score([]), items: [] };
    for (const itemClass of slot.itemClasses) {
      const lowest = bases
        .filter((b) => b.itemClass === itemClass && !b.tags.includes("unique"))
        .sort(
          (a, b) =>
            (a.requirements.level ?? 0) - (b.requirements.level ?? 0) || a.id.localeCompare(b.id),
        )[0];
      if (lowest === undefined) continue;
      const items: EquippedItem[] = [
        {
          slot: wanted.slot,
          item: {
            kind: "crafted",
            baseItemId: lowest.id,
            rarity: wanted.rarity,
            mods: [],
            socketables: [],
          },
        },
      ];
      const value = await score(items);
      if (value > best.score) best = { score: value, items };
    }
    logger.info("placeholder weapon", {
      mainSkillId: job.profile.mainSkillId,
      chosen: best.items[0]?.item.kind === "crafted" ? best.items[0].item.baseItemId : null,
    });
    this.weapons.set(key, best.items);
    return best.items;
  }

  async evaluate(input: SkeletonRequest): Promise<ArchetypeEvaluation> {
    const { settings, catalog } = this.options;
    const { candidate, profile } = input;
    if (catalog.dataReleaseId !== input.request.dataReleaseId) {
      throw new Error(
        `Request targets ${input.request.dataReleaseId} but the loaded catalog is ${catalog.dataReleaseId}`,
      );
    }
    const empty = BuildState.parse({
      classId: candidate.classId,
      ascendancyId: candidate.ascendancyId,
      level: settings.level,
      tree: { allocated: [] },
      skills: [
        {
          key: "main",
          role: "main",
          gem: { gemId: profile.mainSkillId, level: settings.gemLevel },
          supports: profile.supportCandidates
            .slice(0, settings.supportCount)
            .map((gemId) => ({ gemId, level: settings.gemLevel })),
        },
      ],
      items: [],
      config: {},
    });
    const withWeapon = BuildState.parse({
      ...empty,
      items: await this.placeholderItems(empty, {
        request: input.request,
        profile,
        calcProfile: settings.calcProfiles[0] as CalcProfileId,
      }),
    });
    const result = await this.optimizeFrom(withWeapon, {
      request: input.request,
      profile,
      candidateKey: candidate.key,
      classId: candidate.classId,
      budget: settings.passivePoints,
      objective: this.objectiveFor(settings.objective, profile.mainSkillId),
      calcProfile: settings.calcProfiles[0] as CalcProfileId,
    });
    const skeleton = BuildState.parse({
      ...withWeapon,
      tree: { allocated: result.allocated.map((nodeId) => ({ nodeId })), ascendancy: [] },
    });
    const calcs = await this.options.calc.calculate({
      state: skeleton,
      profiles: settings.calcProfiles,
      overrides: input.request.calcOverrides,
    });
    return ArchetypeEvaluation.parse({ candidateKey: candidate.key, skeleton, calcs });
  }

  /** S5: optimises the endgame tree of the chosen build and measures it with every target profile. */
  async optimizeTree(input: TargetRequest): Promise<TargetTree> {
    const settings = this.options.target;
    if (settings === undefined)
      throw new Error("The target tree settings (stages.json s5) are not configured");
    if (this.options.catalog.dataReleaseId !== input.request.dataReleaseId) {
      throw new Error(
        `Request targets ${input.request.dataReleaseId} but the loaded catalog is ${this.options.catalog.dataReleaseId}`,
      );
    }
    const start = BuildState.parse({ ...input.state, tree: { allocated: [], ascendancy: [] } });
    const job = {
      request: input.request,
      profile: input.profile,
      candidateKey: input.candidate.key,
      classId: input.candidate.classId,
      budget: input.passivePoints,
      objective: this.objectiveFor(settings.objective, input.profile.mainSkillId),
      calcProfile: settings.calcProfiles[0] as CalcProfileId,
    };
    const result = await this.optimizeMainTree(start, job, settings);
    // Checked before the ascendancy search, which would spend a whole search on a failed target.
    if (!result.feasible) {
      throw new Error(
        `The tree optimisation could not meet the objective floors: ${JSON.stringify(result.violations)}`,
      );
    }
    const allocated = result.allocated.map((nodeId) => ({ nodeId }));
    const ascendancy =
      input.ascendancyPoints === undefined || input.candidate.ascendancyId === undefined
        ? []
        : await this.optimizeAscendancy(
            BuildState.parse({ ...start, tree: { allocated, ascendancy: [] } }),
            input.candidate.ascendancyId,
            input.ascendancyPoints,
            {
              request: input.request,
              profile: input.profile,
              objective: this.objectiveFor(settings.objective, input.profile.mainSkillId),
              calcProfile: settings.calcProfiles[0] as CalcProfileId,
            },
          );
    const state = BuildState.parse({ ...start, tree: { allocated, ascendancy } });
    const calcs = await this.options.calc.calculate({
      state,
      profiles: settings.calcProfiles,
      overrides: input.request.calcOverrides,
    });
    // The target is the validated endgame build: an incomplete tree or a failed measurement must
    // show up as a failed job, never as a target with missing numbers.
    for (const [profileId, outcome] of Object.entries(calcs)) {
      if (outcome.status === "failed") {
        throw new Error(
          `The engine could not measure the target tree (profile ${profileId}): ${outcome.error.message}`,
        );
      }
    }
    return { state, calcs };
  }

  /** S6: orders the target tree into nested stages and measures each stage. */
  async optimizeProgression(input: ProgressionRequest): Promise<ProgressionStageTree[]> {
    const settings = this.options.progression;
    if (settings === undefined) {
      throw new Error("The progression settings (stages.json s6) are not configured");
    }
    if (this.options.catalog.dataReleaseId !== input.request.dataReleaseId) {
      throw new Error(
        `Request targets ${input.request.dataReleaseId} but the loaded catalog is ${this.options.catalog.dataReleaseId}`,
      );
    }
    const base = BuildState.parse({
      ...input.target.state,
      tree: { allocated: [], ascendancy: [] },
    });
    const graph = this.graphFor(input.candidate.classId);
    const targetNodes = input.target.state.tree.allocated.map((n) => n.nodeId as PassiveNodeId);
    const result = await this.options.pob.withBuild(base, (handle) =>
      (this.options.optimizeStages ?? optimizeProgression)({
        graph,
        target: targetNodes,
        stages: input.stages.map((s) => ({ key: s.key, budget: s.budget })),
        objective: this.objectiveFor(settings.objective, input.profile.mainSkillId),
        evaluator: createPobTreeEvaluator({
          pool: this.options.pool,
          handle,
          profile: settings.calcProfiles[0] as CalcProfileId,
          baseAllocated: [],
          overrides: input.request.calcOverrides,
        }),
        config: this.options.optimizerConfig,
        priorityNodeIds: input.profile.relevantNodes.filter((id) => graph.has(id)),
      }),
    );
    if (result.failedEvaluationCount > 0) {
      this.options.logger.info("progression had failed evaluations", {
        candidate: input.candidate.key,
        failedEvaluations: result.failedEvaluationCount,
        firstFailures: result.failedEvaluations.slice(0, 3),
      });
    }
    const last = result.stages.at(-1);
    if (last === undefined || last.allocated.length < targetNodes.length) {
      throw new Error(
        `The last stage ends with ${last?.allocated.length ?? 0} of ${targetNodes.length} target nodes; raise its passive points`,
      );
    }
    const out: ProgressionStageTree[] = [];
    for (const stage of result.stages) {
      const level = input.stages.find((s) => s.key === stage.key)?.level;
      if (level === undefined) throw new Error(`Stage ${stage.key} has no level`);
      if (!stage.feasible) {
        throw new Error(
          `Stage ${stage.key} could not meet the objective floors: ${JSON.stringify(stage.violations)}`,
        );
      }
      // The gems of a stage are at the level its character level allows, not at the target's.
      const state = scaleGemLevels(
        BuildState.parse({
          ...base,
          level,
          tree: { allocated: stage.allocated.map((nodeId) => ({ nodeId })), ascendancy: [] },
        }),
        level,
        this.options.catalog,
      );
      const calcs = await this.options.calc.calculate({
        state,
        profiles: settings.calcProfiles,
        overrides: input.request.calcOverrides,
      });
      for (const [profileId, outcome] of Object.entries(calcs)) {
        if (outcome.status === "failed") {
          throw new Error(
            `The engine could not measure stage ${stage.key} (profile ${profileId}): ${outcome.error.message}`,
          );
        }
      }
      out.push({
        key: stage.key,
        state,
        allocationOrder: stage.allocationOrder,
        respecs: stage.respecs,
        unspent: stage.unspent,
        calcs,
      });
    }
    return out;
  }

  /**
   * The main tree of the target. With `unsupportedMods: avoid` each round measures the result and
   * bans the nodes whose mod texts PoB reports as not calculated, then searches again (the nodes
   * could not be told apart before, PoB reports the text only for a built tree).
   */
  private async optimizeMainTree(
    start: BuildState,
    job: Parameters<PobSkeleton["optimizeFrom"]>[1],
    settings: TargetSettings,
  ): Promise<TreeOptimizeResult> {
    const avoid = (settings.unsupportedMods ?? "avoid") === "avoid";
    const maxRounds = settings.unsupportedMaxRounds ?? DEFAULT_UNSUPPORTED_ROUNDS;
    const nodes = new Map<PassiveNodeId, PassiveNode>(
      this.options.catalog.list("passiveNode").map((e) => {
        const node = e.entity as PassiveNode;
        return [node.id, node];
      }),
    );
    const banned = new Set<PassiveNodeId>();
    let previous: readonly PassiveNodeId[] = [];
    for (let round = 0; ; round += 1) {
      // Later rounds continue from the previous tree minus the banned nodes (and what hung on them).
      const result = await this.optimizeFrom(start, job, [...banned], previous);
      if (!avoid) return result;
      if (!result.feasible) {
        if (banned.size === 0) return result;
        throw new Error(
          `The tree search found no feasible tree after banning the nodes ${JSON.stringify([...banned])} (their mods are not calculated by Path of Building)`,
        );
      }
      const state = BuildState.parse({
        ...start,
        tree: { allocated: result.allocated.map((nodeId) => ({ nodeId })), ascendancy: [] },
      });
      const unsupported = await this.unsupportedTexts(state, [], job);
      const triggers = new Map<PassiveNodeId, string[]>();
      const textless: PassiveNodeId[] = [];
      const matched = new Set<string>();
      for (const id of result.allocated) {
        const node = nodes.get(id);
        if (node === undefined) {
          throw new Error(`The tree search allocated the node ${id}, which is not in the catalog`);
        }
        const lines: string[] = [];
        for (const st of node.stats) {
          if (st.text === undefined) {
            textless.push(id);
            continue;
          }
          for (const line of statLines(st.text)) {
            if (!unsupported.has(line)) continue;
            if (!lines.includes(line)) lines.push(line);
            matched.add(line);
          }
        }
        if (lines.length > 0) triggers.set(id, lines);
      }
      if (textless.length > 0) {
        this.options.logger.warn("tree nodes without mod text cannot be checked against PoB", {
          candidate: job.candidateKey,
          nodes: textless,
        });
      }
      const unattributed = [...unsupported].filter((line) => !matched.has(line));
      if (unattributed.length > 0) {
        this.options.logger.warn("PoB does not calculate mod lines that match no tree node", {
          candidate: job.candidateKey,
          lines: unattributed,
        });
      }
      if (triggers.size === 0) return result;
      if (round + 1 >= maxRounds) {
        throw new Error(
          `The tree search still picks nodes whose mods Path of Building does not calculate after ${String(maxRounds)} rounds: ${JSON.stringify(Object.fromEntries(triggers))}`,
        );
      }
      this.options.logger.info("tree search avoids nodes PoB does not calculate", {
        candidate: job.candidateKey,
        nodes: [...triggers.keys()],
        lines: Object.fromEntries(triggers),
      });
      for (const id of triggers.keys()) banned.add(id);
      previous = result.allocated;
    }
  }

  /** Tree optimisation within a budget (from an empty tree, or from `warmStart`); logs when it ends incomplete. */
  private async optimizeFrom(
    start: BuildState,
    job: {
      request: SkeletonRequest["request"];
      profile: SkeletonRequest["profile"];
      candidateKey: string;
      classId: string;
      budget: number;
      objective: {
        weights: Record<string, number>;
        floors: Record<string, number>;
        floorsFromMetrics?: Record<string, string>;
      };
      calcProfile: CalcProfileId;
    },
    /** Nodes the search must not take besides the player's exclusions. */
    avoided: readonly PassiveNodeId[] = [],
    /**
     * Nodes to start from (the previous result without the avoided ones) instead of an empty tree.
     * The optimizer measures this tree as its base, so score scales come from it in later rounds.
     */
    warmStart: readonly PassiveNodeId[] = [],
  ): Promise<TreeOptimizeResult> {
    const graph = this.graphFor(job.classId);
    const excluded = [
      ...job.request.exclusions
        .filter((e) => e.kind === "passiveNode")
        .map((e) => e.id as PassiveNodeId),
      ...avoided,
    ];
    const optimize = this.options.optimize ?? optimizeTree;
    const startedAt = Date.now();
    const result: TreeOptimizeResult = await this.options.pob.withBuild(start, (handle) =>
      optimize({
        graph,
        allocated: connectedPart(graph, warmStart, new Set(excluded)),
        budget: job.budget,
        objective: job.objective,
        evaluator: createPobTreeEvaluator({
          pool: this.options.pool,
          handle,
          profile: job.calcProfile,
          baseAllocated: [],
          overrides: job.request.calcOverrides,
        }),
        config: this.options.optimizerConfig,
        priorityNodeIds: job.profile.relevantNodes.filter((id) => graph.has(id)),
        forbiddenNodeIds: excluded.filter((id) => graph.has(id)),
      }),
    );
    this.logSearch("main tree", job.candidateKey, result, startedAt, avoided.length);
    if (!result.feasible || result.failedEvaluationCount > 0) {
      this.options.logger.info("tree optimisation is incomplete", {
        candidate: job.candidateKey,
        feasible: result.feasible,
        violations: result.violations,
        failedEvaluations: result.failedEvaluationCount,
        firstFailures: result.failedEvaluations.slice(0, 3),
        stoppedBy: result.stoppedBy,
      });
    }
    return result;
  }

  /**
   * The ascendancy nodes to take on top of the finished main tree: a search in the ascendancy's
   * own graph with the release's point limit. The loaded build already has the main tree, so the
   * evaluator tracks the ascendancy nodes alone (its base is empty in that sense).
   */
  private async optimizeAscendancy(
    withMainTree: BuildState,
    ascendancyId: string,
    points: number,
    job: {
      request: SkeletonRequest["request"];
      profile: SkeletonRequest["profile"];
      objective: {
        weights: Record<string, number>;
        floors: Record<string, number>;
        floorsFromMetrics?: Record<string, string>;
      };
      calcProfile: CalcProfileId;
    },
  ): Promise<PassiveNodeId[]> {
    const entry = this.options.catalog.get({ kind: "ascendancy", id: ascendancyId });
    if (entry === undefined) throw new Error(`Ascendancy ${ascendancyId} is not in the catalog`);
    const startNodeId = (entry.entity as Ascendancy).startNodeId;
    if (startNodeId === undefined) {
      throw new Error(`Ascendancy ${ascendancyId} has no start node in the catalog`);
    }
    const nodes = this.options.catalog.list("passiveNode").map((e) => e.entity as PassiveNode);
    const graph = TreeGraph.buildAscendancy(nodes, ascendancyId as AscendancyId, startNodeId);
    const excluded = job.request.exclusions
      .filter((e) => e.kind === "passiveNode")
      .map((e) => e.id as PassiveNodeId);
    const optimize = this.options.optimize ?? optimizeTree;
    const avoid = (this.options.target?.unsupportedMods ?? "avoid") === "avoid";
    const banned = new Set<PassiveNodeId>(excluded);
    const maxRounds = this.options.target?.unsupportedMaxRounds ?? DEFAULT_UNSUPPORTED_ROUNDS;
    if (!avoid) {
      this.options.logger.info("ascendancy search accepts mods PoB does not calculate", {
        ascendancy: ascendancyId,
      });
    }
    // The main tree's own unsupported mods are no reason to ban an ascendancy node.
    const baseline = avoid ? await this.unsupportedTexts(withMainTree, [], job) : new Set<string>();
    // Each round searches without the nodes banned so far; a node is banned when PoB reports its
    // text as a mod it does not calculate. The rounds end when the result has none (or at the cap).
    for (let round = 0; ; round += 1) {
      const startedAt = Date.now();
      const result: TreeOptimizeResult = await this.options.pob.withBuild(withMainTree, (handle) =>
        optimize({
          graph,
          allocated: [],
          budget: points,
          objective: job.objective,
          evaluator: createPobTreeEvaluator({
            pool: this.options.pool,
            handle,
            profile: job.calcProfile,
            baseAllocated: [],
            overrides: job.request.calcOverrides,
          }),
          config: this.options.optimizerConfig,
          priorityNodeIds: job.profile.relevantNodes.filter((id) => graph.has(id)),
          forbiddenNodeIds: [...banned].filter((id) => graph.has(id)),
        }),
      );
      this.logSearch("ascendancy", ascendancyId, result, startedAt, round);
      this.checkAscendancyResult(result, ascendancyId);
      if (!avoid) return result.allocated;
      const unsupported = await this.unsupportedTexts(withMainTree, result.allocated, job);
      const chosen = result.allocated.map((id) => {
        const node = nodes.find((n) => n.id === id);
        if (node === undefined) throw new Error(`Ascendancy node ${id} is not in the catalog`);
        return node;
      });
      const textless = chosen.filter((n) => n.stats.some((st) => st.text === undefined));
      if (textless.length > 0) {
        // PoB cannot report such a node as unsupported, so the search cannot vouch for it.
        this.options.logger.warn("ascendancy nodes without a stat text cannot be checked", {
          ascendancy: ascendancyId,
          nodes: textless.map((n) => n.id),
        });
      }
      const triggers = new Map<PassiveNodeId, string[]>();
      const matched = new Set<string>();
      for (const node of chosen) {
        for (const st of node.stats) {
          if (st.text === undefined) continue;
          for (const line of statLines(st.text)) {
            if (!unsupported.has(line)) continue;
            matched.add(line);
            if (baseline.has(line)) continue;
            const known = triggers.get(node.id) ?? [];
            if (!known.includes(line)) triggers.set(node.id, [...known, line]);
          }
        }
      }
      // Every line PoB reports beyond the main tree must belong to a chosen node; otherwise the
      // texts do not match and "avoid" would silently do nothing.
      const unattributed = [...unsupported].filter((t) => !baseline.has(t) && !matched.has(t));
      if (unattributed.length > 0) {
        throw new Error(
          `Path of Building reports mods the ascendancy ${ascendancyId} nodes do not match by text: ${JSON.stringify(unattributed)}`,
        );
      }
      const bad = [...triggers.keys()];
      if (bad.length === 0) return result.allocated;
      if (round + 1 >= maxRounds) {
        throw new Error(
          `The ascendancy search still picks nodes whose mods Path of Building does not calculate after ${String(maxRounds)} rounds`,
        );
      }
      this.options.logger.info("ascendancy search avoids nodes PoB does not calculate", {
        ascendancy: ascendancyId,
        nodes: bad,
        lines: Object.fromEntries(triggers),
      });
      for (const id of bad) banned.add(id);
    }
  }

  /** One line per search: how many engine evaluations it took, why it stopped and how long it ran. */
  private logSearch(
    search: "main tree" | "ascendancy",
    key: string,
    result: TreeOptimizeResult,
    startedAt: number,
    /** Ascendancy: the ban round; main tree: how many nodes were banned before this search. */
    roundOrBanned?: number,
  ): void {
    this.options.logger.info("tree search finished", {
      search,
      key,
      ...(roundOrBanned === undefined
        ? {}
        : { [search === "main tree" ? "bannedNodes" : "round"]: roundOrBanned }),
      evaluations: result.evaluations,
      stoppedBy: result.stoppedBy,
      refineStoppedBy: result.refineStoppedBy,
      truncated: result.truncated,
      failedEvaluations: result.failedEvaluationCount,
      durationMs: Date.now() - startedAt,
    });
  }

  private checkAscendancyResult(result: TreeOptimizeResult, ascendancyId: string): void {
    if (!result.feasible) {
      throw new Error(
        `The ascendancy search could not meet the objective floors: ${JSON.stringify(result.violations)}`,
      );
    }
    if (result.failedEvaluationCount > 0) {
      // A search whose evaluations failed can end empty, which would look like "no ascendancy".
      if (result.allocated.length === 0) {
        throw new Error(
          `The engine could not evaluate any ascendancy node (first failures: ${JSON.stringify(result.failedEvaluations.slice(0, 3))})`,
        );
      }
      this.options.logger.warn("ascendancy search had failed evaluations", {
        ascendancy: ascendancyId,
        failedEvaluations: result.failedEvaluationCount,
        firstFailures: result.failedEvaluations.slice(0, 3),
      });
    }
  }

  /** The mod texts PoB reports as not calculated for the main tree plus these ascendancy nodes. */
  private async unsupportedTexts(
    withMainTree: BuildState,
    ascendancy: readonly PassiveNodeId[],
    job: { request: SkeletonRequest["request"]; calcProfile: CalcProfileId },
  ): Promise<Set<string>> {
    const state = BuildState.parse({
      ...withMainTree,
      tree: { ...withMainTree.tree, ascendancy: [...ascendancy] },
    });
    const outcomes = await this.options.calc.calculate({
      state,
      profiles: [job.calcProfile],
      overrides: job.request.calcOverrides,
    });
    const outcome = outcomes[job.calcProfile];
    if (outcome?.status !== "ok") {
      throw new Error(
        `The engine could not measure the ascendancy nodes (profile ${job.calcProfile})`,
      );
    }
    const loaded = await this.options.calc.getResult(outcome.calcId);
    if (loaded === undefined) {
      throw new Error(`The result ${outcome.calcId} of the ascendancy measurement is gone`);
    }
    return new Set(loaded.unsupportedMods);
  }

  private graphFor(classId: string): TreeGraph {
    const cached = this.graphs.get(classId);
    if (cached !== undefined) return cached;
    const entry = this.options.catalog.get({ kind: "characterClass", id: classId });
    if (entry === undefined) throw new Error(`Class ${classId} is not in the catalog`);
    const nodes = this.options.catalog.list("passiveNode").map((e) => e.entity as PassiveNode);
    const graph = TreeGraph.build(nodes, (entry.entity as CharacterClass).startNodeId);
    this.graphs.set(classId, graph);
    return graph;
  }
}

/**
 * The part of `nodes` that still hangs on the class start without the `blocked` nodes, so a search
 * can continue from a tree whose nodes were banned (nodes cut off from the start are dropped).
 */
export function connectedPart(
  graph: TreeGraph,
  nodes: readonly PassiveNodeId[],
  blocked: ReadonlySet<string>,
): PassiveNodeId[] {
  const wanted = new Set<string>(nodes.map(String));
  const seen = new Set<string>([graph.start]);
  const order: PassiveNodeId[] = [];
  const queue = [graph.start];
  for (let i = 0; i < queue.length; i += 1) {
    for (const to of graph.neighbors(queue[i] as string)) {
      if (wanted.has(to) && !blocked.has(to) && !seen.has(to)) {
        seen.add(to);
        queue.push(to);
        order.push(to as PassiveNodeId);
      }
    }
  }
  // Breadth-first from the start, so every node comes after a node it hangs on.
  return order;
}

/** A stat text can hold several lines (one stat, several mods); PoB reports each line alone. */
export function statLines(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.length > 0 && !lines.includes(text) ? [text, ...lines] : lines;
}
