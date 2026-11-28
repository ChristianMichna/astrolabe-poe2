import { describe, expect, it } from "vitest";
import type { GuideView } from "@astrolabe/contracts/guide";
import { diffRevisions } from "./revision-diff";

const stage = (calcId: string, supports: string[]) => ({
  key: "act-1",
  label: "Act 1",
  calcs: { mapping: { status: "ok", calcId } },
  state: {
    skills: [
      {
        key: "main",
        gem: { gemId: "gem-main" },
        supports: supports.map((gemId) => ({ gemId })),
      },
    ],
  },
});

const card = (name: string) => ({
  kind: "unique" as const,
  name,
  baseName: "Base",
  itemClass: "ring",
  implicits: [],
  explicits: [],
});

function view(opts: {
  calcId: string;
  dps: number | undefined;
  supports: string[];
  ring: string;
  plans: string[];
}): GuideView {
  return {
    guide: {
      progression: { stages: [stage(opts.calcId, opts.supports)] },
      crafting: opts.plans.map((key) => ({ key, slot: `Slot ${key}` })),
    },
    gear: [{ budgetTier: "start", slot: "Ring", target: card(opts.ring), alternatives: [] }],
    names: { "gem:gem-main": "Main", "gem:gem-a": "Support A", "gem:gem-b": "Support B" },
    results: {
      [opts.calcId]: { stats: opts.dps === undefined ? {} : { CombinedDPS: opts.dps } },
    },
  } as unknown as GuideView;
}

describe("diffRevisions", () => {
  it("lists changed numbers, gems, gear and crafting plans of two revisions", () => {
    const diff = diffRevisions(
      view({ calcId: "c1", dps: 100, supports: ["gem-a"], ring: "Old Ring", plans: ["p1"] }),
      view({ calcId: "c2", dps: 150, supports: ["gem-b"], ring: "New Ring", plans: ["p2"] }),
    );
    expect(diff.stats).toContainEqual(
      expect.objectContaining({ stage: "Act 1", stat: "CombinedDPS", before: 100, after: 150 }),
    );
    expect(diff.skills).toEqual([{ stage: "Act 1", added: ["Support B"], removed: ["Support A"] }]);
    expect(diff.gear).toEqual([
      { tier: "start", slot: "Ring", before: "Old Ring", after: "New Ring" },
    ]);
    expect(diff.craftingAdded).toEqual(["Slot p2"]);
    expect(diff.craftingRemoved).toEqual(["Slot p1"]);
    expect(diff.empty).toBe(false);
  });

  it("keeps a missing number missing instead of showing 0", () => {
    const diff = diffRevisions(
      view({ calcId: "c1", dps: 100, supports: [], ring: "R", plans: [] }),
      view({ calcId: "c2", dps: undefined, supports: [], ring: "R", plans: [] }),
    );
    expect(diff.stats).toEqual([
      expect.objectContaining({ stat: "CombinedDPS", before: 100, after: undefined }),
    ]);
  });

  it("is empty for two equal revisions", () => {
    const a = view({ calcId: "c1", dps: 100, supports: ["gem-a"], ring: "R", plans: ["p1"] });
    expect(diffRevisions(a, a).empty).toBe(true);
  });
});
