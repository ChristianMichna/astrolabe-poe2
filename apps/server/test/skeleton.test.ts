import { describe, expect, it, vi } from "vitest";
import type { TreeOptimizeInput } from "@astrolabe/optimizer";
import {
  ArchetypeCandidate,
  BuildRequest,
  BuildState,
  SkillProfile,
} from "@astrolabe/contracts/build";
import { CatalogShard } from "@astrolabe/contracts/catalog";
import { CalcId } from "@astrolabe/contracts/common";
import { MemoryCatalog } from "../src/catalog/memory-catalog.js";
import { PobSkeleton, connectedPart, statLines } from "../src/calc/skeleton.js";
import { createMemoryLogger } from "../src/logger.js";
import { RELEASE, REQUEST, SHARDS, candidate } from "./fixtures.js";

const node = (id: string, connections: string[], extra: object = {}) => ({
  id,
  name: id,
  kind: "small",
  stats: [],
  position: { groupId: "g", orbit: 0, orbitIndex: 0 },
  connections,
  ...extra,
});
const catalog = new MemoryCatalog(RELEASE, [
  ...SHARDS,
  CatalogShard.parse({
    schemaVersion: 1,
    dataReleaseId: RELEASE,
    kind: "passiveNode",
    entities: [
      node("FixStartA", ["FixN1"], { classStartFor: ["FixClassA"] }),
      node("FixN1", ["FixStartA", "FixN2"]),
      node("FixN2", ["FixN1"]),
    ],
  }),
]);

const profile = SkillProfile.parse({
  mainSkillId: "FixGemMain",
  tags: [],
  scalingStats: [],
  supportCandidates: ["FixGemSupport", "FixGemOther"],
  relevantUniques: [],
  relevantNodes: ["FixN2", "NotInTree"],
  ascendancyCandidates: [],
});
const cand = ArchetypeCandidate.parse(candidate("a", "FixClassA", "FixAscA1"));

function setup(
  optimizeResult: object,
  stagesResult?: object,
  usedCatalog = catalog,
  targetExtra: {
    unsupportedMods?: "avoid" | "accept";
    unsupportedMaxRounds?: number;
  } = {},
  extra: {
    minion?: { skillKinds: string[]; statMap: Record<string, string> };
    placeholderWeapon?: { slot: string; rarity: string };
    calc?: { calculate: unknown; getResult: unknown };
  } = {},
) {
  const optimize = vi.fn<(input: TreeOptimizeInput) => Promise<never>>(() =>
    Promise.resolve(optimizeResult as never),
  );
  const optimizeStages = vi.fn(() => Promise.resolve(stagesResult as never));
  const withBuild = vi.fn((_state: unknown, fn: (h: string) => Promise<unknown>) => fn("handle-1"));
  const getResult = vi.fn(() => Promise.resolve({ unsupportedMods: [] as string[] } as never));
  const calculate = vi.fn(() =>
    Promise.resolve({ "as-saved": { status: "ok" as const, calcId: CalcId.parse("calc-1") } }),
  );
  const skeleton = new PobSkeleton({
    pob: { withBuild } as never,
    pool: { request: () => Promise.reject(new Error("not used")) } as never,
    calc: { engine: "pob", calculate, getResult, ...extra.calc } as never,
    catalog: usedCatalog,
    optimizerConfig: {} as never,
    settings: {
      level: 10,
      passivePoints: 2,
      gemLevel: 1,
      supportCount: 1,
      calcProfiles: ["as-saved"],
      objective: { weights: { FullDPS: 1 }, floors: {} },
      ...(extra.placeholderWeapon === undefined
        ? {}
        : { placeholderWeapon: extra.placeholderWeapon }),
    },
    target: {
      calcProfiles: ["as-saved"],
      objective: { weights: { FullDPS: 1 }, floors: {} },
      ...targetExtra,
    },
    progression: { calcProfiles: ["as-saved"], objective: { weights: { FullDPS: 1 }, floors: {} } },
    ...(extra.minion === undefined ? {} : { minion: extra.minion }),
    logger: createMemoryLogger(),
    optimize,
    optimizeStages: optimizeStages as never,
  });
  return { skeleton, optimize, optimizeStages, withBuild, calculate, getResult };
}

describe("PobSkeleton", () => {
  it("builds the empty skeleton, optimises within the budget and measures the result", async () => {
    const { skeleton, optimize, withBuild, calculate } = setup({
      allocated: ["FixN1", "FixN2"],
      feasible: true,
      violations: [],
      failedEvaluationCount: 0,
      failedEvaluations: [],
      stoppedBy: "budget_spent",
    });
    const out = await skeleton.evaluate({ request: REQUEST, profile, candidate: cand });

    const start = withBuild.mock.calls[0]?.[0] as {
      skills: { supports: unknown[] }[];
      level: number;
    };
    expect(start.level).toBe(10);
    expect(start.skills[0]?.supports).toHaveLength(1);
    const call = optimize.mock.calls[0]?.[0];
    expect(call).toMatchObject({ budget: 2, objective: { weights: { FullDPS: 1 } } });
    expect(call?.priorityNodeIds).toEqual(["FixN2"]);
    expect(out.skeleton.tree.allocated.map((n) => n.nodeId)).toEqual(["FixN1", "FixN2"]);
    expect(out.calcs).toEqual({ "as-saved": { status: "ok", calcId: "calc-1" } });
    expect(calculate).toHaveBeenCalledOnce();
  });

  describe("placeholder weapon", () => {
    const optimized = {
      allocated: ["FixN1"],
      feasible: true,
      violations: [],
      failedEvaluationCount: 0,
      failedEvaluations: [],
      stoppedBy: "budget_spent",
    };
    const base = (id: string, itemClass: string, level: number, tags: string[] = []) => ({
      id,
      name: id,
      itemClass,
      tags,
      requirements: { level },
      implicitModIds: [],
      properties: {},
    });
    const withWeapons = Object.assign(Object.create(catalog) as typeof catalog, {
      release: {
        itemSlots: { slots: [{ id: "Weapon 1", itemClasses: ["Bow", "Mace"] }] },
        rarities: { rarities: [{ id: "normal", name: "Normal" }] },
      },
      list: (kind: string) =>
        kind === "baseItem"
          ? [
              base("HighBow", "Bow", 30),
              base("LowBow", "Bow", 1),
              base("UniqueBow", "Bow", 0, ["unique"]),
              base("LowMace", "Mace", 1),
            ].map((entity) => ({ kind: "baseItem", id: entity.id, entity }))
          : catalog.list(kind as never),
    });
    // the engine measures damage only for a bow; the stats follow the items of the state
    const engine = (damage: Record<string, number>) => {
      const seen = new Map<string, number>();
      return {
        calculate: vi.fn((input: { state: { items: { item: { baseItemId: string } }[] } }) => {
          const id = input.state.items[0]?.item.baseItemId ?? "none";
          seen.set(`calc-${id}`, damage[id] ?? 0);
          return Promise.resolve({ "as-saved": { status: "ok", calcId: `calc-${id}` } });
        }),
        getResult: vi.fn((id: string) =>
          Promise.resolve({ unsupportedMods: [], stats: { FullDPS: seen.get(id) ?? 0 } }),
        ),
      };
    };
    const slotConfig = { slot: "Weapon 1", rarity: "normal" };

    it("equips the lowest-requirement base of the class PoB measures best", async () => {
      const calc = engine({ LowBow: 50, LowMace: 10 });
      const { skeleton, withBuild } = setup(
        optimized,
        undefined,
        withWeapons,
        {},
        {
          placeholderWeapon: slotConfig,
          calc,
        },
      );
      const out = await skeleton.evaluate({ request: REQUEST, profile, candidate: cand });
      expect(out.skeleton.items).toEqual([
        {
          slot: "Weapon 1",
          item: {
            kind: "crafted",
            baseItemId: "LowBow",
            rarity: "normal",
            mods: [],
            socketables: [],
          },
        },
      ]);
      expect((withBuild.mock.calls[0]?.[0] as { items: unknown[] }).items).toHaveLength(1);
    });

    it("equips nothing when no weapon beats the build without one", async () => {
      const { skeleton } = setup(
        optimized,
        undefined,
        withWeapons,
        {},
        {
          placeholderWeapon: slotConfig,
          calc: engine({}),
        },
      );
      const out = await skeleton.evaluate({ request: REQUEST, profile, candidate: cand });
      expect(out.skeleton.items).toEqual([]);
    });

    it("measures the weapons once per skill and fails for a slot the release lacks", async () => {
      const calc = engine({ LowBow: 50 });
      const { skeleton } = setup(
        optimized,
        undefined,
        withWeapons,
        {},
        {
          placeholderWeapon: slotConfig,
          calc,
        },
      );
      await skeleton.evaluate({ request: REQUEST, profile, candidate: cand });
      const first = calc.calculate.mock.calls.length;
      await skeleton.evaluate({ request: REQUEST, profile, candidate: cand });
      // the second evaluation only measures its own skeleton, not the weapons again
      expect(calc.calculate.mock.calls.length - first).toBeLessThan(first);
      const { skeleton: odd } = setup(
        optimized,
        undefined,
        withWeapons,
        {},
        {
          placeholderWeapon: { slot: "Nowhere", rarity: "normal" },
        },
      );
      await expect(odd.evaluate({ request: REQUEST, profile, candidate: cand })).rejects.toThrow(
        /item slot Nowhere/,
      );
    });

    it("fails visibly for an unknown rarity or a missing objective stat", async () => {
      const { skeleton: rare } = setup(
        optimized,
        undefined,
        withWeapons,
        {},
        { placeholderWeapon: { slot: "Weapon 1", rarity: "mythic" } },
      );
      await expect(rare.evaluate({ request: REQUEST, profile, candidate: cand })).rejects.toThrow(
        /rarity mythic/,
      );
      const blind = {
        calculate: engine({ LowBow: 50 }).calculate,
        getResult: () => Promise.resolve({ unsupportedMods: [], stats: {} }),
      };
      const { skeleton } = setup(
        optimized,
        undefined,
        withWeapons,
        {},
        { placeholderWeapon: slotConfig, calc: blind },
      );
      await expect(
        skeleton.evaluate({ request: REQUEST, profile, candidate: cand }),
      ).rejects.toThrow(/reported no FullDPS/);
    });
  });

  describe("minion builds", () => {
    const optimized = {
      allocated: ["FixN1"],
      feasible: true,
      violations: [],
      failedEvaluationCount: 0,
      failedEvaluations: [],
      stoppedBy: "budget_spent",
    };
    const minion = { skillKinds: ["Minion"], statMap: { FullDPS: "MinionCombinedDPS" } };
    const withKind = (kind: string) =>
      Object.assign(Object.create(catalog) as typeof catalog, {
        get: (ref: { kind: string; id: string }) =>
          ref.kind === "gem" && ref.id === "FixGemMain"
            ? { ref, entity: { kind, tags: ["minion"] } }
            : catalog.get(ref as never),
      });

    it("optimises a minion skill for PoB's minion damage instead of the player's", async () => {
      const { skeleton, optimize } = setup(
        optimized,
        undefined,
        withKind("Minion"),
        {},
        { minion },
      );
      await skeleton.evaluate({ request: REQUEST, profile, candidate: cand });
      expect(optimize.mock.calls[0]?.[0].objective.weights).toEqual({ MinionCombinedDPS: 1 });
    });

    it("uses the minion stats in the target tree search (S5)", async () => {
      const { skeleton, optimize } = setup(
        optimized,
        undefined,
        withKind("Minion"),
        {},
        {
          minion: {
            skillKinds: ["Minion"],
            statMap: { FullDPS: "MinionCombinedDPS", CombinedDPS: "MinionCombinedDPS" },
          },
        },
      );
      const state = BuildState.parse({
        classId: "FixClassA",
        level: 20,
        tree: { allocated: [] },
        skills: [],
        items: [],
      });
      await skeleton.optimizeTree({
        request: REQUEST,
        profile,
        candidate: cand,
        state,
        passivePoints: 3,
      });
      expect(optimize.mock.calls[0]?.[0].objective.weights).toEqual({ MinionCombinedDPS: 1 });
    });

    it("uses the minion stats in the progression search (S6)", async () => {
      const wrapped = {
        stages: [
          {
            key: "late",
            budget: 2,
            allocated: ["FixN1", "FixN2"],
            allocationOrder: ["FixN1", "FixN2"],
            respecs: [],
            unspent: 0,
            metrics: {},
            calcId: "calc-1",
            violations: [],
            feasible: true,
            stoppedBy: "budget_spent",
          },
        ],
        evaluations: 1,
        failedEvaluations: [],
        failedEvaluationCount: 0,
      };
      const { skeleton, optimizeStages } = setup(
        optimized,
        wrapped,
        withKind("Minion"),
        {},
        {
          minion,
        },
      );
      const state = BuildState.parse({
        classId: "FixClassA",
        level: 20,
        tree: { allocated: [{ nodeId: "FixN1" }, { nodeId: "FixN2" }] },
        skills: [],
        items: [],
      });
      await skeleton.optimizeProgression({
        request: REQUEST,
        profile,
        candidate: cand,
        target: { candidateKey: "a", state, calcs: {}, rationale: [] } as never,
        stages: [{ key: "late", budget: 2, level: 20 }],
      });
      const call = (
        optimizeStages.mock.calls as unknown as [{ objective: { weights: object } }][]
      )[0];
      expect(call?.[0].objective.weights).toEqual({ MinionCombinedDPS: 1 });
    });

    it("keeps the configured objective for other skills and without the setting", async () => {
      for (const [tags, extra] of [
        [["Spell"], { minion }],
        [["Minion"], {}],
      ] as const) {
        const { skeleton, optimize } = setup(optimized, undefined, withKind(tags[0]), {}, extra);
        await skeleton.evaluate({ request: REQUEST, profile, candidate: cand });
        expect(optimize.mock.calls[0]?.[0].objective.weights).toEqual({ FullDPS: 1 });
      }
    });
  });

  describe("optimizeProgression (S6)", () => {
    const target = {
      candidateKey: "a",
      state: BuildState.parse({
        classId: "FixClassA",
        level: 20,
        tree: { allocated: [{ nodeId: "FixN1" }, { nodeId: "FixN2" }] },
        skills: [],
        items: [],
      }),
      calcs: {},
      rationale: [],
    } as never;
    const stage = (key: string, allocated: string[], feasible = true) => ({
      key,
      budget: allocated.length,
      allocated,
      allocationOrder: allocated,
      respecs: [],
      unspent: 0,
      metrics: {},
      calcId: "calc-1",
      violations: feasible ? [] : [{ stat: "x" }],
      feasible,
      stoppedBy: "budget_spent",
    });
    const input = {
      request: REQUEST,
      profile,
      candidate: cand,
      target,
      stages: [
        { key: "early", budget: 1, level: 10 },
        { key: "late", budget: 2, level: 20 },
      ],
    };
    const wrap = (stages: object[]) => ({
      stages,
      evaluations: 3,
      failedEvaluations: [],
      failedEvaluationCount: 0,
    });

    it("returns nested stage builds with a measurement each", async () => {
      const { skeleton, calculate } = setup(
        {},
        wrap([stage("early", ["FixN1"]), stage("late", ["FixN1", "FixN2"])]),
      );
      const out = await skeleton.optimizeProgression(input);
      expect(out.map((s) => [s.key, s.state.tree.allocated.length])).toEqual([
        ["early", 1],
        ["late", 2],
      ]);
      expect(calculate).toHaveBeenCalledTimes(2);
      expect(out.map((s) => s.state.level)).toEqual([10, 20]);
    });

    it("fails when the last stage does not reach the target tree", async () => {
      const { skeleton } = setup({}, wrap([stage("early", ["FixN1"]), stage("late", ["FixN1"])]));
      await expect(skeleton.optimizeProgression(input)).rejects.toThrow(/target nodes/);
    });

    it("fails visibly when a stage misses the floors", async () => {
      const { skeleton } = setup(
        {},
        wrap([stage("early", ["FixN1"], false), stage("late", ["FixN1", "FixN2"])]),
      );
      await expect(skeleton.optimizeProgression(input)).rejects.toThrow(/floors/);
    });
  });

  describe("optimizeTree (S5)", () => {
    const state = BuildState.parse({
      classId: "FixClassA",
      level: 20,
      tree: { allocated: [] },
      skills: [],
      items: [],
    });
    const done = {
      allocated: ["FixN1", "FixN2"],
      feasible: true,
      violations: [],
      failedEvaluationCount: 0,
      failedEvaluations: [],
      stoppedBy: "budget_spent",
    };
    const input = { request: REQUEST, profile, candidate: cand, state, passivePoints: 7 };

    it("optimises within the target budget and measures the tree", async () => {
      const { skeleton, optimize } = setup(done);
      const out = await skeleton.optimizeTree(input);
      expect(optimize.mock.calls[0]?.[0]).toMatchObject({ budget: 7 });
      expect(out.state.level).toBe(20);
      expect(out.state.tree.allocated.map((n) => n.nodeId)).toEqual(["FixN1", "FixN2"]);
      expect(out.calcs["as-saved"]?.status).toBe("ok");
    });

    it("searches the ascendancy on top of the main tree with the release's points", async () => {
      const ascShard = (shard: (typeof SHARDS)[number]): unknown =>
        shard.kind === "ascendancy"
          ? {
              ...shard,
              entities: shard.entities.map((e) =>
                e.id === "FixAscA1"
                  ? { ...e, startNodeId: "FixAscStart", nodeIds: ["FixAscStart", "FixAsc1"] }
                  : e,
              ),
            }
          : shard;
      const withAscendancy = new MemoryCatalog(RELEASE, [
        ...(SHARDS.map(ascShard) as never as typeof SHARDS),
        CatalogShard.parse({
          schemaVersion: 1,
          dataReleaseId: RELEASE,
          kind: "passiveNode",
          entities: [
            node("FixStartA", ["FixN1"], { classStartFor: ["FixClassA"] }),
            node("FixN1", ["FixStartA", "FixN2"]),
            node("FixN2", ["FixN1"]),
            node("FixAscStart", ["FixAsc1"], { ascendancyId: "FixAscA1" }),
            node("FixAsc1", ["FixAscStart"], { ascendancyId: "FixAscA1" }),
          ],
        }),
      ]);
      const { skeleton, optimize, withBuild } = setup(done, undefined, withAscendancy);
      optimize.mockResolvedValueOnce(done as never);
      optimize.mockResolvedValueOnce({ ...done, allocated: ["FixAsc1"] } as never);
      const out = await skeleton.optimizeTree({ ...input, ascendancyPoints: 3 });
      expect(optimize).toHaveBeenCalledTimes(2);
      expect(optimize.mock.calls[1]?.[0]).toMatchObject({ budget: 3 });
      expect([...(optimize.mock.calls[1]?.[0].graph.ids() ?? [])].sort()).toEqual([
        "FixAsc1",
        "FixAscStart",
      ]);
      // the ascendancy search runs on a build that already has the main tree
      const loaded = withBuild.mock.calls[1]?.[0] as { tree: { allocated: unknown[] } };
      expect(loaded.tree.allocated).toHaveLength(2);
      expect(out.state.tree.ascendancy).toEqual(["FixAsc1"]);
      // nodes whose mods PoB does not calculate are banned and the search runs again
      const text = "Fixture mod PoB ignores";
      const skipped = new MemoryCatalog(RELEASE, [
        ...(SHARDS.map(ascShard) as never as typeof SHARDS),
        CatalogShard.parse({
          schemaVersion: 1,
          dataReleaseId: RELEASE,
          kind: "passiveNode",
          entities: [
            node("FixStartA", ["FixN1"], { classStartFor: ["FixClassA"] }),
            node("FixN1", ["FixStartA", "FixN2"]),
            node("FixN2", ["FixN1"]),
            node("FixAscStart", ["FixAsc1"], { ascendancyId: "FixAscA1" }),
            node("FixAsc1", ["FixAscStart"], { ascendancyId: "FixAscA1", stats: [{ text }] }),
          ],
        }),
      ]);
      const again = setup(done, undefined, skipped);
      again.optimize.mockResolvedValueOnce(done as never);
      again.optimize.mockResolvedValueOnce({ ...done, allocated: ["FixAsc1"] } as never);
      again.getResult.mockResolvedValueOnce({ unsupportedMods: [] } as never); // main tree
      again.getResult.mockResolvedValueOnce({ unsupportedMods: [] } as never); // baseline
      again.getResult.mockResolvedValueOnce({ unsupportedMods: [text] } as never);
      again.optimize.mockResolvedValueOnce({ ...done, allocated: ["FixAscStart"] } as never);
      const second = await again.skeleton.optimizeTree({ ...input, ascendancyPoints: 3 });
      expect(again.optimize.mock.calls[2]?.[0].forbiddenNodeIds).toContain("FixAsc1");
      expect(second.state.tree.ascendancy).toEqual(["FixAscStart"]);
      // a line PoB reports that no chosen node carries must fail, not pass silently
      const odd = setup(done, undefined, skipped);
      odd.optimize.mockResolvedValueOnce(done as never);
      odd.optimize.mockResolvedValueOnce({ ...done, allocated: ["FixAsc1"] } as never);
      odd.getResult.mockResolvedValueOnce({ unsupportedMods: [] } as never); // main tree
      odd.getResult.mockResolvedValueOnce({ unsupportedMods: [] } as never);
      odd.getResult.mockResolvedValueOnce({ unsupportedMods: [text, "Other spelling"] } as never);
      await expect(odd.skeleton.optimizeTree({ ...input, ascendancyPoints: 3 })).rejects.toThrow(
        /do not match by text/,
      );
      // texts the main tree already has do not ban a node
      const base = setup(done, undefined, skipped);
      base.optimize.mockResolvedValueOnce(done as never);
      base.optimize.mockResolvedValueOnce({ ...done, allocated: ["FixAsc1"] } as never);
      base.getResult.mockResolvedValueOnce({ unsupportedMods: [] } as never); // main tree
      base.getResult.mockResolvedValueOnce({ unsupportedMods: [text] } as never);
      base.getResult.mockResolvedValueOnce({ unsupportedMods: [text] } as never);
      const kept = await base.skeleton.optimizeTree({ ...input, ascendancyPoints: 3 });
      expect(kept.state.tree.ascendancy).toEqual(["FixAsc1"]);
      // the round cap fails visibly
      const capped = setup(done, undefined, skipped, { unsupportedMaxRounds: 1 });
      capped.optimize.mockResolvedValueOnce(done as never);
      capped.optimize.mockResolvedValueOnce({ ...done, allocated: ["FixAsc1"] } as never);
      capped.getResult.mockResolvedValueOnce({ unsupportedMods: [] } as never); // main tree
      capped.getResult.mockResolvedValueOnce({ unsupportedMods: [] } as never);
      capped.getResult.mockResolvedValueOnce({ unsupportedMods: [text] } as never);
      await expect(capped.skeleton.optimizeTree({ ...input, ascendancyPoints: 3 })).rejects.toThrow(
        /after 1 rounds/,
      );
      // accept keeps the node without measuring
      const accepted = setup(done, undefined, skipped, { unsupportedMods: "accept" });
      accepted.optimize.mockResolvedValueOnce(done as never);
      accepted.optimize.mockResolvedValueOnce({ ...done, allocated: ["FixAsc1"] } as never);
      const acc = await accepted.skeleton.optimizeTree({ ...input, ascendancyPoints: 3 });
      expect(acc.state.tree.ascendancy).toEqual(["FixAsc1"]);
      // an ascendancy search that fails is a failed job, not a target without ascendancy
      optimize.mockResolvedValueOnce(done as never);
      optimize.mockResolvedValueOnce({
        ...done,
        allocated: [],
        failedEvaluationCount: 2,
        failedEvaluations: [{ error: "x" }],
      } as never);
      await expect(skeleton.optimizeTree({ ...input, ascendancyPoints: 3 })).rejects.toThrow(
        /could not evaluate any ascendancy node/,
      );
      // without points there is no ascendancy search
      const plain = setup(done);
      await plain.skeleton.optimizeTree(input);
      expect(plain.optimize).toHaveBeenCalledTimes(1);
    });

    it("bans main tree nodes whose mods PoB does not calculate and searches again", async () => {
      const text = "Fixture main tree mod PoB ignores";
      const flawed = new MemoryCatalog(RELEASE, [
        ...SHARDS,
        CatalogShard.parse({
          schemaVersion: 1,
          dataReleaseId: RELEASE,
          kind: "passiveNode",
          entities: [
            node("FixStartA", ["FixN1"], { classStartFor: ["FixClassA"] }),
            node("FixN1", ["FixStartA", "FixN2"]),
            node("FixN2", ["FixN1"], { stats: [{ text }] }),
          ],
        }),
      ]);
      const { skeleton, optimize, getResult } = setup(done, undefined, flawed);
      optimize.mockResolvedValueOnce(done as never);
      optimize.mockResolvedValueOnce({ ...done, allocated: ["FixN1"] } as never);
      getResult.mockResolvedValueOnce({ unsupportedMods: [text] } as never);
      const out = await skeleton.optimizeTree(input);
      expect(optimize.mock.calls[1]?.[0].forbiddenNodeIds).toContain("FixN2");
      // the second round continues from the first tree without the banned node
      expect(optimize.mock.calls[0]?.[0].allocated).toEqual([]);
      expect(optimize.mock.calls[1]?.[0].allocated).toEqual(["FixN1"]);
      expect(out.state.tree.allocated.map((n) => n.nodeId)).toEqual(["FixN1"]);
      // the cap fails visibly
      const capped = setup(done, undefined, flawed, { unsupportedMaxRounds: 1 });
      capped.getResult.mockResolvedValueOnce({ unsupportedMods: [text] } as never);
      await expect(capped.skeleton.optimizeTree(input)).rejects.toThrow(/after 1 rounds/);
      // accept keeps the node and measures nothing
      const accepted = setup(done, undefined, flawed, { unsupportedMods: "accept" });
      const kept = await accepted.skeleton.optimizeTree(input);
      expect(kept.state.tree.allocated.map((n) => n.nodeId)).toEqual(["FixN1", "FixN2"]);
    });

    it("matches the lines of a multi-line stat text one by one", async () => {
      const line = "Second line PoB ignores";
      const flawed = new MemoryCatalog(RELEASE, [
        ...SHARDS,
        CatalogShard.parse({
          schemaVersion: 1,
          dataReleaseId: RELEASE,
          kind: "passiveNode",
          entities: [
            node("FixStartA", ["FixN1"], { classStartFor: ["FixClassA"] }),
            node("FixN1", ["FixStartA", "FixN2"]),
            node("FixN2", ["FixN1"], { stats: [{ text: `First line\n${line}` }] }),
          ],
        }),
      ]);
      const { skeleton, optimize, getResult } = setup(done, undefined, flawed);
      optimize.mockResolvedValueOnce(done as never);
      optimize.mockResolvedValueOnce({ ...done, allocated: ["FixN1"] } as never);
      getResult.mockResolvedValueOnce({ unsupportedMods: [line] } as never);
      await skeleton.optimizeTree(input);
      expect(optimize.mock.calls[1]?.[0].forbiddenNodeIds).toContain("FixN2");
    });

    it("fails when the objective floors cannot be met", async () => {
      const { skeleton } = setup({ ...done, feasible: false, violations: [{ stat: "x" }] });
      await expect(skeleton.optimizeTree(input)).rejects.toThrow(/floors/);
    });

    it("fails for a request of another data release", async () => {
      const { skeleton } = setup(done);
      const request = BuildRequest.parse({ ...REQUEST, dataReleaseId: "poe2-1.0.0+r1" });
      await expect(skeleton.optimizeTree({ ...input, request })).rejects.toThrow(/catalog/);
    });
  });

  it("measures with the player's calc overrides", async () => {
    const { skeleton, calculate } = setup({
      allocated: [],
      feasible: true,
      violations: [],
      failedEvaluationCount: 0,
      failedEvaluations: [],
      stoppedBy: "budget_spent",
    });
    const request = BuildRequest.parse({ ...REQUEST, calcOverrides: { enemyIsBoss: "Uber" } });
    await skeleton.evaluate({ request, profile, candidate: cand });
    expect(calculate).toHaveBeenCalledWith(
      expect.objectContaining({ overrides: { enemyIsBoss: "Uber" } }),
    );
  });

  it("fails for a class without catalog entry and for a request of another release", async () => {
    const { skeleton } = setup({
      allocated: [],
      feasible: true,
      violations: [],
      failedEvaluationCount: 0,
      failedEvaluations: [],
      stoppedBy: "no_gain",
    });
    await expect(
      skeleton.evaluate({
        request: REQUEST,
        profile,
        candidate: ArchetypeCandidate.parse(candidate("b", "NoSuchClass", "FixAscA1")),
      }),
    ).rejects.toThrow(/NoSuchClass/);
    await expect(
      skeleton.evaluate({
        request: BuildRequest.parse({ ...REQUEST, dataReleaseId: "poe2-1.0.0+r1" }),
        profile,
        candidate: cand,
      }),
    ).rejects.toThrow(/targets/);
  });
});

describe("connectedPart", () => {
  // S - A - B - C, with a second way S - D - C and a dead end E behind C
  const edges: Record<string, string[]> = {
    S: ["A", "D"],
    A: ["S", "B"],
    B: ["A", "C"],
    C: ["B", "D", "E"],
    D: ["S", "C"],
    E: ["C"],
  };
  const graph = { start: "S", neighbors: (id: string) => edges[id] ?? [] } as never;
  const ids = (list: string[]) => list as never[];

  it("keeps nodes that still hang on the start and orders them from the start outwards", () => {
    expect(connectedPart(graph, ids(["E", "C", "B", "A", "D"]), new Set(["B"]))).toEqual([
      "A",
      "D",
      "C",
      "E",
    ]);
  });

  it("drops what a blocked node cut off, and everything when the start's neighbours are blocked", () => {
    expect(connectedPart(graph, ids(["A", "B", "C", "E"]), new Set(["A"]))).toEqual([]);
    expect(connectedPart(graph, ids(["A", "B"]), new Set(["A", "D"]))).toEqual([]);
    expect(connectedPart(graph, [], new Set())).toEqual([]);
  });
});

describe("statLines", () => {
  it("splits a text into its lines and keeps the whole text as well", () => {
    expect(statLines("A")).toEqual(["A"]);
    expect(statLines("A\nB")).toEqual(["A\nB", "A", "B"]);
    expect(statLines("")).toEqual([]);
    expect(statLines("A\r\nB")).toEqual(["A\r\nB", "A", "B"]);
    expect(statLines("A\n  \nB")).toEqual(["A\n  \nB", "A", "B"]);
  });
});
