import { describe, expect, it } from "vitest";
import type { PublishedGuide } from "@astrolabe/contracts/guide";
import { guideToMarkdown } from "../src/markdown.js";

const t = (text: string) => [{ type: "text" as const, text }];
const guide = {
  metadata: { revision: 0, dataReleaseId: "poe2-1.0.0+r1", pobVersion: "0.23.1" },
  summary: {
    classId: "c",
    ascendancyId: "a",
    mainSkillId: "g",
    scalingAxes: t("Scales with cold."),
    playstyle: [
      { type: "text", text: "Deals " },
      { type: "calc", ref: { calcId: "x", stat: "CombinedDPS" } },
      { type: "text", text: " with " },
      { type: "entity", ref: { kind: "gem", id: "g" } },
    ],
    strengths: [t("Fast")],
    weaknesses: [t("Fragile")],
  },
  mechanics: { explanation: t("It works."), decisions: [] },
  progression: { stages: [] },
  gear: { tiers: [] },
  crafting: [],
  playstyle: { rotation: t("a"), mapping: t("b"), bossing: t("c"), positioning: t("d") },
  atlas: { strategy: t("e"), avoidMods: [] },
  variants: [],
  faq: [],
  research: [],
} as never as PublishedGuide;

describe("guideToMarkdown", () => {
  it("fills names and numbers from the resolvers", () => {
    const md = guideToMarkdown(guide, {
      entityName: (r) => `Name of ${r.id}`,
      statValue: () => 12345.678,
    });
    expect(md).toContain("# Name of g guide");
    expect(md).toContain("Deals 12,345.68 with Name of g");
  });

  it("fails with every unresolved reference instead of printing gaps", () => {
    expect(() =>
      guideToMarkdown(guide, { entityName: () => undefined, statValue: () => undefined }),
    ).toThrow(/gem:g.*calc:x\/CombinedDPS|calc:x\/CombinedDPS.*gem:g/s);
  });

  it("numbers citations by the order of the guide's research and reports unknown ones", () => {
    const cited = {
      ...guide,
      research: [
        {
          id: "boss-order",
          section: "playstyle",
          topic: "Boss order",
          claim: t("c"),
          source: { url: "https://example.test/", title: "T", retrievedAt: "2026-11-28T00:00:00Z" },
          entities: [],
        },
      ],
      summary: {
        ...guide.summary,
        scalingAxes: [
          { type: "text", text: "Scales." },
          { type: "source", id: "boss-order" },
        ],
      },
    } as never as PublishedGuide;
    const resolvers = { entityName: (r: { id: string }) => r.id, statValue: () => 1 };
    expect(guideToMarkdown(cited, resolvers)).toContain("Scales.[1]");
    const dangling = {
      ...cited,
      research: [],
    } as never as PublishedGuide;
    expect(() => guideToMarkdown(dangling, resolvers)).toThrow(/source:boss-order/);
  });
});
