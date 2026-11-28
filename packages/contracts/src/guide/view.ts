import { z } from "zod";
import { CalcResult } from "../calc/result.js";
import { ReleasePath } from "../catalog/entities.js";
import { ClassificationId } from "../common/ids.js";
import { DataReleaseId } from "../common/version.js";
import { BudgetTierId } from "../build/request.js";
import { PublishedGuide } from "./document.js";

/** One modifier line of an item card; `text` is absent when the catalog has no text for it. */
export const GuideItemLine = z.object({
  modId: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  /** Generation type id of the mod (prefix, suffix …); absent for implicits and unique lines. */
  generationType: ClassificationId.optional(),
  /** Tier within the mod family (1 = best), as the catalog gives it. */
  tier: z.int().positive().optional(),
});
export type GuideItemLine = z.infer<typeof GuideItemLine>;

/**
 * An item of the gear plan as the catalog describes it: names and modifier texts come from the
 * catalog the server runs with, never from the guide text.
 */
export const GuideItemCard = z.object({
  kind: z.enum(["unique", "crafted"]),
  /** Rarity id of a crafted item as the guide gives it; absent for a unique. */
  rarityId: ClassificationId.optional(),
  /** Display name of that rarity from the release; absent when the release does not know the id. */
  rarityName: z.string().min(1).optional(),
  /** Unique item name; absent for crafted items. */
  name: z.string().min(1).optional(),
  baseName: z.string().min(1),
  /**
   * Inventory image of the item (a unique's own, else none) as a path inside the data release the
   * server runs with; the server serves it at `/api/release-assets/<icon>`. Absent when the
   * release has no image for the item; the app then shows its own slot icon.
   */
  icon: ReleasePath.optional(),
  itemClass: ClassificationId,
  implicits: z.array(GuideItemLine),
  explicits: z.array(GuideItemLine),
});
export type GuideItemCard = z.infer<typeof GuideItemCard>;

/** The items of one gear slot; `null` where the catalog does not know the item (see `unresolved`). */
export const GuideGearEntry = z.object({
  budgetTier: BudgetTierId,
  slot: z.string().min(1),
  target: GuideItemCard.nullable(),
  minimum: GuideItemCard.nullable().optional(),
  alternatives: z.array(GuideItemCard.nullable()),
});
export type GuideGearEntry = z.infer<typeof GuideGearEntry>;

/**
 * A stored guide with everything the app window needs to show it (server:
 * GET /api/guides/:guideId/view): the display names of the catalog entities it refers to and
 * the stored calculation results behind its numbers. Nothing here is made up: a name or result
 * the server does not have is listed in `unresolved` and stays absent.
 */
export const GuideView = z.object({
  guide: PublishedGuide,
  /** The data release the server (and so the catalog behind `names`) runs with. */
  catalogReleaseId: DataReleaseId,
  /**
   * The guide was built with `catalogReleaseId`. When false, no names are resolved (the same id
   * can mean something else in another release): every catalog reference is in `unresolved`
   * and the guide needs revalidation. Results carry their own release and stay.
   */
  current: z.boolean(),
  /** The gear plan's items with names and modifier texts, in the order of `guide.gear.tiers`. */
  gear: z.array(GuideGearEntry),
  /** Display names by `<kind>:<id>` of the entity (e.g. `gem:Metadata/Items/Gem/Foo`). */
  names: z.record(z.string().min(1), z.string().min(1)),
  /** Stored calculation results by calc id, for the numbers of the guide and of its stages. */
  results: z.record(z.string().min(1), CalcResult),
  /** Catalog references and calc ids the server could not resolve, as `<kind>:<id>` and `calc:<id>`. */
  unresolved: z.array(z.string().min(1)),
});
export type GuideView = z.infer<typeof GuideView>;
