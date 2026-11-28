import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

async function openTree(page: Page) {
  await page.goto("/#/tree");
  await page.evaluate(() => document.fonts.ready);
  // the WebGL renderer marks its frame once the tree is drawn
  await expect(page.locator(".ef-tree__main")).toHaveAttribute("data-status", "ready", {
    timeout: 20_000,
  });
}

test("passive tree renders real tree data with the sample allocation", async ({ page }) => {
  await openTree(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Passive Tree");
  await expect(page.getByText("Sample build · made-up allocation")).toBeVisible();
  await expect(page.getByRole("region", { name: "Build-up" })).toBeVisible();
  await expect(page.getByText("Game data · poe2-", { exact: false })).toBeVisible();
  await expect(page).toHaveScreenshot("passive-tree.png");
});

test("the timeline shows a respec stage with struck-through passives", async ({ page }) => {
  await openTree(page);
  await page.getByRole("button", { name: /Early Endgame/ }).click();
  const respec = page.locator(".ef-tree__list--respec li");
  await expect(respec).toHaveCount(3);
  await respec.first().getByRole("button").click();
  await expect(page.getByRole("tooltip")).toContainText("Respec");
  await expect(page.locator(".ef-tree__main")).toHaveScreenshot("passive-tree-respec.png");
});

test("the canvas follows the window size when the tree goes full screen", async ({ page }) => {
  await page.setViewportSize({ width: 2170, height: 1340 });
  await openTree(page);
  await page.getByRole("button", { name: "Full screen" }).click();
  const host = page.locator(".ef-tree__main");
  await expect
    .poll(async () => {
      const box = await host.boundingBox();
      const canvas = await host.locator("canvas").boundingBox();
      if (box === null || canvas === null) return false;
      return (
        Math.abs(canvas.width - box.width) < 4 &&
        Math.abs(canvas.height - box.height) < 4 &&
        box.width > 1000
      );
    })
    .toBe(true);
  const shot = process.env["TREE_SHOT"];
  if (shot !== undefined) await page.screenshot({ path: shot });
});
