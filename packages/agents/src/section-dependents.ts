import { S5_GEMS_KEY } from "./stages/s5-target.js";
import { S6_NOTES_KEY } from "./stages/s6-progression.js";
import { S7_GEAR_PREFIX } from "./stages/s7-gear.js";
import { S8_CRAFT_PREFIX, S8_PLAN_KEY } from "./stages/s8-craft.js";
import { craftDetailKey } from "./stages/s9-detail.js";

/**
 * What a comment on a section of a finished guide sets off (validation S10 and publishing S11
 * always run again):
 * - `rewrite`: Claude writes the section again; only its own result is dropped.
 * - `remeasure`: Claude plans a crafting strategy again; the priced plans and the text about the
 *   plan go with it, so the simulator and the price feed measure it again.
 * - `rebuild`: Claude chooses again (gem setup, gear of a tier) and everything built on the choice
 *   is calculated and written again from that stage on (the engine drops by stage order).
 * Undefined for a key that is no commentable section.
 */
export type CommentEffect =
  | { effect: "rewrite" | "remeasure"; drop: readonly string[] }
  | { effect: "rebuild"; from: string };

export function commentEffect(section: string): CommentEffect | undefined {
  if (section.startsWith("S9.")) return { effect: "rewrite", drop: [section] };
  if (section.startsWith(S8_CRAFT_PREFIX)) {
    return { effect: "remeasure", drop: [section, S8_PLAN_KEY, craftDetailKey(section)] };
  }
  if (section === S5_GEMS_KEY || section === S6_NOTES_KEY || section.startsWith(S7_GEAR_PREFIX)) {
    return { effect: "rebuild", from: section };
  }
  return undefined;
}
