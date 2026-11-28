import { describe, expect, it } from "vitest";
import {
  BuildRequest,
  BuildState,
  CraftingPlan,
  GUIDE_FILE_FORMAT,
  GuideDocument,
  GuideFile,
  ItemSpec,
  ProgressionStage,
  PublishedGuide,
  ResearchFinding,
  ResearchFindings,
  RichText,
} from "../src/index.js";
import { without } from "./helpers.js";

const releaseId = "poe2-9.8.7+r3";
const calcOk = { status: "ok", calcId: "calc-1" } as const;
const text = (t: string) => [{ type: "text", text: t }];
const pob = {
  kind: "pob",
  pobVersion: "v9.9.9",
  dataReleaseId: releaseId,
  calcProfile: "fixture-profile",
  calcId: "calc-1",
} as const;

const request = {
  dataReleaseId: releaseId,
  skillIdea: "Fixture idea",
  mainSkillId: "Fixture/Gems/Main",
  mode: { hardcore: false, ssf: false },
  budget: { leveling: "tier-a", endgame: "tier-b" },
  preferences: {
    focus: "allround",
    pace: "balanced",
    complexityTolerance: "medium",
  },
};

const state = {
  classId: "fixture_class",
  ascendancyId: "fixture_asc",
  level: 10,
  tree: { allocated: [{ nodeId: "fixture_node_1" }] },
  skills: [
    {
      key: "main",
      role: "main",
      gem: { gemId: "Fixture/Gems/Main", level: 5 },
      supports: [{ gemId: "Fixture/Gems/Support", level: 5 }],
    },
  ],
  items: [{ slot: "FixtureSlot", item: { kind: "unique", uniqueId: "Fixture Unique" } }],
};

const stage = {
  key: "stage-1",
  order: 0,
  label: "Fixture stage",
  kind: "campaign",
  levelRange: [1, 10],
  state,
  allocationOrder: ["fixture_node_1"],
  tasks: [text("Fixture task")],
  calcs: { "fixture-profile": calcOk },
};

const market = {
  kind: "market",
  provider: "fixture-market",
  league: "Fixture League",
  fetchedAt: "2026-01-01T00:00:00Z",
  confidence: "low",
} as const;
const price = {
  status: "ok",
  value: { amount: 1, currencyItemId: "Fixture/Currency/A" },
  source: market,
};
const uncal = { status: "uncalibrated", reason: "no market data" };

const crafting = {
  key: "craft-1",
  slot: "FixtureSlot",
  target: {
    kind: "crafted",
    baseItemId: "Fixture/Items/BaseAlpha",
    rarity: "fixture_rarity",
    mods: [{ modId: "FixtureMod1", required: true }],
  },
  start: { baseItemId: "Fixture/Items/BaseAlpha", itemLevel: 1, cost: uncal },
  steps: [
    {
      order: 0,
      actionIds: ["Fixture/Currency/A"],
      goal: text("Fixture goal"),
      successChance: uncal,
      expectedAttempts: uncal,
      expectedCost: uncal,
      onFail: { action: "goto", order: 0 },
    },
  ],
  expectedTotal: uncal,
};

const guide = {
  metadata: {
    guideId: "00000000-0000-4000-8000-000000000001",
    revision: 0,
    schemaVersion: 1,
    dataReleaseId: releaseId,
    pobVersion: "v9.9.9",
    generatedAt: "2026-01-01T00:00:00Z",
    models: [{ taskClass: "planner", model: "fixture-model" }],
    promptVersions: { "S2.archetype": "1" },
  },
  request,
  summary: {
    classId: "fixture_class",
    ascendancyId: "fixture_asc",
    mainSkillId: "Fixture/Gems/Main",
    damageTypes: ["fixture_damage"],
    scalingAxes: text("Fixture scaling"),
    defenceLayers: ["fixture_defence"],
    playstyle: text("Fixture playstyle"),
    complexity: "low",
    strengths: [text("Fixture strength")],
    weaknesses: [text("Fixture weakness")],
    budgetRange: { from: "tier-a", to: "tier-b" },
    suitability: { softcore: true, hardcore: false, ssf: true },
  },
  mechanics: {
    explanation: [
      { type: "text", text: "Fixture deals " },
      { type: "calc", ref: { calcId: "calc-1", stat: "FixtureStatA" } },
      { type: "entity", ref: { kind: "gem", id: "Fixture/Gems/Main" } },
    ],
    decisions: [{ reason: text("Fixture reason") }],
  },
  progression: { stages: [stage] },
  gear: {
    tiers: [
      {
        budgetTier: "tier-a",
        slots: [
          {
            slot: "FixtureSlot",
            priority: "core",
            target: state.items[0]?.item,
            acquisition: "drop",
            cost: price,
          },
        ],
        upgradeOrder: [{ slot: "FixtureSlot", gainPerCost: uncal }],
      },
    ],
  },
  crafting: [crafting],
  playstyle: {
    rotation: text("Fixture rotation"),
    mapping: text("Fixture mapping"),
    bossing: text("Fixture bossing"),
    positioning: text("Fixture positioning"),
    bossMechanics: [],
  },
  atlas: { strategy: text("Fixture atlas"), avoidMods: [] },
  variants: [{ kind: "ssf", explanation: text("Fixture ssf") }],
  faq: [{ question: text("Fixture q"), answer: text("Fixture a") }],
};

describe("BuildRequest", () => {
  it("accepts a minimal request and applies defaults", () => {
    const r = BuildRequest.parse(request);
    expect(r.exclusions).toEqual([]);
    expect(r.preferences.defenceLayers).toEqual([]);
  });

  it("rejects budget tiers that are not config ids", () => {
    const bad = { ...request, budget: { leveling: "Tier A", endgame: "tier-b" } };
    expect(BuildRequest.safeParse(bad).success).toBe(false);
  });
});

describe("BuildState", () => {
  it("accepts a state with defaults for weapon set and config", () => {
    const s = BuildState.parse(state);
    expect(s.tree.allocated[0]?.weaponSet).toBe(0);
    expect(s.config).toEqual({});
  });

  it("items are either a unique or a crafted base with mod ids", () => {
    expect(ItemSpec.safeParse({ kind: "unique" }).success).toBe(false);
    expect(
      ItemSpec.safeParse({ kind: "crafted", baseItemId: "b", rarity: "r", mods: [{ modId: "m" }] })
        .success,
    ).toBe(false); // required flag missing
  });

  it("mod rolls are fractions of the catalog range, not values", () => {
    const mod = { modId: "m", required: true, rollFraction: 1.5 };
    const item = { kind: "crafted", baseItemId: "b", rarity: "r", mods: [mod] };
    expect(ItemSpec.safeParse(item).success).toBe(false);
  });
});

describe("RichText", () => {
  it("has no number segment: numbers come only as calc references", () => {
    expect(RichText.safeParse([{ type: "number", value: 5 }]).success).toBe(false);
    expect(RichText.safeParse([]).success).toBe(false);
  });
});

describe("stages", () => {
  it("progression stage needs an ascending level range and tasks", () => {
    expect(ProgressionStage.safeParse(stage).error).toBeUndefined();
    expect(ProgressionStage.safeParse({ ...stage, levelRange: [10, 1] }).success).toBe(false);
    expect(ProgressionStage.safeParse({ ...stage, tasks: [] }).success).toBe(false);
  });

  it("a crafting plan may name the gear tier it belongs to", () => {
    expect(CraftingPlan.safeParse({ ...crafting, tier: "mid" }).error).toBeUndefined();
    expect(CraftingPlan.safeParse({ ...crafting, tier: "" }).success).toBe(false);
  });

  it("crafting costs are measured: uncalibrated is explicit, a bare number is rejected", () => {
    expect(CraftingPlan.safeParse(crafting).error).toBeUndefined();
    const bare = { ...crafting, expectedTotal: 12 };
    expect(CraftingPlan.safeParse(bare).success).toBe(false);
  });
});

describe("number provenance in plans", () => {
  it("prices may not claim a PoB source", () => {
    const pobPrice = { ...price, source: pob };
    const g = structuredClone(guide);
    const slot = g.gear.tiers[0]?.slots[0];
    if (!slot) throw new Error("fixture changed");
    (slot as { cost: unknown }).cost = pobPrice;
    expect(GuideDocument.safeParse(g).success).toBe(false);
  });

  it("chances must be within 0..1 and from game data or derived", () => {
    const step = crafting.steps[0];
    const gamedata = {
      kind: "gamedata",
      dataReleaseId: releaseId,
      entity: { kind: "mod", id: "FixtureMod1" },
      field: "/spawnWeights/0/weight",
    };
    const ok = { ...step, successChance: { status: "ok", value: 0.5, source: gamedata } };
    expect(CraftingPlan.safeParse({ ...crafting, steps: [ok] }).error).toBeUndefined();
    const tooBig = { ...step, successChance: { status: "ok", value: 2, source: gamedata } };
    expect(CraftingPlan.safeParse({ ...crafting, steps: [tooBig] }).success).toBe(false);
    const fromMarket = { ...step, successChance: { status: "ok", value: 0.5, source: market } };
    expect(CraftingPlan.safeParse({ ...crafting, steps: [fromMarket] }).success).toBe(false);
  });
});

describe("PublishedGuide", () => {
  it("requires a passed validation report", () => {
    expect(PublishedGuide.safeParse(guide).success).toBe(false);
    const validation = {
      gates: [{ gate: "G1", passed: true, findings: [] }],
      completenessScore: 95,
      scoringConfigVersion: "1",
      passed: true,
    };
    expect(PublishedGuide.safeParse({ ...guide, validation }).error).toBeUndefined();
    const failed = { ...validation, passed: false };
    expect(PublishedGuide.safeParse({ ...guide, validation: failed }).success).toBe(false);
  });
});

describe("GuideFile", () => {
  const validation = {
    gates: [{ gate: "G1", passed: true, findings: [] }],
    completenessScore: 95,
    scoringConfigVersion: "1",
    passed: true,
  };
  const result = {
    calcId: "calc-1",
    pobVersion: "v9.9.9",
    dataReleaseId: "poe2-9.8.7+r3",
    calcProfile: "fixture-profile",
    inputHash: "a".repeat(64),
    computedAt: "2026-01-01T00:00:00Z",
    stats: { FixtureStatA: 1 },
    warnings: [],
    unsupportedMods: [],
  };
  const file = {
    format: GUIDE_FILE_FORMAT,
    version: 1,
    guide: { ...guide, validation },
    results: { "calc-1": result },
  };

  it("accepts a guide with its results", () => {
    expect(GuideFile.safeParse(file).error).toBeUndefined();
  });

  it("rejects a file without the result of a calcId the guide refers to", () => {
    const missing = GuideFile.safeParse({ ...file, results: {} });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((i) => i.path.join("."))).toContain("results");
    const wrongKey = GuideFile.safeParse({ ...file, results: { "calc-2": result } });
    expect(wrongKey.error?.issues.map((i) => i.path.join("."))).toContain("results.calc-2");
  });

  it("rejects another format, version or a result under the wrong calcId", () => {
    expect(GuideFile.safeParse({ ...file, format: "other" }).success).toBe(false);
    expect(GuideFile.safeParse({ ...file, version: 2 }).success).toBe(false);
    const wrong = GuideFile.safeParse({ ...file, results: { "calc-2": result } });
    expect(wrong.success).toBe(false);
  });
});

describe("GuideDocument", () => {
  it("accepts a complete fixture guide", () => {
    expect(GuideDocument.safeParse(guide).error).toBeUndefined();
  });

  it.each([
    "metadata",
    "request",
    "summary",
    "mechanics",
    "progression",
    "gear",
    "crafting",
    "playstyle",
    "atlas",
    "variants",
    "faq",
  ])("rejects a guide without %s", (part) => {
    const g = without(guide, part as keyof typeof guide);
    expect(GuideDocument.safeParse(g).success).toBe(false);
  });
});

describe("research findings (ADR-0006)", () => {
  const finding = {
    id: "boss-order",
    section: "playstyle",
    topic: "Order of the boss phases",
    claim: [{ type: "text", text: "Fixture claim in the researcher's own words." }],
    source: {
      url: "https://example.test/guide",
      title: "Fixture guide",
      retrievedAt: "2026-11-28T00:00:00Z",
    },
  };

  it("accepts a finding, defaults its entities and lets text cite it", () => {
    const parsed = ResearchFinding.parse(finding);
    expect(parsed.entities).toEqual([]);
    expect(
      RichText.parse([
        { type: "text", text: "See" },
        { type: "source", id: "boss-order" },
      ]),
    ).toHaveLength(2);
  });

  it("rejects links that are not https and findings without a source", () => {
    expect(() =>
      ResearchFinding.parse({
        ...finding,
        source: { ...finding.source, url: "http://example.test" },
      }),
    ).toThrow();
    expect(() =>
      ResearchFinding.parse({
        ...finding,
        source: { ...finding.source, url: "https://user:pw@example.test/" },
      }),
    ).toThrow();
    expect(() =>
      ResearchFinding.parse({
        ...finding,
        source: { ...finding.source, url: "javascript:alert(1)" },
      }),
    ).toThrow();
    for (const url of [
      "https://example.test\\@evil.example/",
      "https://example.test:99999/",
      "https://[::1]/",
      "https://example.test/a\tb",
      "https://example.test/a\nb",
      "https://example.test/a b",
    ]) {
      expect(() =>
        ResearchFinding.parse({ ...finding, source: { ...finding.source, url } }),
      ).toThrow();
    }
    expect(() => ResearchFinding.parse(without(finding, "source"))).toThrow();
    expect(() => RichText.parse([{ type: "source", id: "Not A Slug" }])).toThrow();
  });

  it("keeps the ids of a guide's findings unique", () => {
    expect(() => ResearchFindings.parse([finding, finding])).toThrow(/not unique/);
    expect(ResearchFindings.parse([finding])).toHaveLength(1);
  });
});
