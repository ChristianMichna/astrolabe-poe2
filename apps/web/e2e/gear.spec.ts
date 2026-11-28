import { expect, test } from "@playwright/test";
import { publishedGuide } from "../src/fixtures/guide-fixture";

const guideId = publishedGuide.metadata.guideId;
const slots = [
  ["Weapon 1", "rare", "Fixture Bow"],
  ["Weapon 2", "magic", "Fixture Shield"],
  ["Helmet", "rare", "Fixture Helm"],
  ["Amulet", "magic", "Fixture Amulet"],
  ["Body Armour", "unique", "Fixture Body"],
  ["Ring 1", "rare", "Fixture Ring A"],
  ["Ring 2", "rare", "Fixture Ring B"],
  ["Gloves", "normal", "Fixture Gloves"],
  ["Belt", "rare", "Fixture Belt"],
  ["Boots", "rare", "Fixture Boots"],
  ["Charm 1", "magic", "Fixture Charm"],
  ["Charm 2", "magic", "Fixture Charm"],
  ["Flask 1", "normal", "Fixture Flask"],
  ["Flask 2", "normal", "Fixture Flask"],
] as const;

const view = {
  guide: publishedGuide,
  catalogReleaseId: publishedGuide.metadata.dataReleaseId,
  current: true,
  gear: slots.map(([slot, rarity, name]) => ({
    budgetTier: "tier-a",
    slot,
    target: {
      kind: rarity === "unique" ? "unique" : "crafted",
      ...(rarity === "unique" ? { name } : {}),
      rarityName: rarity,
      baseName: rarity === "unique" ? "Fixture Base" : name,
      ...(slot === "Helmet" ? { icon: "assets/items/Fixture_Helm.png" } : {}),
      itemClass: "fixture_class",
      implicits: [],
      explicits: [{ text: `${slot} modifier line` }],
    },
    alternatives: [],
  })),
  names: {},
  results: {},
  unresolved: [],
};

// a 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.route("**/api/release-assets/**", (route) =>
    route.fulfill({ body: PNG, contentType: "image/png" }),
  );
  await page.route(`**/api/guides/${guideId}/view`, (route) => route.fulfill({ json: view }));
  await page.route("**/api/tree", (route) =>
    route.fulfill({ json: { passiveNodes: [], passiveGroups: [], skipped: [] } }),
  );
  await page.goto(`/#/guide/${guideId}`);
  await page.evaluate(() => document.fonts.ready);
});

test("the rings sit level on both sides of the body armour", async ({ page }) => {
  const box = async (slot: string) => {
    const b = await page.locator(".gear-cell", { hasText: slot }).first().boundingBox();
    if (b === null) throw new Error(`no cell for ${slot}`);
    return b;
  };
  const [r1, r2, body] = [await box("Ring 1"), await box("Ring 2"), await box("Body Armour")];
  expect(r1.y).toBe(r2.y);
  expect(r1.x + r1.width).toBeLessThanOrEqual(body.x);
  expect(r2.x).toBeGreaterThanOrEqual(body.x + body.width);
  await expect(page.locator(".gear-cell__icon").first()).toBeVisible();
  const shot = process.env["GEAR_SHOT"];
  if (shot !== undefined) await page.locator(".gear-doll").screenshot({ path: shot });
});

test("the hover card never keeps the next slot from being hovered", async ({ page }) => {
  const weapon = page.locator(".gear-cell", { hasText: "Weapon 1" }).first();
  await weapon.hover();
  const card = weapon.locator(".gear-cell__hover");
  await expect(card).toBeVisible();
  // Move the pointer onto the card's text, then straight to a neighbouring slot.
  const c = await card.boundingBox();
  if (c === null) throw new Error("no card");
  await page.mouse.move(c.x + c.width / 2, c.y + 40);
  await expect(card).toBeHidden();
  const body = page.locator(".gear-cell", { hasText: "Body Armour" }).first();
  await body.hover();
  await expect(body.locator(".gear-cell__hover")).toBeVisible();
});

test("a slot with a release image shows it, with the credit; the others keep the slot icon", async ({
  page,
}) => {
  const helmet = page.locator(".gear-cell", { hasText: "Helmet" }).first();
  await expect(helmet.locator("img.gear-cell__art")).toHaveAttribute(
    "src",
    "/api/release-assets/assets/items/Fixture_Helm.png",
  );
  await expect(
    page.locator(".gear-cell", { hasText: "Belt" }).first().locator("svg.gear-cell__icon"),
  ).toBeVisible();
  await expect(page.getByText("Graphics © Grinding Gear Games")).toBeVisible();
});

test("a release image that cannot be loaded leaves the slot icon", async ({ page }) => {
  await page.route("**/api/release-assets/**", (route) =>
    route.fulfill({ status: 404, json: { error: { message: "No item image." } } }),
  );
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  const helmet = page.locator(".gear-cell", { hasText: "Helmet" }).first();
  await expect(helmet.locator("svg.gear-cell__icon")).toBeVisible();
  await expect(helmet.locator("img.gear-cell__art")).toHaveCount(0);
});
