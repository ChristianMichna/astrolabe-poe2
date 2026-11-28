import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../App";
import { guideIdOf, parseRoute } from "../shell/route";
import { publishedGuide } from "../fixtures/guide-fixture";

const GUIDE_ID = publishedGuide.metadata.guideId;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const view = {
  guide: publishedGuide,
  catalogReleaseId: publishedGuide.metadata.dataReleaseId,
  current: true,
  gear: [
    {
      budgetTier: "tier-a",
      slot: "FixtureSlot",
      target: {
        kind: "unique",
        name: "Fixture Unique Name",
        baseName: "Fixture Base",
        itemClass: "fixture_class",
        implicits: [{ modId: "Fixture/Implicit", text: "Implicit text" }],
        explicits: [{ text: "Unique line" }, { modId: "Fixture/NoText" }],
      },
      alternatives: [null],
    },
  ],
  names: {
    "gem:Fixture/Gems/Main": "Main Skill",
    "ascendancy:fixture_asc": "Fixture Ascendancy",
    "gem:Fixture/Gems/Support": "Support Skill",
  },
  results: {
    "calc-1": {
      calcId: "calc-1",
      pobVersion: "v9.9.9",
      dataReleaseId: publishedGuide.metadata.dataReleaseId,
      calcProfile: "default",
      inputHash: "a".repeat(64),
      computedAt: "2026-01-01T00:00:00Z",
      stats: { FixtureStatA: 1234.5 },
      warnings: [],
      unsupportedMods: [],
    },
  },
  unresolved: ["passiveNode:fixture_node_1"],
};

describe("route", () => {
  it("knows the guide list and one guide", () => {
    expect(parseRoute("#/guide")).toBe("guide");
    expect(parseRoute(`#/guide/${GUIDE_ID}`)).toBe("guide");
    expect(guideIdOf("#/guide")).toBeUndefined();
    expect(guideIdOf("#/guide/")).toBeUndefined();
    expect(guideIdOf("#/guide/a%20b")).toBe("a b");
  });
});

describe("guide list", () => {
  it("lists guides with names and says which one cannot be read", async () => {
    vi.stubGlobal("fetch", () =>
      json({
        guides: [
          {
            guideId: GUIDE_ID,
            dataReleaseId: publishedGuide.metadata.dataReleaseId,
            generatedAt: "2026-01-01T00:00:00Z",
            ascendancyId: "fixture_asc",
            ascendancyName: "Fixture Ascendancy",
            mainSkillId: "Fixture/Gems/Main",
            current: false,
            origin: "imported",
          },
          { guideId: "broken-guide-id", error: "The stored guide cannot be read." },
        ],
      }),
    );
    window.location.hash = "#/guide";
    render(<App />);
    expect(await screen.findByText("Fixture Ascendancy")).toBeTruthy();
    // no name for the skill: the id stays visible instead of a made-up name
    expect(screen.getByText(/Fixture\/Gems\/Main/)).toBeTruthy();
    expect(screen.getByText("Older game data")).toBeTruthy();
    expect(screen.getByText("Imported file")).toBeTruthy();
    expect(screen.getByText("The stored guide cannot be read.")).toBeTruthy();
  });

  it("marks no file origin on a guide made by a run", async () => {
    vi.stubGlobal("fetch", () =>
      json({
        guides: [
          {
            guideId: GUIDE_ID,
            dataReleaseId: publishedGuide.metadata.dataReleaseId,
            generatedAt: "2026-01-01T00:00:00Z",
            ascendancyId: "fixture_asc",
            ascendancyName: "Fixture Ascendancy",
            mainSkillId: "Fixture/Gems/Main",
            current: true,
            origin: "run",
          },
        ],
      }),
    );
    window.location.hash = "#/guide";
    render(<App />);
    expect(await screen.findByText("Fixture Ascendancy")).toBeTruthy();
    expect(screen.queryByText("Imported file")).toBeNull();
  });

  it("shows the server's error", async () => {
    vi.stubGlobal("fetch", () =>
      json(
        { error: { code: "invalid_request", message: "Listing guides needs the run store." } },
        400,
      ),
    );
    window.location.hash = "#/guide";
    render(<App />);
    expect(await screen.findByText("Listing guides needs the run store.")).toBeTruthy();
  });
});

describe("guide page", () => {
  it("shows names, numbers from the stored calculation and what is missing", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(() => json(view));
    vi.stubGlobal("fetch", fetchMock);
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Fixture Ascendancy: Main Skill",
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/guides/${GUIDE_ID}/view`);
    // the fixture's calc segment resolves to the stored value
    expect(screen.getAllByText("1,235").length).toBeGreaterThan(0);
    expect(screen.getByText(/passiveNode:fixture_node_1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as .build file" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Level 1–10/ })).toBeTruthy();
  });

  it("shows an unavailable calculation as its stat name, never as a number", async () => {
    vi.stubGlobal("fetch", () => json({ ...view, results: {}, unresolved: ["calc:calc-1"] }));
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect((await screen.findAllByText("FixtureStatA")).length).toBeGreaterThan(0);
    expect(screen.queryByText("1,235")).toBeNull();
  });

  it("shows the gear plan's items with catalog texts and says what is unknown", async () => {
    vi.stubGlobal("fetch", () => json(view));
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    // The paper doll holds the card for hovering and the selected slot shows it again below.
    expect((await screen.findAllByText("Fixture Unique Name")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Implicit text").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unique line").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Unknown modifier \(Fixture\/NoText\)/).length).toBeGreaterThan(0);
  });

  it("shows the crafting flow with uncalibrated numbers as such and measured ones with their source", async () => {
    const measuredStep = {
      ...publishedGuide.crafting[0]?.steps[0],
      successChance: {
        status: "ok",
        value: 0.25,
        source: {
          kind: "derived",
          formula: "crafting.chance",
          formulaVersion: "1",
          inputs: [
            {
              kind: "market",
              provider: "fixture",
              league: "Fixture",
              fetchedAt: "2026-01-01T00:00:00Z",
              confidence: "high",
            },
          ],
        },
      },
    };
    const guide = {
      ...publishedGuide,
      crafting: [{ ...publishedGuide.crafting[0], steps: [measuredStep] }],
    };
    vi.stubGlobal("fetch", () => json({ ...view, guide }));
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText("Step 1")).toBeTruthy();
    expect(screen.getByText("25.0")).toBeTruthy();
    expect(
      screen.getAllByText(/Derived · crafting\.chance v1; market Fixture/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/On failure: go to step 1/)).toBeTruthy();
    expect(screen.getAllByText(/uncalibrated/i).length).toBeGreaterThan(0);
  });

  it("shows the chance of the whole plan, and says so for a guide that has none", async () => {
    const derived = {
      kind: "derived",
      formula: "crafting.plan",
      formulaVersion: "1",
      inputs: [
        {
          kind: "gamedata",
          dataReleaseId: publishedGuide.metadata.dataReleaseId,
          entity: { kind: "mod", id: "FixtureMod1" },
          field: "/spawnWeights/0/weight",
        },
      ],
    };
    const withPlan = {
      ...publishedGuide,
      crafting: [
        {
          ...publishedGuide.crafting[0],
          successChance: { status: "ok", value: 0.015, source: derived },
          expectedAttempts: { status: "ok", value: 65, source: derived },
        },
      ],
    };
    vi.stubGlobal("fetch", () => json({ ...view, guide: withPlan }));
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText("Chance of the whole plan (%)")).toBeTruthy();
    expect(screen.getByText("1.5")).toBeTruthy();
    expect(screen.getByText("65.0")).toBeTruthy();
    cleanup();

    const older = {
      ...publishedGuide,
      crafting: [{ ...publishedGuide.crafting[0], successChance: undefined }],
    };
    vi.stubGlobal("fetch", () => json({ ...view, guide: older }));
    render(<App />);
    expect(
      (await screen.findAllByText(/written before the chance of the whole plan was measured/))
        .length,
    ).toBeGreaterThan(0);
  });

  it("shows a failed crafting number as an error, not as 0", async () => {
    const failedStep = {
      ...publishedGuide.crafting[0]?.steps[0],
      expectedCost: {
        status: "failed",
        error: { code: "price_failed", message: "Price lookup failed." },
      },
    };
    const guide = {
      ...publishedGuide,
      crafting: [{ ...publishedGuide.crafting[0], steps: [failedStep] }],
    };
    vi.stubGlobal("fetch", () => json({ ...view, guide }));
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText(/Price lookup failed\./)).toBeTruthy();
  });

  it("says when the tree data cannot be loaded", async () => {
    vi.stubGlobal("fetch", (url: string) =>
      url.endsWith("/api/tree")
        ? json({ error: { code: "internal", message: "Tree is down." } }, 500)
        : json(view),
    );
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText(/Tree is down\./)).toBeTruthy();
  });

  it("says that the node pictures are missing and keeps the tree", async () => {
    vi.stubGlobal("fetch", (url: string) =>
      url.endsWith("/api/tree")
        ? json({
            dataReleaseId: view.catalogReleaseId,
            passiveNodes: [],
            passiveGroups: [],
            skipped: [],
          })
        : url.includes("/api/tree/icons")
          ? json({ error: { code: "icons_unavailable", message: "No sheets here." } }, 503)
          : json(view),
    );
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText(/Node pictures are not available/)).toBeTruthy();
    expect(screen.getByText(/No sheets here\./)).toBeTruthy();
  });

  it("does not draw a tree of another release than the guide was read with", async () => {
    vi.stubGlobal("fetch", (url: string) =>
      url.endsWith("/api/tree")
        ? json({
            dataReleaseId: "poe2-0.0.1+r1",
            passiveNodes: [],
            passiveGroups: [],
            skipped: [],
          })
        : json(view),
    );
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText(/The game data changed/)).toBeTruthy();
  });

  it("shows the engine numbers of a stage with their source and says what is missing", async () => {
    const stage = publishedGuide.progression.stages[0];
    const guide = {
      ...publishedGuide,
      progression: {
        stages: [{ ...stage, act: 2, calcs: { mapping: { status: "ok", calcId: "calc-1" } } }],
      },
    };
    const result = {
      ...view.results["calc-1"],
      stats: { CombinedDPS: 4321, TotalEHP: 8765 },
    };
    vi.stubGlobal("fetch", () => json({ ...view, guide, results: { "calc-1": result } }));
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText("4,321")).toBeTruthy();
    expect(screen.getByText("8,765")).toBeTruthy();
    expect(screen.getByText(/Act 2 · Level 1–10/)).toBeTruthy();
    // A stat the result does not contain is uncalibrated, not 0.
    expect(screen.getByText(/did not report SpiritUnreserved/)).toBeTruthy();
  });

  it("shows the minion damage instead of the player's own 0 for a minion build", async () => {
    const stage = publishedGuide.progression.stages[0];
    const guide = {
      ...publishedGuide,
      progression: {
        stages: [{ ...stage, calcs: { mapping: { status: "ok", calcId: "calc-1" } } }],
      },
    };
    const result = {
      ...view.results["calc-1"],
      stats: { CombinedDPS: 0, MinionCombinedDPS: 1234, TotalEHP: 8765 },
    };
    vi.stubGlobal("fetch", () => json({ ...view, guide, results: { "calc-1": result } }));
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText("1,234")).toBeTruthy();
    expect(screen.getByText("Minion damage per second", { selector: "dt" })).toBeTruthy();
    expect(screen.queryByText("Damage per second", { selector: "dt" })).toBeNull();
  });

  it("keeps the player's damage row and hides the minion row without minion stats", async () => {
    const stage = publishedGuide.progression.stages[0];
    const guide = {
      ...publishedGuide,
      progression: {
        stages: [{ ...stage, calcs: { mapping: { status: "ok", calcId: "calc-1" } } }],
      },
    };
    const result = { ...view.results["calc-1"], stats: { CombinedDPS: 4321, TotalEHP: 8765 } };
    vi.stubGlobal("fetch", () => json({ ...view, guide, results: { "calc-1": result } }));
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText("Damage per second", { selector: "dt" })).toBeTruthy();
    expect(screen.queryByText("Minion damage per second", { selector: "dt" })).toBeNull();
  });

  it("shows a failed or missing calculation of a stage as an error", async () => {
    const stage = publishedGuide.progression.stages[0];
    const guide = {
      ...publishedGuide,
      progression: {
        stages: [
          {
            ...stage,
            calcs: {
              mapping: { status: "failed", error: { code: "x", message: "Worker timed out." } },
            },
          },
        ],
      },
    };
    vi.stubGlobal("fetch", () => json({ ...view, guide }));
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect((await screen.findAllByText(/Worker timed out\./)).length).toBeGreaterThan(0);
  });

  it("marks a result of another release as outdated and shows the cost of a respec", async () => {
    const stage = publishedGuide.progression.stages[0];
    const guide = {
      ...publishedGuide,
      progression: {
        stages: [
          {
            ...stage,
            calcs: { mapping: { status: "ok", calcId: "calc-1" } },
            respecCost: {
              status: "ok",
              value: { amount: 2.5, currencyItemId: "Fixture/Items/Currency" },
              source: {
                kind: "market",
                provider: "fixture",
                league: "Fixture",
                fetchedAt: "2026-01-01T00:00:00Z",
                confidence: "high",
              },
            },
          },
        ],
      },
    };
    const result = {
      ...view.results["calc-1"],
      dataReleaseId: "poe2-0.0.1+r1",
      stats: { CombinedDPS: 4321 },
    };
    vi.stubGlobal("fetch", () => json({ ...view, guide, results: { "calc-1": result } }));
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText("4,321")).toBeTruthy();
    expect(screen.getByText("Outdated after patch")).toBeTruthy();
    expect(screen.getByText("2.5")).toBeTruthy();
  });

  it("says when a stage has no calculation and when its stored result is gone", async () => {
    const stage = publishedGuide.progression.stages[0];
    const noCalc = { ...publishedGuide, progression: { stages: [{ ...stage, calcs: {} }] } };
    vi.stubGlobal("fetch", () => json({ ...view, guide: noCalc }));
    window.location.hash = `#/guide/${GUIDE_ID}`;
    const first = render(<App />);
    expect(await screen.findByText("No calculation")).toBeTruthy();
    first.unmount();
    const gone = {
      ...publishedGuide,
      progression: {
        stages: [{ ...stage, calcs: { mapping: { status: "ok", calcId: "calc-gone" } } }],
      },
    };
    vi.stubGlobal("fetch", () => json({ ...view, guide: gone }));
    render(<App />);
    expect(
      (await screen.findAllByText(/stored result of this calculation is not available/)).length,
    ).toBeGreaterThan(0);
  });

  it("shows the written sections and the gem changes between stages", async () => {
    const first = publishedGuide.progression.stages[0];
    const second = {
      ...first,
      key: "stage-2",
      order: 1,
      label: "Second stage",
      levelRange: [11, 20],
      state: {
        ...first?.state,
        skills: first?.state.skills.map((s) => ({
          ...s,
          gem: { ...s.gem, level: s.gem.level + 3 },
        })),
      },
    };
    const guide = {
      ...publishedGuide,
      progression: { stages: [first, second] },
      atlas: {
        strategy: publishedGuide.atlas.strategy,
        avoidMods: [{ modId: "Fixture/BadMod", reason: publishedGuide.atlas.strategy }],
      },
    };
    vi.stubGlobal("fetch", () => json({ ...view, guide }));
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText("Fixture rotation")).toBeTruthy();
    expect(screen.getAllByText("Fixture atlas").length).toBeGreaterThan(0);
    expect(screen.getByText("Fixture/BadMod").className).toContain("guide-unresolved");
    expect(screen.getByText("Fixture q")).toBeTruthy();
    expect(screen.getByText("Solo self-found")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Second stage/ }));
    expect(await screen.findByText(/Changes since Fixture stage/)).toBeTruthy();
    expect(screen.getByText(/level 5 → 8/)).toBeTruthy();
  });

  it("shows no gear for a guide of older game data and points to revalidation", async () => {
    vi.stubGlobal("fetch", () =>
      json({
        ...view,
        current: false,
        catalogReleaseId: "poe2-9.9.9+r9",
        names: {},
        gear: [{ ...view.gear[0], target: null, alternatives: [null] }],
      }),
    );
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText(/Revalidate this guide to see its gear/)).toBeTruthy();
    expect(screen.getByText(/Revalidate this guide to see its passive tree/)).toBeTruthy();
    expect(screen.queryByText(/not in the game data/)).toBeNull();
  });

  it("says so when the release does not know the rarity of a crafted item", async () => {
    const crafted = {
      kind: "crafted",
      rarityId: "odd_rarity",
      baseName: "Crafted Base",
      itemClass: "fixture_class",
      implicits: [],
      explicits: [],
    };
    vi.stubGlobal("fetch", () =>
      json({ ...view, gear: [{ ...view.gear[0], target: crafted, alternatives: [] }] }),
    );
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText(/does not know the rarity \(odd_rarity\)/)).toBeTruthy();
  });

  it("says when the guide was built with older game data", async () => {
    vi.stubGlobal("fetch", () =>
      json({ ...view, current: false, catalogReleaseId: "poe2-9.9.9+r9", names: {}, gear: [] }),
    );
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText(/Older game data/)).toBeTruthy();
    expect(screen.getByText(/poe2-9\.9\.9\+r9/)).toBeTruthy();
  });

  it("shows the server's reason when the guide cannot be loaded", async () => {
    vi.stubGlobal("fetch", () =>
      json({ error: { code: "unknown_run", message: "No stored guide." } }, 404),
    );
    window.location.hash = `#/guide/${GUIDE_ID}`;
    render(<App />);
    expect(await screen.findByText(/No stored guide\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the list" }));
    expect(window.location.hash).toBe("#/guide");
  });
});
