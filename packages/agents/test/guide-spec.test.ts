import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GuideSpec, itemsFor, specRubricGaps, withGuideSpec } from "../src/guide-spec.js";
import { QualityRubric } from "../src/quality/rubric.js";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../config/agents/${name}`, import.meta.url), "utf8"));
const spec = GuideSpec.parse(read("guide-spec.json"));
const rubric = QualityRubric.parse(read("guide-rubric.json"));

describe("guide specification", () => {
  it("names only rubric rules that exist, and every rubric rule is explained by an item", () => {
    expect(specRubricGaps(spec, rubric)).toEqual({ unknown: [], unreferenced: [] });
  });

  it("reaches the real task keys: every item matches at least one key of its family", () => {
    const keys = [
      "S6.notes",
      "S7.gear-start",
      "S8.craft-start-weapon-1",
      "S9.summary",
      "S9.mechanics",
      "S9.playstyle",
      "S9.atlas",
      "S9.variants",
      "S9.faq",
      "S9.research-playstyle",
      "S9.stage-act-1",
      "S9.tier-start",
      "S9.slot-start-helmet",
      "S9.craft-start-weapon-1",
      "S10.quality-summary",
    ];
    for (const item of spec.items) {
      expect(
        keys.some((k) => itemsFor(spec, k).includes(item)),
        item.id,
      ).toBe(true);
    }
  });

  it("is registered in the stage config", () => {
    const stages = read("stages.json") as { s9: { guideSpecFile: string } };
    expect(stages.s9.guideSpecFile).toBe("guide-spec.json");
  });

  it("hands a task only the items that apply to it", () => {
    const ids = (key: string): string[] => itemsFor(spec, key).map((i) => i.id);
    expect(ids("S9.summary")).toEqual(["depth", "numbers-by-reference", "summary", "citations"]);
    expect(ids("S9.slot-start-helmet")).toContain("slot");
    expect(ids("S9.slot-start-helmet")).not.toContain("summary");
    expect(ids("S1.profile")).toEqual([]);
  });

  it("adds the measured minimums of the rubric to the instructions", () => {
    const text = withGuideSpec("Write it.", "S9.summary", spec, rubric);
    expect(text).toContain(`Guide specification (${spec.version})`);
    expect(text).toContain("at least 3 entries");
    expect(text).not.toContain("Passive tree");
    expect(withGuideSpec("Write it.", "S1.profile", spec, rubric)).toBe("Write it.");
    expect(withGuideSpec("Write it.", "S9.summary", undefined, rubric)).toBe("Write it.");
  });
});
