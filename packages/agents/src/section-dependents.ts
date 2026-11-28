import { S8_CRAFT_PREFIX, S8_PLAN_KEY } from "./stages/s8-craft.js";
import { craftDetailKey } from "./stages/s9-detail.js";

/**
 * The results to drop when the player comments on a section of a finished guide, besides the
 * validation (S10) and publishing (S11) that always run again: a written section stands alone; a
 * crafting strategy takes the priced plans and the text written about its plan with it, so the
 * simulator and the price feed measure it again. Undefined for a key that is no section.
 */
export function commentDependents(section: string): readonly string[] | undefined {
  if (section.startsWith("S9.")) return [section];
  if (section.startsWith(S8_CRAFT_PREFIX)) return [section, S8_PLAN_KEY, craftDetailKey(section)];
  return undefined;
}

/** Whether a comment on the section makes the engine measure again (not only rewrite text). */
export const recalculatesOnComment = (section: string): boolean =>
  section.startsWith(S8_CRAFT_PREFIX);
