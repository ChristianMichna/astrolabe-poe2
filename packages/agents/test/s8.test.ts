import { describe, expect, it } from "vitest";
import type { GearPlan, ItemSpec } from "@astrolabe/contracts/build";
import type { PipelineContext } from "../src/pipeline.js";
import type { StageConfig } from "../src/config.js";
import {
  type CraftSlot,
  CraftSubmission,
  craftKey,
  craftPlanJob,
  craftSlotsOf,
  craftTask,
  goalOf,
  slotSlug,
} from "../src/stages/s8-craft.js";

const text = (t: string) => [{ type: "text" as const, text: t }];
const crafted = (mods: { id: string; required: boolean }[]): ItemSpec =>
  ({
    kind: "crafted",
    baseItemId: "FixBase",
    rarity: "FixRare",
    mods: mods.map((m) => ({ modId: m.id, rollFraction: 0.5, required: m.required })),
    socketables: [],
  }) as never;
const slotOf = (slot: string, acquisition: string, target: ItemSpec) => ({
  slot,
  priority: "core",
  target,
  acquisition,
  rationale: [{ reason: text("Fits") }],
});
const plan = (slots: object[]) =>
  ({ tiers: [{ budgetTier: "end", slots }] }) as unknown as GearPlan;

describe("S8 slots", () => {
  it("names tasks by a normalised slot id", () => {
    expect(slotSlug("Body Armour")).toBe("body-armour");
    expect(craftKey("End", "Ring 1")).toBe("S8.craft-end-ring-1");
  });

  it("takes the crafted rares acquired by crafting from every tier", () => {
    const out = craftSlotsOf(
      plan([
        slotOf("Ring 1", "craft", crafted([{ id: "M1", required: true }])),
        slotOf("Ring 2", "trade", crafted([{ id: "M1", required: true }])),
        slotOf("Amulet", "craft", { kind: "unique", uniqueId: "U" } as never),
      ]),
    );
    expect(Array.isArray(out) && out.map((s) => s.slot)).toEqual(["Ring 1"]);
    expect(craftSlotsOf({ tiers: [] } as never)).toEqual([]);
  });

  it("plans the rares of earlier tiers as well, under their own task names", () => {
    const c = crafted([{ id: "M1", required: true }]);
    const out = craftSlotsOf({
      tiers: [
        { budgetTier: "start", slots: [slotOf("Ring 1", "craft", c)] },
        { budgetTier: "end", slots: [slotOf("Ring 1", "craft", c)] },
      ],
    } as never);
    expect(Array.isArray(out) && out.map((s) => s.key)).toEqual([
      "S8.craft-start-ring-1",
      "S8.craft-end-ring-1",
    ]);
  });

  it("names ambiguous slot ids instead of merging them", () => {
    const c = crafted([{ id: "M1", required: true }]);
    expect(
      typeof craftSlotsOf(plan([slotOf("Ring 1", "craft", c), slotOf("ring-1", "craft", c)])),
    ).toBe("string");
  });

  it("rejects a slot id without letters or digits", () => {
    const c = crafted([{ id: "M1", required: true }]);
    expect(typeof craftSlotsOf(plan([slotOf("--", "craft", c)]))).toBe("string");
  });

  it("uses the required mods as the goal, or all mods when none is required", () => {
    const some = crafted([
      { id: "A", required: true },
      { id: "B", required: false },
    ]) as never;
    expect(goalOf(some)).toEqual({ clauses: [{ anyOfModIds: ["A"] }] });
    const none = crafted([
      { id: "A", required: false },
      { id: "B", required: false },
    ]) as never;
    expect(goalOf(none)?.clauses).toHaveLength(2);
    expect(goalOf(crafted([]) as never)).toBeUndefined();
  });
});

const submission = {
  startItemLevel: 80,
  startRarity: "FixRare",
  steps: [{ order: 0, actionIds: ["FixAction"], goal: text("Add"), onFail: { action: "restart" } }],
  rationale: [{ reason: text("Cheap") }],
};
const slot = (): CraftSlot => ({
  tier: "end",
  slot: "Ring 1",
  key: "S8.craft-end-ring-1",
  target: crafted([{ id: "M1", required: true }]) as never,
});
const ok = (value: number) => ({
  status: "ok" as const,
  value,
  source: {
    kind: "derived",
    formula: "f",
    formulaVersion: "1",
    inputs: [
      {
        kind: "gamedata",
        dataReleaseId: "poe2-1.0.0+r1",
        entity: { kind: "mod", id: "M1" },
        field: "/weight",
      },
    ],
  },
});
const ctxWith = (over: object = {}) =>
  ({
    run: { request: { dataReleaseId: "poe2-1.0.0+r1", exclusions: [] }, interventions: [] },
    catalog: {
      get: () => ({ entity: {} }),
      release: { rarities: { rarities: [{ id: "FixRare", name: "Fix" }] } },
    },
    result: () => submission,
    ...over,
  }) as never as PipelineContext;

describe("S8 craft task", () => {
  it("parses a submission with defaults", () => {
    expect(CraftSubmission.parse(submission).startModIds).toEqual([]);
  });

  const check = (craft: unknown) =>
    (
      craftTask(ctxWith(), { promptVersion: "t" } as StageConfig, slot(), {} as never) as never as {
        check: (c: unknown, x: unknown) => Promise<{ code: string }[]>;
      }
    ).check(CraftSubmission.parse(submission), ctxWith({ craft }));

  it("accepts a strategy the simulator reaches the goal with", async () => {
    const craft = { simulate: () => Promise.resolve({ successChance: ok(0.2) }) };
    expect(await check(craft)).toEqual([]);
  });

  it("returns an unreachable goal and a rejected simulation as findings", async () => {
    const zero = { simulate: () => Promise.resolve({ successChance: ok(0) }) };
    expect((await check(zero)).map((f) => f.code)).toEqual(["goal_unreachable"]);
    const bad = { simulate: () => Promise.reject(new Error("no rule")) };
    expect((await check(bad)).map((f) => f.code)).toEqual(["simulation_rejected"]);
  });

  it("rejects a start rarity that is not an id of the release", async () => {
    const craft = { simulate: () => Promise.resolve({ successChance: ok(0.2) }) };
    const task = craftTask(
      ctxWith(),
      { promptVersion: "t" } as StageConfig,
      slot(),
      {} as never,
    ) as never as {
      check: (
        c: unknown,
        x: unknown,
      ) => Promise<{ code: string; path?: string; message: string }[]>;
    };
    const withRelease = ctxWith({
      craft,
      catalog: {
        get: () => ({ entity: {} }),
        release: { rarities: { rarities: [{ id: "magic", name: "Magic" }] } },
      },
    });
    const sub = CraftSubmission.parse({ ...submission, startRarity: "Magic" });
    const bad = await task.check(sub, withRelease);
    expect(bad.map((f) => f.code)).toEqual(["unknown_rarity"]);
    expect(bad[0]?.path).toBe("/startRarity");
    const good = CraftSubmission.parse({ ...submission, startRarity: "magic" });
    expect(await task.check(good, withRelease)).toEqual([]);
  });

  it("warns when the release has no rarities to check the start rarity against", async () => {
    const craft = { simulate: () => Promise.resolve({ successChance: ok(0.2) }) };
    const task = craftTask(
      ctxWith(),
      { promptVersion: "t" } as StageConfig,
      slot(),
      {} as never,
    ) as never as {
      check: (c: unknown, x: unknown) => Promise<{ code: string; severity: string }[]>;
    };
    const bare = ctxWith({ craft, catalog: { get: () => ({ entity: {} }) } });
    expect(await task.check(CraftSubmission.parse(submission), bare)).toMatchObject([
      { code: "rarity_unchecked", severity: "warning" },
    ]);
  });

  it("warns when the simulator cannot evaluate the strategy", async () => {
    const craft = {
      simulate: () => Promise.resolve({ successChance: { status: "uncalibrated", reason: "x" } }),
    };
    expect((await check(craft)).map((f) => f.code)).toEqual(["simulation_uncalibrated"]);
  });

  it("fails loudly when the simulator is missing", async () => {
    await expect(check(undefined)).rejects.toThrow(/simulator/);
  });
});

describe("S8 plan job", () => {
  const run = async (economy: unknown, passed: unknown) => {
    const craft = {
      simulate: () =>
        Promise.resolve({
          expectedCost: { status: "uncalibrated", reason: "x" },
          successChance: ok(0.25),
          expectedAttempts: ok(4),
          steps: [{ order: 0, reached: ok(1), passed }],
        }),
    };
    const step = craftPlanJob(ctxWith(), [slot()], {} as never) as never as {
      run: (c: unknown) => Promise<{
        plans: {
          start: { cost: { status: string } };
          steps: unknown[];
          successChance?: { status: string; value?: number };
          expectedAttempts?: { status: string };
        }[];
      }>;
    };
    return step.run(ctxWith({ craft, economy }));
  };

  it("keeps an unpriced start and the per-step attempts uncalibrated", async () => {
    const out = await run(undefined, ok(0.25));
    const first = out.plans[0];
    expect(first?.start.cost.status).toBe("uncalibrated");
    expect(first?.steps[0]).toMatchObject({ expectedAttempts: { status: "uncalibrated" } });
  });

  it("takes the success chance and attempts of the whole strategy from the simulation", async () => {
    const out = await run(undefined, ok(0.25));
    const first = out.plans[0];
    expect(first?.successChance?.status).toBe("ok");
    expect(first?.successChance?.value).toBe(0.25);
    expect(first?.expectedAttempts).toBeDefined();
  });

  it("uses the base price only for a start item without mods", async () => {
    const price = {
      status: "ok",
      value: { amount: 3, currencyItemId: "Cur" },
      source: {
        kind: "market",
        provider: "p",
        league: "L",
        fetchedAt: "2026-01-01T00:00:00Z",
        confidence: "high",
      },
    };
    const economy = {
      price: () =>
        Promise.resolve({
          inCurrencyItemId: "Cur",
          freshness: "fresh",
          prices: [{ item: { kind: "baseItem", id: "FixBase" }, price }],
        }),
    };
    const out = await run(economy, ok(0.5));
    expect(out.plans[0]?.start.cost.status).toBe(
      CraftSubmission.parse(submission).startModIds.length === 0 ? "ok" : "uncalibrated",
    );
  });

  it("shows a failed price fetch as failed start cost", async () => {
    const economy = { price: () => Promise.reject(new Error("offline")) };
    const out = await run(economy, ok(0.5));
    expect(out.plans[0]?.start.cost.status).toBe("failed");
  });
});
