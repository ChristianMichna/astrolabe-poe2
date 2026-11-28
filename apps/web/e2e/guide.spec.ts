import { expect, test } from "@playwright/test";
import { publishedGuide } from "../src/fixtures/guide-fixture";

const guideId = publishedGuide.metadata.guideId;
const derived = {
  kind: "derived",
  formula: "crafting.expected-cost",
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
};
const craftingPlan = publishedGuide.crafting[0];
const guideWithCrafting = {
  ...publishedGuide,
  crafting: [
    {
      ...craftingPlan,
      steps: [
        {
          ...craftingPlan?.steps[0],
          successChance: { status: "ok", value: 0.25, source: derived },
          expectedAttempts: { status: "ok", value: 4, source: derived },
          onFail: { action: "repeat" },
        },
        { ...craftingPlan?.steps[0], order: 1, onFail: { action: "restart" } },
      ],
    },
  ],
};
const stage0 = guideWithCrafting.progression.stages[0];
const guideWithNumbers = {
  ...guideWithCrafting,
  progression: {
    stages: [{ ...stage0, act: 1, calcs: { mapping: { status: "ok", calcId: "calc-1" } } }],
  },
};
const view = {
  guide: guideWithNumbers,
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
        explicits: [{ text: "Unique line" }],
      },
      alternatives: [],
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
      stats: { FixtureStatA: 1234.5, CombinedDPS: 98765, TotalEHP: 4321, MissingFireResist: 12 },
      warnings: [],
      unsupportedMods: [],
    },
  },
  unresolved: [],
};

const treeData = {
  dataReleaseId: publishedGuide.metadata.dataReleaseId,
  passiveNodes: [
    {
      id: "fixture_node_0",
      name: "Fixture Start",
      kind: "small",
      stats: [],
      position: { groupId: "g1", orbit: 0, orbitIndex: 0, point: { x: 0, y: 0 } },
      connections: ["fixture_node_1"],
      classStartFor: ["fixture_class"],
    },
    {
      id: "fixture_node_1",
      name: "Fixture Notable",
      kind: "notable",
      stats: [{ text: "Fixture stat line" }],
      position: { groupId: "g1", orbit: 0, orbitIndex: 0, point: { x: 400, y: 300 } },
      connections: ["fixture_node_0"],
    },
  ],
  passiveGroups: [{ id: "g1", center: { x: 0, y: 0 }, orbitRadii: [0] }],
  skipped: [],
};

test("a saved guide opens in the window with its stages and numbers", async ({ page }) => {
  await page.route(`**/api/guides/${guideId}/view`, (route) => route.fulfill({ json: view }));
  await page.route("**/api/tree", (route) => route.fulfill({ json: treeData }));
  await page.goto(`/#/guide/${guideId}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Fixture Ascendancy");
  await expect(page.getByText("1,235").first()).toBeVisible();
  await expect(page.getByText("Fixture Unique Name").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as .build file" })).toBeVisible();
  await expect(page.getByText("Fixture Notable").first()).toBeVisible();
  const shot = process.env["GUIDE_SHOT"];
  if (shot !== undefined) await page.screenshot({ path: shot, fullPage: true });
});
