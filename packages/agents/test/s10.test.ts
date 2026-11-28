import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StageConfig } from "../src/config.js";
import type { PipelineContext } from "../src/pipeline.js";
import {
  CRITIC_SECTIONS,
  CriticVerdict,
  afterReport,
  reportIsCurrent,
  type GuideDraft,
  assembleDraft,
  criticTask,
  draftEntities,
  runGates,
} from "../src/stages/s10-validate.js";

const text = [{ type: "text" as const, text: "x" }];
const STATE = {
  classId: "Cls",
  ascendancyId: "Asc",
  level: 10,
  tree: { allocated: [{ nodeId: "N1", weaponSet: 0 }], ascendancy: ["N2"] },
  skills: [
    {
      key: "k",
      role: "main",
      gem: { gemId: "GemMain", level: 1, quality: 0 },
      supports: [{ gemId: "GemSup", level: 1, quality: 0 }],
    },
  ],
  items: [{ slot: "Ring 1", item: { kind: "unique", uniqueId: "U1" } }],
  config: {},
};
const stage = (over: object = {}) => ({
  key: "st1",
  state: STATE,
  allocationOrder: [],
  tasks: [],
  dangers: [],
  rationale: [],
  respecs: [],
  calcs: { mapping: { status: "ok", calcId: "c1" } },
  ...over,
});
const draft = (over: object = {}) =>
  ({
    request: { mainSkillId: "GemReq", exclusions: [{ kind: "mod", id: "ExMod" }] },
    summary: { classId: "Cls", ascendancyId: "Asc", mainSkillId: "GemMain" },
    progression: { stages: [stage({ allocationOrder: ["N3"] })] },
    gear: {
      tiers: [
        {
          budgetTier: "end",
          calcs: { mapping: { status: "ok", calcId: "c1" } },
          slots: [
            {
              slot: "Ring 1",
              acquisition: "craft",
              target: { kind: "crafted", baseItemId: "B", mods: [], socketables: [] },
              alternatives: [],
            },
          ],
        },
      ],
    },
    crafting: [
      {
        key: "S8.craft-end-ring-1",
        target: { kind: "unique", uniqueId: "T0" },
        start: { baseItemId: "S0", cost: { status: "uncalibrated", reason: "x" } },
        steps: [],
      },
    ],
    mechanics: { explanation: [{ type: "entity", ref: { kind: "gem", id: "G" } }], decisions: [] },
    playstyle: { bossMechanics: [] },
    atlas: { avoidMods: [{ modId: "M", reason: text }] },
    variants: [],
    ...over,
  }) as never as GuideDraft;
/** A tiny tree: class start S1 - N1, ascendancy start S2 - N2. */
const EDGES: Record<string, string[]> = {
  S1: ["N1"],
  N1: ["S1", "N3"],
  N3: ["N1"],
  N4: ["N1"], // listed on this side only
  N6: ["N7"],
  N7: ["N6"],
  S2: ["N2"],
  N2: ["S2"],
};
const ctx = (known: (id: string) => boolean = () => true) =>
  ({
    result: () => undefined,
    catalog: {
      dataReleaseId: "poe2-1.0.0+r1",
      get: (r: { id: string; kind?: string }) =>
        r.kind === "characterClass"
          ? { entity: { id: r.id, startNodeId: "S1" } }
          : r.kind === "ascendancy"
            ? { entity: r.id === "AscNoStart" ? { id: r.id } : { id: r.id, startNodeId: "S2" } }
            : r.kind === "passiveNode"
              ? { entity: { id: r.id, connections: EDGES[r.id] ?? [] } }
              : known(r.id)
                ? {
                    entity: {
                      id: r.id,
                      name: r.id,
                      kind: "skill",
                      tags: [],
                      levels: [
                        { level: 1, requirements: { level: 5, attributes: {} }, stats: {} },
                        { level: 2, requirements: { level: 50, attributes: {} }, stats: {} },
                      ],
                    },
                  }
                : undefined,
    },
  }) as never as PipelineContext;
const codes = async (d: GuideDraft, c = ctx(), cfg?: never) =>
  (await runGates(c, d, cfg)).flatMap((g) => g.findings.map((f) => `${g.gate}:${f.code}`));

describe("S10 gates", () => {
  it("warns about a section that was written without research, and only warns", async () => {
    const base = ctx() as never as Record<string, unknown>;
    const withResearch = {
      ...base,
      result: (key: string) =>
        key === "S9.research-playstyle" ? { webAccess: false, findings: [] } : undefined,
    } as never as PipelineContext;
    const gates = await runGates(withResearch, draft());
    const g7 = gates.find((g) => g.gate === "G7");
    const found = g7?.findings.find((f) => f.code === "research_unavailable");
    expect(found?.severity).toBe("warning");
    expect(found?.message).toContain("playstyle");
    expect(await codes(draft())).not.toContain("G7:research_unavailable");
  });

  it("collects the references of items, plans and prose", () => {
    const ids = draftEntities(draft()).map((e) => e.ref.id);
    expect(ids).toEqual(expect.arrayContaining(["B", "M", "G"]));
  });

  it("covers the plain ids of builds, plans, prices and the request", () => {
    const withPrice = draft({
      crafting: [
        {
          key: "S8.craft-end-ring-1",
          target: { kind: "unique", uniqueId: "Tgt" },
          start: {
            baseItemId: "StartBase",
            cost: { status: "ok", value: { amount: 1, currencyItemId: "Cur" } },
          },
          steps: [{ actionIds: ["Act"], goal: text }],
        },
      ],
    });
    const ids = draftEntities(withPrice).map((e) => e.ref.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "Cls",
        "Asc",
        "N1",
        "N2",
        "N3",
        "GemMain",
        "GemSup",
        "U1",
        "GemReq",
        "ExMod",
        "Tgt",
        "StartBase",
        "Act",
        "Cur",
      ]),
    );
  });

  it("flags unknown entities (G1)", async () => {
    expect(
      await codes(
        draft(),
        ctx((id) => id !== "M"),
      ),
    ).toContain("G1:unknown_entity");
  });

  it("flags a failed stage calculation (G2)", async () => {
    const d = draft({
      progression: {
        stages: [
          stage({ calcs: { mapping: { status: "failed", error: { code: "x", message: "y" } } } }),
        ],
      },
    });
    expect(await codes(d)).toContain("G2:calc_failed");
  });

  it("flags respecs without a cost (G6) and a rare without a crafting plan (G7)", async () => {
    const d = draft({
      progression: { stages: [stage({ respecs: ["n1"] })] },
      crafting: [],
    });
    expect(await codes(d)).toEqual(
      expect.arrayContaining(["G6:respec_cost_not_measured", "G7:craft_plan_missing"]),
    );
  });

  it("flags a stage without any calculation (G2)", async () => {
    const d = draft({ progression: { stages: [stage({ calcs: {} })] } });
    expect(await codes(d)).toContain("G2:calc_missing");
  });

  it("never lets a partly checked gate pass", async () => {
    const gates = await runGates(ctx(), draft());
    // without the s10 block the gates that need it cannot pass
    for (const g of ["G2", "G3", "G4", "G5"]) {
      expect(gates.find((x) => x.gate === g)?.findings.map((f) => f.code)).toContain(
        "check_not_built",
      );
    }
  });

  it("names the unreadable part when the draft cannot be assembled", () => {
    const c = { run: { request: {} }, result: () => undefined } as never as PipelineContext;
    expect(() =>
      assembleDraft(c, { chosen: {} as never, target: {} as never, mainSkillId: "G" }),
    ).toThrow(/unreadable/);
  });

  it("never reports the unbuilt gates as passed", async () => {
    const gates = await runGates(ctx(), draft());
    for (const g of ["G3", "G4", "G5", "G8"]) {
      expect(gates.find((x) => x.gate === g)?.passed).toBe(false);
    }
  });
});

describe("S10 measured gates", () => {
  const cfg = {
    calcProfile: "mapping",
    minProgressionStages: 1,
    minGearTiers: 1,
    requiredCalcProfiles: ["mapping"],
    acceptedUnsupportedModPatterns: ["^Harmless"],
    stats: {
      spiritFree: "Sp",
      resistMissing: ["MissFire", "MissCold"],
      attributes: [{ have: "A", need: "ReqA" }],
      ehp: "Ehp",
      dps: "Dps",
    },
    resistanceCapStageKinds: ["endgame"],
    thresholdsCalibrated: true,
    thresholds: [
      { fromLevel: 10, minEhp: 100, minDps: 1000 },
      { fromLevel: 50, minEhp: 400 },
    ],
  };
  const withStats = (stats: Record<string, number> | undefined, profile = "mapping") =>
    ({
      ...(ctx() as object),
      run: { request: { calcOverrides: {} } },
      calc: {
        calculate: () => Promise.resolve({ mapping: { status: "ok", calcId: "c" } }),
        getResult: () =>
          Promise.resolve(stats === undefined ? undefined : { calcProfile: profile, stats }),
      },
    }) as never as PipelineContext;
  const stageAt = (level: number, kind = "endgame") =>
    draft({
      progression: { stages: [stage({ kind, state: { ...STATE, level } })] },
    });
  const run = async (
    stats: Record<string, number> | undefined,
    level = 90,
    over: object = {},
    kind = "endgame",
  ) =>
    (await runGates(withStats(stats), stageAt(level, kind), { ...cfg, ...over } as never)).flatMap(
      (g) => g.findings.map((f) => `${g.gate}:${f.code}`),
    );
  const good = { Sp: 5, MissFire: 0, MissCold: 0, Ehp: 500, Dps: 5000, A: 100, ReqA: 80 };

  it("passes G4 and G5 when every measured value meets the configured limits", async () => {
    const gates = await runGates(withStats(good), stageAt(90), cfg as never);
    expect(gates.find((g) => g.gate === "G4")?.passed).toBe(true);
    expect(gates.find((g) => g.gate === "G5")?.passed).toBe(true);
    expect(gates.find((g) => g.gate === "G3")?.passed).toBe(false);
  });

  it("flags overdrawn spirit, resistances missing to the cap and values below the minimums", async () => {
    const codes = await run({ Sp: -1, MissFire: 5, MissCold: 0, Ehp: 5, Dps: 5 });
    expect(codes).toEqual(
      expect.arrayContaining([
        "G3:spirit_overdrawn",
        "G4:resistance_below_cap",
        "G4:ehp_below_minimum",
        "G5:dps_below_minimum",
      ]),
    );
  });

  it("flags an attribute below the requirement of an item or gem (G3)", async () => {
    expect(await run({ ...good, A: 70 })).toContain("G3:attribute_requirement_unmet");
    expect(await run(good)).not.toContain("G3:attribute_requirement_unmet");
    // PoB leaves the requirement out when nothing asks for the attribute: no requirement.
    const noRequirement = await run({ ...good, ReqA: undefined as never });
    expect(noRequirement).not.toContain("G3:attribute_requirement_unmet");
    expect(noRequirement).not.toContain("G3:stat_missing");
    expect(await run({ ...good, A: undefined as never })).toContain("G3:stat_missing");
  });

  it("checks the allocated passives against the stage table, as S6 resolves it (G3)", async () => {
    const table = [
      { key: "act-1", label: "A", kind: "campaign", levelRange: [1, 5], passivePoints: 5 },
    ] as never;
    const nodes = (n: number, sets: number[] = []) => ({
      ...STATE,
      level: 5,
      tree: {
        allocated: [
          ...Array.from({ length: n }, (_, i) => ({ nodeId: `N${String(i)}`, weaponSet: 0 })),
          ...sets.map((weaponSet, i) => ({ nodeId: `W${String(i)}`, weaponSet })),
        ],
        ascendancy: [],
      },
    });
    const found = async (state: object, key = "act-1", t = table) =>
      (
        await runGates(
          withStats(good),
          draft({ progression: { stages: [stage({ key, kind: "campaign", state })] } }),
          cfg as never,
          undefined,
          t,
        )
      ).flatMap((g) => g.findings.filter((f) => f.gate === "G3"));
    expect((await found(nodes(5))).map((f) => f.code)).not.toContain("points_overspent");
    const over = (await found(nodes(6))).find((f) => f.code === "points_overspent");
    expect(over?.returnTo).toBe("S6");
    expect(over?.path).toBe("/progression/stages/0/state/tree");
    // nodes of both weapon sets share one budget: the smaller set is not counted twice
    expect((await found(nodes(3, [1, 1, 2, 2]))).map((f) => f.code)).not.toContain(
      "points_overspent",
    );
    expect((await found(nodes(4, [1, 1, 2, 2]))).map((f) => f.code)).toContain("points_overspent");
    // a stage the table does not know cannot be fixed by S6: no returnTo
    const unknown = (await found(nodes(1), "other")).find((f) => f.code === "points_unknown");
    expect(unknown).toBeDefined();
    expect(unknown?.returnTo).toBeUndefined();
  });

  it("reports a release without point rules once and without a return (G3)", async () => {
    const gates = await runGates(withStats(good), stageAt(90), cfg as never);
    const f = gates.flatMap((g) => g.findings).find((x) => x.code === "points_unknown");
    expect(f?.returnTo).toBeUndefined();
  });

  it("accepts an attribute exactly at its requirement and sends a miss to the right part (G3)", async () => {
    const at = async (stats: Record<string, number>, kind: string) =>
      (await runGates(withStats(stats), stageAt(90, kind), cfg as never))
        .flatMap((g) => g.findings)
        .find((x) => x.code === "attribute_requirement_unmet");
    expect(await at({ ...good, A: 80 }, "endgame")).toBeUndefined();
    // a campaign stage is measured wearing the first gear tier, so the gear part fixes a miss
    expect((await at({ ...good, A: 79 }, "campaign"))?.returnTo).toBe("S7.gear-end");
  });

  it("reports a failed measurement with gear instead of falling back to the ungeared numbers (G3)", async () => {
    const base = withStats({ ...good, A: 200 }) as never as { calc: object };
    const c = {
      ...(base as object),
      calc: {
        ...base.calc,
        calculate: () => Promise.resolve({ mapping: { status: "failed" } }),
      },
    } as never as PipelineContext;
    const f = (await runGates(c, stageAt(5, "campaign"), cfg as never))
      .flatMap((g) => g.findings)
      .find((x) => x.code === "calc_failed");
    expect(f?.returnTo).toBe("S7.gear-end");
  });

  it("flags allocated nodes that no allocated path joins to the start (G3)", async () => {
    const lone = (nodeId: string) =>
      draft({
        progression: {
          stages: [
            stage({
              state: {
                ...STATE,
                tree: { allocated: [{ nodeId, weaponSet: 0 }], ascendancy: ["N2"] },
              },
            }),
          ],
        },
      });
    const found = async (nodeId: string) =>
      (await runGates(withStats(good), lone(nodeId), cfg as never))
        .flatMap((g) => g.findings)
        .find((f) => f.code === "tree_node_unconnected");
    expect(await found("N1")).toBeUndefined();
    expect((await found("N9"))?.returnTo).toBe("S6");
  });

  it("follows chains and edges listed on one side, and checks ascendancy and weapon sets (G3)", async () => {
    const tree = (
      allocated: { nodeId: string; weaponSet: number }[],
      ascendancy: string[],
      ascendancyId = "Asc",
    ) =>
      draft({
        progression: {
          stages: [stage({ state: { ...STATE, ascendancyId, tree: { allocated, ascendancy } } })],
        },
      });
    const codesOf = async (d: GuideDraft) =>
      (await runGates(withStats(good), d, cfg as never))
        .flatMap((g) => g.findings)
        .filter((f) => f.code.startsWith("tree_"));
    const n = (nodeId: string, weaponSet = 0) => ({ nodeId, weaponSet });
    expect(await codesOf(tree([n("N1"), n("N3"), n("N4")], ["N2"]))).toEqual([]);
    const lonelyAscendancy = await codesOf(tree([n("N1")], ["N2", "N5"]));
    expect(lonelyAscendancy.map((f) => f.message)).toEqual([
      expect.stringContaining("N5 of the ascendancy tree"),
    ]);
    expect(await codesOf(tree([n("N1"), n("N3", 1)], []))).toEqual([]);
    const crossSet = await codesOf(tree([n("N1"), n("N6", 2), n("N7", 1)], []));
    expect(crossSet.map((f) => f.code)).toEqual(["tree_node_unconnected"]);
    const noStart = await codesOf(tree([n("N1")], ["N2"], "AscNoStart"));
    expect(noStart.map((f) => [f.code, f.returnTo])).toEqual([["tree_start_unknown", undefined]]);
  });

  it("checks the target build's ascendancy nodes against the release's points (G3)", async () => {
    const base = withStats(good) as never as { catalog: object };
    const withLimit = (points: number | undefined) =>
      ({
        ...(base as object),
        catalog: {
          ...base.catalog,
          release: points === undefined ? {} : { passivePoints: { ascendancy: { points } } },
        },
      }) as never as PipelineContext;
    const target = (ascendancy: string[]) =>
      ({
        candidateKey: "k",
        state: {
          ...STATE,
          tree: { allocated: [{ nodeId: "N1", weaponSet: 0 }], ascendancy },
        },
      }) as never;
    const run = async (points: number | undefined, nodes: string[]) => {
      const gates = await runGates(
        withLimit(points),
        stageAt(90),
        cfg as never,
        undefined,
        undefined,
        target(nodes),
      );
      const g3 = gates.find((g) => g.gate === "G3")?.findings ?? [];
      return g3.filter((f) => /^ascendancy|points\)|check_not_built/.test(f.code + f.message));
    };
    const overspent = await run(1, ["N2", "N5"]);
    expect(overspent.map((f) => [f.code, f.returnTo])).toContainEqual([
      "ascendancy_points_overspent",
      "S5",
    ]);
    // the start node of the ascendancy is free
    expect((await run(1, ["S2", "N2"])).map((f) => f.code)).not.toContain(
      "ascendancy_points_overspent",
    );
    // a release without the points leaves the check open and says why
    const open = await run(undefined, ["N2"]);
    expect(open.map((f) => f.message).join(" ")).toContain("passivePoints.ascendancy");
  });

  it("measures a campaign stage's attributes with the first gear tier's items (G3)", async () => {
    const seen: unknown[] = [];
    const base = withStats({ ...good, A: 10 }) as never as { calc: object };
    const c = {
      ...(base as object),
      calc: {
        ...base.calc,
        calculate: (input: { state: { items: unknown[] } }) => {
          seen.push(input.state.items);
          return Promise.resolve({ mapping: { status: "ok", calcId: "geared" } });
        },
        getResult: (id: string) =>
          Promise.resolve({
            calcProfile: "mapping",
            stats: id === "geared" ? { ...good, A: 200 } : { ...good, A: 10 },
          }),
      },
    } as never as PipelineContext;
    const codes = (await runGates(c, stageAt(5, "campaign"), cfg as never))
      .flatMap((g) => g.findings)
      .map((f) => f.code);
    expect(codes).not.toContain("attribute_requirement_unmet");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
  });

  it("counts a campaign stage's EHP and damage with the first gear tier worn (G4, G5)", async () => {
    const run = async (geared: Record<string, number>) => {
      const c = {
        ...(ctx() as object),
        run: { request: { calcOverrides: {} } },
        calc: {
          calculate: () => Promise.resolve({ mapping: { status: "ok", calcId: "geared" } }),
          getResult: (id: string) =>
            Promise.resolve({
              calcProfile: "mapping",
              // the stage itself carries no weapon: no damage
              stats: id === "geared" ? geared : { ...good, Dps: 0 },
            }),
        },
      } as never as PipelineContext;
      return (await runGates(c, stageAt(20, "campaign"), cfg as never)).flatMap((g) =>
        g.findings.map((f) => `${f.code}:${String(f.returnTo)}`),
      );
    };
    expect(await run(good)).not.toContain("dps_below_minimum:S6");
    expect(await run(good)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("dps_below")]),
    );
    // a failed measurement with gear is not replaced by the ungeared numbers
    const failed = {
      ...(ctx() as object),
      run: { request: { calcOverrides: {} } },
      calc: {
        calculate: () => Promise.resolve({ mapping: { status: "failed" } }),
        getResult: () => Promise.resolve({ calcProfile: "mapping", stats: { ...good, Dps: 0 } }),
      },
    } as never as PipelineContext;
    const codesOfFailed = (await runGates(failed, stageAt(20, "campaign"), cfg as never)).flatMap(
      (g) => g.findings.map((f) => f.code),
    );
    expect(codesOfFailed).toContain("calc_failed");
    expect(codesOfFailed).not.toContain("dps_below_minimum");
    // a gap with gear goes to the gear part, not to the tree order of S6
    expect(await run({ ...good, Dps: 1 })).toContain("dps_below_minimum:S7.gear-end");
  });

  it("fails G2 for a missing required profile and for unsupported mods nobody accepted", async () => {
    const gate2 = async (unsupported: string[], over: object = {}, st = stage()) =>
      (
        await runGates(
          {
            ...(withStats(good) as object),
            run: { request: { calcOverrides: {} } },
            calc: {
              calculate: () => Promise.resolve({ mapping: { status: "ok", calcId: "c" } }),
              getResult: () =>
                Promise.resolve({
                  calcProfile: "mapping",
                  stats: good,
                  unsupportedMods: unsupported,
                }),
            },
          } as never as PipelineContext,
          draft({ progression: { stages: [st] } }),
          { ...cfg, ...over } as never,
        )
      ).find((g) => g.gate === "G2")?.findings ?? [];
    const accepted = await gate2(["Harmless one"]);
    expect(accepted.map((f) => [f.code, f.severity])).toEqual([
      ["unsupported_mod_accepted", "warning"],
    ]);
    const bad = (await gate2(["Harmless", "Odd mod"])).find((f) => f.code === "unsupported_mod");
    expect(bad?.returnTo).toBeUndefined();
    expect(bad?.message).toContain("Odd mod");
    const missing = await gate2([], { requiredCalcProfiles: ["mapping", "boss"] });
    expect(missing.map((f) => f.code)).toEqual(["profile_missing"]);
  });

  it("checks that skills carry on between stages (G6)", async () => {
    const skill = (over: object = {}) => ({ ...STATE.skills[0], ...over });
    const two = async (second: object[]) =>
      (
        await runGates(
          withStats(good),
          draft({
            progression: {
              stages: [
                stage({ key: "a", kind: "campaign" }),
                stage({ key: "b", kind: "campaign", state: { ...STATE, skills: second } }),
              ],
            },
          }),
          cfg as never,
        )
      ).flatMap((g) => g.findings.filter((f) => f.gate === "G6"));
    expect(await two([skill()])).toEqual([]);
    expect((await two([])).map((f) => f.code)).toEqual(["skill_lost"]);
    const changed = await two([skill({ gem: { gemId: "Other", level: 1, quality: 0 } })]);
    expect(changed.map((f) => f.code)).toEqual(["skill_gem_changed"]);
    expect(changed[0]?.returnTo).toBe("S5");
    expect((await two([skill({ supports: [] })])).map((f) => f.code)).toEqual(["supports_lost"]);
  });

  it("enforces the configured minimum counts (G7)", async () => {
    const found = async (over: object) =>
      (await runGates(withStats(good), draft(), { ...cfg, ...over } as never)).flatMap((g) =>
        g.findings
          .filter((f) => f.gate === "G7" && f.code !== "check_not_built")
          .map((f) => f.code),
      );
    expect(await found({ minProgressionStages: 1, minGearTiers: 1 })).toEqual([]);
    expect(await found({ minProgressionStages: 5, minGearTiers: 1 })).toEqual(["too_few_stages"]);
    expect(await found({ minProgressionStages: 1, minGearTiers: 4 })).toEqual([
      "too_few_gear_tiers",
    ]);
  });

  it("asks for a crafting plan of every tier's rare, each tier on its own (G7)", async () => {
    const d = draft();
    const first = d.gear.tiers[0];
    if (first === undefined) throw new Error("the fixture has a gear tier");
    d.gear.tiers.unshift({ ...first, budgetTier: "start" } as never);
    const gates = await runGates(withStats(good), d, cfg as never);
    const g7 = gates.find((g) => g.gate === "G7")?.findings ?? [];
    expect(g7.map((f) => f.code)).not.toContain("check_not_built");
    expect(g7).toEqual([
      expect.objectContaining({
        code: "craft_plan_missing",
        returnTo: "S8",
        message: expect.stringContaining("start"),
      }),
    ]);
  });

  it("flags a gem whose level the character cannot use yet, or that the catalog lacks (G3)", async () => {
    const withGem = (level: number, charLevel: number) =>
      draft({
        progression: {
          stages: [
            stage({
              key: "a",
              kind: "campaign",
              state: {
                ...STATE,
                level: charLevel,
                skills: [{ ...STATE.skills[0], gem: { gemId: "GemMain", level, quality: 0 } }],
              },
            }),
          ],
        },
      });
    const found = async (d: GuideDraft) =>
      (await runGates(withStats(good), d, cfg as never))
        .flatMap((g) => g.findings)
        .filter((f) => f.code.startsWith("gem_level"));
    expect(await found(withGem(1, 5))).toEqual([]);
    const low = await found(withGem(2, 20));
    expect(low.map((f) => [f.code, f.returnTo])).toEqual([["gem_level_requirement_unmet", "S6"]]);
    expect((await found(withGem(9, 20))).map((f) => f.code)).toEqual(["gem_level_unknown"]);
  });

  it("separates a missing stat from a value below the minimum", async () => {
    const codes = await run({ Sp: 1, MissFire: 0, MissCold: 0, A: 1, ReqA: 1 });
    expect(codes).toEqual(expect.arrayContaining(["G4:stat_missing", "G5:stat_missing"]));
    expect(codes).not.toContain("G4:ehp_below_minimum");
  });

  it("resolves each minimum on its own by level and flags a level without one", async () => {
    // level 60: minEhp 400 applies, minDps still comes from the entry at level 10
    expect(await run({ ...good, Ehp: 300 }, 60)).toContain("G4:ehp_below_minimum");
    expect(await run({ ...good, Dps: 500 }, 60)).toContain("G5:dps_below_minimum");
    // level 5 is below the smallest fromLevel: not checked, so the gate cannot pass
    const codes = await run(good, 5);
    expect(codes).toEqual(expect.arrayContaining(["G4:threshold_missing", "G5:threshold_missing"]));
  });

  it("measures the endgame stage with the gear of the last tier and sends findings to S7", async () => {
    const ids: string[] = [];
    const ctxSeen = {
      ...(ctx() as object),
      run: { request: { calcOverrides: {} } },
      calc: {
        calculate: () => Promise.resolve({ mapping: { status: "ok", calcId: "c" } }),
        getResult: (id: string) => {
          ids.push(id);
          return Promise.resolve({
            calcProfile: "mapping",
            stats: { Sp: 5, MissFire: 4, MissCold: 0, Ehp: 500, Dps: 5000 },
          });
        },
      },
    } as never as PipelineContext;
    const d = stageAt(90);
    const tier = d.gear.tiers[0];
    if (tier === undefined) throw new Error("the fixture has a gear tier");
    tier.calcs = { mapping: { status: "ok", calcId: "geared" } } as never;
    const gates = await runGates(ctxSeen, d, cfg as never);
    expect(ids).toEqual(["geared"]);
    const g4 = gates.find((g) => g.gate === "G4")?.findings ?? [];
    expect(g4.find((f) => f.code === "resistance_below_cap")).toMatchObject({
      returnTo: "S7.gear-end",
      path: "/gear/tiers/0/calcs",
    });
  });

  it("sends an endgame finding to the part of the last gear tier, also when its measurement is missing", async () => {
    const d = stageAt(90);
    const tier = d.gear.tiers[0];
    if (tier === undefined) throw new Error("the fixture has a gear tier");
    Object.assign(tier, { budgetTier: "mid", calcs: {} });
    const gates = await runGates(withStats(good), d, cfg as never);
    const g4 = gates.find((g) => g.gate === "G4")?.findings ?? [];
    expect(g4).toEqual([
      expect.objectContaining({ code: "stats_unavailable", returnTo: "S7.gear-mid" }),
    ]);
  });

  it("reports uncalibrated thresholds as a warning, not as a pass without a note (G4, G5)", async () => {
    const gates = await runGates(withStats(good), stageAt(90), {
      ...cfg,
      thresholdsCalibrated: false,
    } as never);
    const warned = gates
      .filter((g) => g.gate === "G4" || g.gate === "G5")
      .flatMap((g) => g.findings.filter((f) => f.code === "thresholds_uncalibrated"))
      .map((f) => [f.gate, f.severity]);
    expect(warned).toEqual([
      ["G4", "warning"],
      ["G5", "warning"],
    ]);
  });

  it("skips the resistance check for stage kinds that are not configured", async () => {
    expect(await run({ ...good, MissFire: 9 }, 90, {}, "campaign")).not.toContain(
      "G4:resistance_below_cap",
    );
  });

  it("treats a missing or foreign-profile result as unavailable", async () => {
    expect(await run(undefined)).toContain("G4:stats_unavailable");
    const foreign = await runGates(withStats(good, "pinnacle"), stageAt(90), cfg as never);
    expect(foreign.flatMap((g) => g.findings.map((f) => f.code))).toContain("stats_unavailable");
  });

  describe("derived thresholds", () => {
    const derivedCfg = { ...cfg, thresholds: [], derived: { minRatioToBest: 0.8 } };
    /** One stage per stats entry, levels 10, 20, ...; `levels` overrides them. */
    const chain = (
      list: (Record<string, number> | undefined)[],
      levels?: number[],
      geared?: Record<string, number>[],
    ) => {
      const byId = new Map<string, Record<string, number> | undefined>();
      const idOfLevel = new Map<number, string>();
      const stages = list.map((stats, i) => {
        byId.set(`c${String(i)}`, stats);
        const worn = geared?.[i];
        if (worn !== undefined) byId.set(`g${String(i)}`, worn);
        idOfLevel.set(
          levels?.[i] ?? 10 * (i + 1),
          worn === undefined ? `c${String(i)}` : `g${String(i)}`,
        );
        return stage({
          key: `s${String(i)}`,
          kind: "campaign",
          state: { ...STATE, level: levels?.[i] ?? 10 * (i + 1) },
          calcs: { mapping: { status: "ok", calcId: `c${String(i)}` } },
        });
      });
      const c = {
        ...(ctx() as object),
        run: { request: { calcOverrides: {} } },
        calc: {
          // the measurement with the first gear tier of a stage gives that stage's numbers
          calculate: (input: { state: { level: number } }) =>
            Promise.resolve({
              mapping: { status: "ok", calcId: idOfLevel.get(input.state.level) ?? "none" },
            }),
          getResult: (id: string) => {
            const stats = byId.get(id);
            return Promise.resolve(
              stats === undefined ? undefined : { calcProfile: "mapping", stats },
            );
          },
        },
      } as never as PipelineContext;
      return runGates(c, draft({ progression: { stages } }), derivedCfg as never);
    };
    const codes = async (list: (Record<string, number> | undefined)[], levels?: number[]) =>
      (await chain(list, levels)).flatMap((g) => g.findings.map((f) => `${g.gate}:${f.code}`));
    const at = (ehp: number, dps: number) => ({ ...good, Ehp: ehp, Dps: dps });

    it("passes stages that keep their share and says the check is relative, not uncalibrated", async () => {
      const found = await codes([at(500, 5000), at(450, 4100), at(400, 4000)]);
      expect(found).not.toContain("G4:ehp_below_minimum");
      expect(found).not.toContain("G5:dps_below_minimum");
      expect(found).not.toContain("G4:thresholds_uncalibrated");
      expect(found).toEqual(
        expect.arrayContaining(["G4:thresholds_relative", "G5:thresholds_relative"]),
      );
      const gates = await chain([at(500, 5000), at(500, 5000)]);
      expect(gates.find((g) => g.gate === "G4")?.passed).toBe(true);
      expect(gates.find((g) => g.gate === "G5")?.passed).toBe(true);
    });

    it("flags a stage below the allowed share, and accepts exactly the share", async () => {
      expect(await codes([at(500, 5000), at(399, 5000)])).toContain("G4:ehp_below_minimum");
      expect(await codes([at(500, 5000), at(500, 3999)])).toContain("G5:dps_below_minimum");
      const found = await codes([at(500, 5000), at(400, 4000)]);
      expect(found).not.toContain("G4:ehp_below_minimum");
      expect(found).not.toContain("G5:dps_below_minimum");
    });

    it("compares with the best stage before, so a slow decline over many stages is caught", async () => {
      // each step keeps 85 percent of the one before, the last is far below the first
      const found = await codes([at(1000, 5000), at(850, 4250), at(722, 3612), at(614, 3070)]);
      expect(found).toContain("G4:ehp_below_minimum");
      expect(found).toContain("G5:dps_below_minimum");
    });

    it("compares EHP on the stage's own tree, so enemies that scale with the level do not fail a growing tree", async () => {
      // the same gear tier is worn in every stage: its EHP falls with the stronger enemies, the tree's rises
      const bare = [at(100, 5000), at(200, 5000), at(300, 5000)];
      const worn = [at(9000, 5000), at(5000, 5000), at(2000, 5000)];
      const found = (await chain(bare, undefined, worn)).flatMap((g) =>
        g.findings.map((f) => `${g.gate}:${f.code}`),
      );
      expect(found).not.toContain("G4:ehp_below_minimum");
      // a tree that collapses still fails, whatever the gear measures
      const collapsed = (await chain([at(300, 5000), at(100, 5000)], undefined, worn)).flatMap(
        (g) => g.findings.map((f) => `${g.gate}:${f.code}`),
      );
      expect(collapsed).toContain("G4:ehp_below_minimum");
    });

    it("reports a stage whose tree has no EHP, whatever the gear measures", async () => {
      const noEhp: Record<string, number> = { ...good, Dps: 5000 };
      delete noEhp.Ehp;
      const found = (
        await chain([at(100, 5000), noEhp], undefined, [at(900, 5000), at(900, 5000)])
      ).flatMap((g) => g.findings.map((f) => `${g.gate}:${f.code}`));
      expect(found).toContain("G4:stat_missing");
    });

    it("requires every stage to have some EHP and damage", async () => {
      const found = await codes([at(0, 0), at(0, 0)]);
      expect(found.filter((c) => c === "G4:ehp_below_minimum")).toHaveLength(2);
      expect(found.filter((c) => c === "G5:dps_below_minimum")).toHaveLength(2);
    });

    it("keeps comparing across a stage without a result", async () => {
      const found = await codes([at(500, 5000), undefined, at(300, 5000)]);
      expect(found).toContain("G4:stats_unavailable");
      expect(found).toContain("G4:ehp_below_minimum");
    });

    it("sends stages that are not in ascending level order back to S6", async () => {
      const gates = await chain([at(500, 5000), at(500, 5000)], [20, 20]);
      const found = gates
        .flatMap((g) => g.findings)
        .find((f) => f.code === "stage_level_not_ascending");
      expect(found).toMatchObject({ gate: "G3", returnTo: "S6" });
    });

    it("rejects fixed thresholds next to derived ones and a ratio outside zero to one", () => {
      const committed = (
        JSON.parse(readFileSync(join(__dirname, "../../../config/agents/stages.json"), "utf8")) as {
          s10: Record<string, unknown>;
        }
      ).s10;
      const parse = (over: object) =>
        StageConfig.shape.s10.safeParse({ ...committed, ...over }).success;
      expect(parse({})).toBe(true);
      expect(parse({ thresholds: [{ fromLevel: 1, minEhp: 1 }] })).toBe(false);
      expect(parse({ derived: { minRatioToBest: 0 } })).toBe(false);
      expect(parse({ derived: { minRatioToBest: 1.1 } })).toBe(false);
    });
  });

  it("does not pass G4 or G5 without configured thresholds", async () => {
    const gates = await runGates(withStats(good), stageAt(90), { ...cfg, thresholds: [] } as never);
    for (const g of ["G4", "G5"]) {
      expect(gates.find((x) => x.gate === g)?.findings.map((f) => f.code)).toContain(
        "check_not_built",
      );
    }
  });

  it("does not pass G3 to G5 without the s10 config block", async () => {
    const gates = await runGates(ctx(), draft());
    for (const g of ["G3", "G4", "G5"]) {
      expect(gates.find((x) => x.gate === g)?.passed).toBe(false);
    }
  });
});

describe("S10 critic (G8)", () => {
  const verdict = (over: object = {}) => ({
    reviewed: [...CRITIC_SECTIONS],
    issues: [],
    ...over,
  });
  const g8 = async (v?: object) =>
    (await runGates(ctx(), draft(), undefined, v as never)).find((g) => g.gate === "G8");

  it("fails G8 until the critic has reviewed the guide", async () => {
    const gate = await g8(undefined);
    expect(gate?.passed).toBe(false);
    expect(gate?.findings.map((f) => f.code)).toEqual(["check_not_built"]);
  });

  it("passes G8 when every section was read and nothing was found", async () => {
    expect((await g8(verdict()))?.passed).toBe(true);
  });

  it("turns issues and unread sections into findings", async () => {
    const gate = await g8(
      verdict({
        reviewed: ["summary"],
        issues: [{ section: "faq", message: "Contradicts the gear plan" }],
      }),
    );
    expect(gate?.passed).toBe(false);
    const codes = gate?.findings.map((f) => f.code) ?? [];
    expect(codes).toContain("inconsistency");
    expect(codes).toContain("section_not_reviewed");
  });

  it("names the problem as text when the draft cannot be assembled", () => {
    const c = { run: { request: {} }, result: () => undefined } as never as PipelineContext;
    const out = criticTask(c, { promptVersion: "t" } as StageConfig, {
      chosen: {} as never,
      target: {} as never,
      mainSkillId: "G",
    });
    expect(typeof out).toBe("string");
  });
});

describe("S10 after the gates", () => {
  const f = (gate: string, code: string, returnTo?: string) => ({
    gate,
    severity: "error",
    code,
    message: "m",
    ...(returnTo === undefined ? {} : { returnTo }),
  });
  const report = (findings: object[]) => ({
    passed: false,
    gates: [{ gate: "G2", passed: false, findings }],
    critic: null,
  });
  const ctxWith = (results: Record<string, unknown>) =>
    ({ result: (k: string) => results[k] }) as never as PipelineContext;

  it("sends the earliest causing stage back with its findings", () => {
    const step = afterReport(
      ctxWith({
        "S10.report": report([f("G7", "a", "S8"), f("G2", "b", "S6"), f("G2", "c", "S6")]),
      }),
      2,
    );
    expect(step).toMatchObject({ kind: "return", stage: "S6", maxReturns: 2 });
    expect(step?.kind === "return" && step.findings.map((x) => x.code)).toEqual(["b", "c"]);
  });

  it("leaves a passed report to the publishing step", () => {
    const passed = {
      passed: true,
      gates: [{ gate: "G2", passed: true, findings: [] }],
      critic: null,
    };
    expect(afterReport(ctxWith({ "S10.report": passed }), 2)).toBeNull();
  });

  it("stops when no stage can fix what is open", () => {
    const step = afterReport(ctxWith({ "S10.report": report([f("G3", "check_not_built")]) }), 2);
    expect(step).toMatchObject({ kind: "blocked", error: { code: "validation_failed" } });
  });

  it("names an unreadable report", () => {
    expect(afterReport(ctxWith({ "S10.report": 5 }), 2)).toMatchObject({
      kind: "blocked",
      error: { code: "invalid_report" },
    });
  });

  it("recomputes a report that was made without the stored critic verdict", () => {
    const verdict = { reviewed: [...CRITIC_SECTIONS], issues: [] };
    expect(reportIsCurrent(ctxWith({}))).toBe(false);
    expect(reportIsCurrent(ctxWith({ "S10.report": report([]) }))).toBe(true);
    expect(reportIsCurrent(ctxWith({ "S10.report": report([]), "S10.critic": verdict }))).toBe(
      false,
    );
    expect(
      reportIsCurrent(
        ctxWith({ "S10.report": { ...report([]), critic: verdict }, "S10.critic": verdict }),
      ),
    ).toBe(true);
  });

  it("requires the critic to name every section it read", () => {
    expect(CriticVerdict.safeParse({ reviewed: ["summary"], issues: [] }).success).toBe(false);
  });

  it("rejects critic messages with digits and duplicate reviewed sections", () => {
    const base = { reviewed: [...CRITIC_SECTIONS], issues: [] };
    expect(CriticVerdict.safeParse(base).success).toBe(true);
    expect(
      CriticVerdict.safeParse({ ...base, reviewed: [...CRITIC_SECTIONS, "summary"] }).success,
    ).toBe(false);
    expect(
      CriticVerdict.safeParse({ ...base, issues: [{ section: "faq", message: "Needs 5 more" }] })
        .success,
    ).toBe(false);
  });
});
