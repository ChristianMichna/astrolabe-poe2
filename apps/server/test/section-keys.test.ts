import { describe, expect, it } from "vitest";
import {
  craftTextSectionKey,
  sectionSlug,
  slotSectionKey,
  stageSectionKey,
} from "@astrolabe/contracts/guide";
import { craftDetailKey, slotDetailKey, stageDetailKey, slotSlug } from "@astrolabe/agents";

/** The app derives section keys itself; they must be the keys the pipeline stores. */
describe("section keys", () => {
  const ids = ["Act 1", "tier-a", "Body Armour", "S8.craft-tier-a-ring", "  Odd__Id!! "];
  it("match the keys of the S9 detail pass", () => {
    for (const id of ids) {
      expect(sectionSlug(id)).toBe(slotSlug(id));
      expect(stageSectionKey(id)).toBe(stageDetailKey(id));
      expect(craftTextSectionKey(id)).toBe(craftDetailKey(id));
      for (const tier of ids) expect(slotSectionKey(tier, id)).toBe(slotDetailKey(tier, id));
    }
  });
});
